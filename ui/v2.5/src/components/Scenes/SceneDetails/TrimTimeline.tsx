import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "react-bootstrap";
import * as GQL from "src/core/generated-graphql";
import { useSpriteInfo } from "src/hooks/sprite";

export interface ITrimRange {
  start: number;
  end: number;
}

interface ITrimTimelineProps {
  scene: GQL.SceneDataFragment;
  duration: number;
  // index -> the (editable) delete range for that subtitle cue
  ranges: Map<number, ITrimRange>;
  // subtitle cue start times to show as faint ticks for alignment
  cueTimes: number[];
  onChange: (index: number, range: ITrimRange) => void;
  onRemove: (index: number) => void;
}

type DragMode = "move" | "start" | "end";

interface IDragState {
  index: number;
  mode: DragMode;
  startX: number;
  orig: ITrimRange;
  edgeTime: number; // the time currently shown in the preview
}

const TRACK_H = 56; // thumbnail strip height (px)
const MIN_RANGE = 0.1; // s
const ZOOM_MIN = 2; // px per second (whole video fits-ish)
const ZOOM_MAX = 200;

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  const pad = (n: number, w = 2) => n.toString().padStart(w, "0");
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return `${base}.${pad(cs)}`;
}

function clampNum(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export const TrimTimeline: React.FC<ITrimTimelineProps> = ({
  scene,
  duration,
  ranges,
  cueTimes,
  onChange,
  onRemove,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const drag = useRef<IDragState | null>(null);
  const rafSeek = useRef<number | null>(null);
  const pendingSeek = useRef<number>(0);

  // default zoom: fit the whole video into ~900px
  const [pxPerSec, setPxPerSec] = useState(() =>
    duration > 0 ? clampNum(900 / duration, ZOOM_MIN, ZOOM_MAX) : 10
  );
  const [, force] = useState(0); // re-render on drag
  const [previewBox, setPreviewBox] = useState<{
    left: number;
    time: number;
    visible: boolean;
  }>({ left: 0, time: 0, visible: false });

  const trackWidth = Math.max(1, duration * pxPerSec);

  // sprite thumbnails for the strip background
  const spriteInfo = useSpriteInfo(scene.paths.vtt ?? undefined);
  const spriteStyle = useMemo(() => {
    if (!spriteInfo || spriteInfo.length === 0) return null;
    // stretch the whole sprite sheet across the track by time. We render one
    // div per sprite frame positioned by its start time.
    return spriteInfo;
  }, [spriteInfo]);

  // a direct stream the preview <video> can seek frame-accurately
  const previewSrc = scene.paths?.stream ?? undefined;

  // throttle preview <video> seeks to animation frames
  const schedulePreviewSeek = useCallback((t: number) => {
    pendingSeek.current = t;
    if (rafSeek.current != null) return;
    rafSeek.current = window.requestAnimationFrame(() => {
      rafSeek.current = null;
      const v = previewRef.current;
      if (v && isFinite(pendingSeek.current)) {
        try {
          v.currentTime = pendingSeek.current;
        } catch {
          /* ignore seek errors */
        }
      }
    });
  }, []);

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const vp = viewportRef.current;
      if (!vp) return 0;
      const rect = vp.getBoundingClientRect();
      const x = clientX - rect.left + vp.scrollLeft;
      return clampNum(x / pxPerSec, 0, duration);
    },
    [pxPerSec, duration]
  );

  const onPointerDown = useCallback(
    (e: React.MouseEvent, index: number, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      const r = ranges.get(index);
      if (!r) return;
      const edge = mode === "end" ? r.end : r.start;
      drag.current = {
        index,
        mode,
        startX: e.clientX,
        orig: { ...r },
        edgeTime: edge,
      };
      const vp = viewportRef.current;
      const rect = vp?.getBoundingClientRect();
      setPreviewBox({
        left: rect ? edge * pxPerSec - (vp?.scrollLeft ?? 0) : 0,
        time: edge,
        visible: true,
      });
      schedulePreviewSeek(edge);
    },
    [ranges, pxPerSec, schedulePreviewSeek]
  );

  useEffect(() => {
    function move(e: MouseEvent) {
      const d = drag.current;
      if (!d) return;
      const dt = (e.clientX - d.startX) / pxPerSec;
      let next: ITrimRange = { ...d.orig };
      let edge = d.edgeTime;
      if (d.mode === "start") {
        next.start = clampNum(d.orig.start + dt, 0, d.orig.end - MIN_RANGE);
        edge = next.start;
      } else if (d.mode === "end") {
        next.end = clampNum(d.orig.end + dt, d.orig.start + MIN_RANGE, duration);
        edge = next.end;
      } else {
        const len = d.orig.end - d.orig.start;
        const ns = clampNum(d.orig.start + dt, 0, duration - len);
        next = { start: ns, end: ns + len };
        edge = ns;
      }
      d.edgeTime = edge;
      onChange(d.index, next);
      schedulePreviewSeek(edge);
      const vp = viewportRef.current;
      setPreviewBox({
        left: edge * pxPerSec - (vp?.scrollLeft ?? 0),
        time: edge,
        visible: true,
      });
      force((n) => n + 1);
    }
    function up() {
      if (!drag.current) return;
      drag.current = null;
      setPreviewBox((p) => ({ ...p, visible: false }));
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [pxPerSec, duration, onChange, schedulePreviewSeek]);

  function zoom(factor: number) {
    setPxPerSec((p) => clampNum(p * factor, ZOOM_MIN, ZOOM_MAX));
  }
  function zoomFit() {
    const vp = viewportRef.current;
    const w = vp?.clientWidth ?? 900;
    setPxPerSec(clampNum((w - 8) / Math.max(1, duration), ZOOM_MIN, ZOOM_MAX));
  }

  // Ctrl+wheel to zoom
  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  const rangeList = Array.from(ranges.entries());

  return (
    <div className="trim-timeline mt-3">
      <div className="d-flex align-items-center mb-1" style={{ gap: 6 }}>
        <small className="text-muted">Timeline — drag the red bands to adjust cuts</small>
        <div className="ml-auto d-flex" style={{ gap: 4 }}>
          <Button size="sm" variant="secondary" title="Zoom out" onClick={() => zoom(1 / 1.5)}>
            −
          </Button>
          <Button size="sm" variant="secondary" title="Fit" onClick={zoomFit}>
            Fit
          </Button>
          <Button size="sm" variant="secondary" title="Zoom in" onClick={() => zoom(1.5)}>
            +
          </Button>
        </div>
      </div>

      <div
        ref={viewportRef}
        className="trim-timeline-viewport"
        onWheel={onWheel}
        style={{
          position: "relative",
          overflowX: "auto",
          overflowY: "hidden",
          border: "1px solid rgba(128,128,128,0.4)",
          borderRadius: 4,
          background: "#15171a",
        }}
      >
        <div
          className="trim-timeline-track"
          style={{ position: "relative", width: trackWidth, height: TRACK_H }}
        >
          {/* sprite thumbnail strip (coarse, for orientation) */}
          {spriteStyle?.map((sp, i) => {
            const left = sp.start * pxPerSec;
            const w = Math.max(0, (sp.end - sp.start) * pxPerSec);
            const scale = TRACK_H / sp.h;
            return (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left,
                  top: 0,
                  width: w,
                  height: TRACK_H,
                  backgroundImage: `url(${sp.url})`,
                  backgroundRepeat: "no-repeat",
                  backgroundSize: `auto ${TRACK_H}px`,
                  backgroundPosition: `${-sp.x * scale}px ${-sp.y * scale}px`,
                  opacity: 0.55,
                  borderRight: "1px solid rgba(0,0,0,0.3)",
                }}
              />
            );
          })}

          {/* subtitle cue ticks */}
          {cueTimes.map((t, i) => (
            <div
              key={`tick-${i}`}
              style={{
                position: "absolute",
                left: t * pxPerSec,
                top: 0,
                bottom: 0,
                width: 1,
                background: "rgba(120,180,255,0.35)",
                pointerEvents: "none",
              }}
            />
          ))}

          {/* delete-range bands */}
          {rangeList.map(([index, r]) => {
            const left = r.start * pxPerSec;
            const w = Math.max(2, (r.end - r.start) * pxPerSec);
            return (
              <div
                key={`band-${index}`}
                className="trim-band"
                style={{
                  position: "absolute",
                  left,
                  top: 0,
                  width: w,
                  height: TRACK_H,
                  background: "rgba(220,53,69,0.45)",
                  border: "1px solid rgba(220,53,69,0.95)",
                  boxSizing: "border-box",
                  cursor: "grab",
                }}
                onMouseDown={(e) => onPointerDown(e, index, "move")}
                title={`${fmt(r.start)} → ${fmt(r.end)}`}
              >
                {/* left handle */}
                <div
                  onMouseDown={(e) => onPointerDown(e, index, "start")}
                  style={{
                    position: "absolute",
                    left: -4,
                    top: 0,
                    width: 9,
                    height: "100%",
                    cursor: "ew-resize",
                    background: "rgba(255,255,255,0.85)",
                    borderRadius: 2,
                  }}
                />
                {/* right handle */}
                <div
                  onMouseDown={(e) => onPointerDown(e, index, "end")}
                  style={{
                    position: "absolute",
                    right: -4,
                    top: 0,
                    width: 9,
                    height: "100%",
                    cursor: "ew-resize",
                    background: "rgba(255,255,255,0.85)",
                    borderRadius: 2,
                  }}
                />
                {/* remove */}
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onRemove(index);
                  }}
                  title="Remove this cut"
                  style={{
                    position: "absolute",
                    right: 2,
                    top: 1,
                    width: 16,
                    height: 16,
                    lineHeight: "14px",
                    textAlign: "center",
                    fontSize: 12,
                    color: "#fff",
                    background: "rgba(0,0,0,0.55)",
                    borderRadius: 3,
                    cursor: "pointer",
                  }}
                >
                  ×
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* big floating frame preview shown while dragging */}
      <div
        className="trim-timeline-preview"
        style={{
          position: "relative",
          height: previewBox.visible ? "auto" : 0,
          overflow: "hidden",
          transition: "height 0.1s",
        }}
      >
        {previewSrc && (
          <div
            style={{
              display: previewBox.visible ? "inline-block" : "none",
              marginTop: 6,
              border: "2px solid rgba(220,53,69,0.95)",
              borderRadius: 4,
              background: "#000",
              position: "relative",
            }}
          >
            <video
              ref={previewRef}
              src={previewSrc}
              muted
              preload="auto"
              playsInline
              style={{ display: "block", width: 480, height: 270, objectFit: "contain" }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                bottom: 0,
                background: "rgba(0,0,0,0.7)",
                color: "#fff",
                fontVariantNumeric: "tabular-nums",
                padding: "1px 6px",
                fontSize: 13,
              }}
            >
              {fmt(previewBox.time)}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default TrimTimeline;
