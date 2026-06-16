import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "react-bootstrap";
import * as GQL from "src/core/generated-graphql";
import { useSpriteInfo } from "src/hooks/sprite";
import { getPlayer } from "src/components/ScenePlayer/util";
import { trimStore, useTrimRanges, ITrimRange } from "./trimStore";

interface ITrimTimelineProps {
  scene: GQL.SceneDataFragment;
}

type DragMode = "move" | "start" | "end";

interface IDragState {
  index: number;
  mode: DragMode;
  startX: number;
  orig: ITrimRange;
  edgeTime: number;
}

const TRACK_H = 60;
const MIN_RANGE = 0.1;
const ZOOM_MIN = 2;
const ZOOM_MAX = 300;

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t % 1) * 100);
  const pad = (n: number) => n.toString().padStart(2, "0");
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return `${base}.${pad(cs)}`;
}

function clampNum(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

export const TrimTimeline: React.FC<ITrimTimelineProps> = ({ scene }) => {
  const sceneId = scene.id;
  const duration = scene.files?.[0]?.duration ?? 0;
  const ranges = useTrimRanges(sceneId);

  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<IDragState | null>(null);
  const rafSeek = useRef<number | null>(null);
  const pendingSeek = useRef<number>(0);

  const [pxPerSec, setPxPerSec] = useState(() =>
    duration > 0 ? clampNum(960 / duration, ZOOM_MIN, ZOOM_MAX) : 10
  );
  const [tip, setTip] = useState<{ left: number; time: number; show: boolean }>({
    left: 0,
    time: 0,
    show: false,
  });

  const trackWidth = Math.max(1, duration * pxPerSec);
  const spriteInfo = useSpriteInfo(scene.paths.vtt ?? undefined);
  const previewSrc = scene.paths?.stream ?? undefined;

  // seek the MAIN player to show the exact frame, throttled to animation frames
  const schedulePlayerSeek = useCallback((t: number) => {
    pendingSeek.current = t;
    if (rafSeek.current != null) return;
    rafSeek.current = window.requestAnimationFrame(() => {
      rafSeek.current = null;
      try {
        getPlayer()?.currentTime(pendingSeek.current);
      } catch {
        /* ignore seek errors */
      }
    });
  }, []);

  const onPointerDown = useCallback(
    (e: React.MouseEvent, index: number, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      const r = ranges.get(index);
      if (!r) return;
      const edge = mode === "end" ? r.end : r.start;
      drag.current = { index, mode, startX: e.clientX, orig: { ...r }, edgeTime: edge };
      try {
        getPlayer()?.pause();
      } catch {
        /* ignore */
      }
      const vp = viewportRef.current;
      setTip({ left: edge * pxPerSec - (vp?.scrollLeft ?? 0), time: edge, show: true });
      schedulePlayerSeek(edge);
    },
    [ranges, pxPerSec, schedulePlayerSeek]
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
      trimStore.setRange(sceneId, d.index, next);
      schedulePlayerSeek(edge);
      const vp = viewportRef.current;
      setTip({ left: edge * pxPerSec - (vp?.scrollLeft ?? 0), time: edge, show: true });
    }
    function up() {
      if (!drag.current) return;
      drag.current = null;
      setTip((p) => ({ ...p, show: false }));
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [pxPerSec, duration, sceneId, schedulePlayerSeek]);

  function zoom(factor: number) {
    setPxPerSec((p) => clampNum(p * factor, ZOOM_MIN, ZOOM_MAX));
  }
  function zoomFit() {
    const w = viewportRef.current?.clientWidth ?? 960;
    setPxPerSec(clampNum((w - 8) / Math.max(1, duration), ZOOM_MIN, ZOOM_MAX));
  }
  function onWheel(e: React.WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }

  // clicking empty track seeks the player there
  function onTrackClick(e: React.MouseEvent) {
    if (drag.current) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const t = clampNum((e.clientX - rect.left + vp.scrollLeft) / pxPerSec, 0, duration);
    try {
      getPlayer()?.currentTime(t);
    } catch {
      /* ignore */
    }
  }

  if (ranges.size === 0 || duration <= 0) return null;

  const list = Array.from(ranges.entries());

  return (
    <div className="trim-timeline" style={{ background: "#0e1013", padding: "4px 6px 6px" }}>
      <div className="d-flex align-items-center mb-1" style={{ gap: 6 }}>
        <small className="text-muted">
          Trim — drag the red bands on the timeline (the video scrubs to the cut frame)
        </small>
        <div className="ml-auto d-flex align-items-center" style={{ gap: 4 }}>
          {tip.show && (
            <span
              className="text-light mr-2"
              style={{ fontVariantNumeric: "tabular-nums", fontSize: 13 }}
            >
              {fmt(tip.time)}
            </span>
          )}
          <Button size="sm" variant="secondary" title="Zoom out" onClick={() => zoom(1 / 1.5)}>
            −
          </Button>
          <Button size="sm" variant="secondary" title="Fit whole video" onClick={zoomFit}>
            Fit
          </Button>
          <Button size="sm" variant="secondary" title="Zoom in (or Ctrl+wheel)" onClick={() => zoom(1.5)}>
            +
          </Button>
        </div>
      </div>

      <div
        ref={viewportRef}
        onWheel={onWheel}
        onClick={onTrackClick}
        style={{
          position: "relative",
          overflowX: "auto",
          overflowY: "hidden",
          border: "1px solid rgba(128,128,128,0.4)",
          borderRadius: 4,
          background: "#15171a",
        }}
      >
        <div style={{ position: "relative", width: trackWidth, height: TRACK_H }}>
          {/* sprite thumbnail strip for orientation */}
          {spriteInfo?.map((sp, i) => {
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
                  opacity: 0.5,
                }}
              />
            );
          })}

          {/* delete-range bands */}
          {list.map(([index, r]) => {
            const left = r.start * pxPerSec;
            const w = Math.max(2, (r.end - r.start) * pxPerSec);
            return (
              <div
                key={`band-${index}`}
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
                <div
                  onMouseDown={(e) => onPointerDown(e, index, "start")}
                  style={{
                    position: "absolute",
                    left: -4,
                    top: 0,
                    width: 9,
                    height: "100%",
                    cursor: "ew-resize",
                    background: "rgba(255,255,255,0.9)",
                  }}
                />
                <div
                  onMouseDown={(e) => onPointerDown(e, index, "end")}
                  style={{
                    position: "absolute",
                    right: -4,
                    top: 0,
                    width: 9,
                    height: "100%",
                    cursor: "ew-resize",
                    background: "rgba(255,255,255,0.9)",
                  }}
                />
                <div
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    trimStore.remove(sceneId, index);
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
                    background: "rgba(0,0,0,0.6)",
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
      {/* hidden preload so the player can seek quickly */}
      {previewSrc && (
        <video src={previewSrc} preload="metadata" muted style={{ display: "none" }} />
      )}
    </div>
  );
};

export default TrimTimeline;
