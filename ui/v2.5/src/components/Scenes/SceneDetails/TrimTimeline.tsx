import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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

interface IPanState {
  startX: number;
  startScroll: number;
  downTime: number;
  moved: boolean;
}

const TRACK_H = 60;
const MIN_RANGE = 0.1;
const ZOOM_MIN = 2;
const ZOOM_MAX = 600;
const PAN_THRESHOLD = 4; // px of background drag before it pans (vs. click-to-seek)

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
  if (hi < lo) return lo; // tolerate inverted bounds (e.g. range longer than video)
  return v < lo ? lo : v > hi ? hi : v;
}

export const TrimTimeline: React.FC<ITrimTimelineProps> = ({ scene }) => {
  const sceneId = scene.id;
  const duration = scene.files?.[0]?.duration ?? 0;
  const fps = scene.files?.[0]?.frame_rate ?? 0;
  const frameStep = fps > 0 ? 1 / fps : 0.04;
  const ranges = useTrimRanges(sceneId);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [vpEl, setVpEl] = useState<HTMLDivElement | null>(null);
  const drag = useRef<IDragState | null>(null);
  const pan = useRef<IPanState | null>(null);
  const rafSeek = useRef<number | null>(null);
  const pendingSeek = useRef<number>(0);
  const zoomAnchor = useRef<{ time: number; offset: number } | null>(null);

  const [pxPerSec, setPxPerSec] = useState(() =>
    duration > 0 ? clampNum(960 / duration, ZOOM_MIN, ZOOM_MAX) : 10
  );
  const [selected, setSelected] = useState<number | null>(null);
  const [tip, setTip] = useState<{ time: number; show: boolean }>({
    time: 0,
    show: false,
  });

  const trackWidth = Math.max(1, duration * pxPerSec);
  const spriteInfo = useSpriteInfo(scene.paths.vtt ?? undefined);
  const previewSrc = scene.paths?.stream ?? undefined;

  // latest values for the once-registered keyboard / wheel handlers
  const live = useRef({ ranges, selected, pxPerSec, duration, frameStep, sceneId });
  live.current = { ranges, selected, pxPerSec, duration, frameStep, sceneId };

  // seek the MAIN player to the exact frame, throttled to animation frames
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

  // callback ref: keep the lazily-read viewportRef AND a state copy so effects
  // that capture the element (the native wheel listener) re-run once it mounts.
  const setViewport = useCallback((el: HTMLDivElement | null) => {
    viewportRef.current = el;
    setVpEl(el);
  }, []);

  const timeAtClientX = useCallback(
    (clientX: number) => {
      const vp = viewportRef.current;
      if (!vp) return 0;
      const rect = vp.getBoundingClientRect();
      return clampNum(
        (clientX - rect.left + vp.scrollLeft) / pxPerSec,
        0,
        duration
      );
    },
    [pxPerSec, duration]
  );

  // mousedown on a band (or its handles): select + begin a drag
  const onBandDown = useCallback(
    (e: React.MouseEvent, index: number, mode: DragMode) => {
      e.preventDefault();
      e.stopPropagation();
      const r = ranges.get(index);
      if (!r) return;
      setSelected(index);
      const edge = mode === "end" ? r.end : r.start;
      drag.current = {
        index,
        mode,
        startX: e.clientX,
        orig: { ...r },
        edgeTime: edge,
      };
      try {
        getPlayer()?.pause();
      } catch {
        /* ignore */
      }
      setTip({ time: edge, show: true });
      schedulePlayerSeek(edge);
    },
    [ranges, schedulePlayerSeek]
  );

  // mousedown on empty track: begin a pan (becomes a seek if it never moves)
  const onBackgroundDown = useCallback(
    (e: React.MouseEvent) => {
      const vp = viewportRef.current;
      if (!vp) return;
      pan.current = {
        startX: e.clientX,
        startScroll: vp.scrollLeft,
        downTime: timeAtClientX(e.clientX),
        moved: false,
      };
    },
    [timeAtClientX]
  );

  // window move/up: drives both band drag and background pan
  useEffect(() => {
    function move(e: MouseEvent) {
      const d = drag.current;
      if (d) {
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
        setTip({ time: edge, show: true });
        return;
      }
      const p = pan.current;
      if (p) {
        const dx = e.clientX - p.startX;
        if (Math.abs(dx) > PAN_THRESHOLD) p.moved = true;
        const vp = viewportRef.current;
        if (vp) vp.scrollLeft = p.startScroll - dx;
      }
    }
    function up() {
      if (drag.current) {
        drag.current = null;
        setTip((s) => ({ ...s, show: false }));
        return;
      }
      const p = pan.current;
      if (p) {
        pan.current = null;
        if (!p.moved) {
          try {
            getPlayer()?.currentTime(p.downTime);
          } catch {
            /* ignore */
          }
        }
      }
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [pxPerSec, duration, sceneId, schedulePlayerSeek]);

  // keyboard fine-tune of the selected band (registered once; reads live refs)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const L = live.current;
      if (L.selected == null) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Escape") {
        setSelected(null);
        setTip((s) => ({ ...s, show: false }));
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const r = L.ranges.get(L.selected);
      if (!r) return;
      e.preventDefault();
      const step = (e.key === "ArrowLeft" ? -1 : 1) * L.frameStep;
      let next: ITrimRange = { ...r };
      let edge = r.start;
      if (e.shiftKey) {
        next.end = clampNum(r.end + step, r.start + MIN_RANGE, L.duration);
        edge = next.end;
      } else if (e.altKey) {
        next.start = clampNum(r.start + step, 0, r.end - MIN_RANGE);
        edge = next.start;
      } else {
        const len = r.end - r.start;
        const ns = clampNum(r.start + step, 0, L.duration - len);
        next = { start: ns, end: ns + len };
        edge = ns;
      }
      trimStore.setRange(L.sceneId, L.selected, next);
      schedulePlayerSeek(edge);
      setTip({ time: edge, show: true });
      try {
        getPlayer()?.pause();
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [schedulePlayerSeek]);

  // reconcile selection: if the selected range was removed (here, the panel, or
  // post-trim clear), drop the stale selection so a re-added cue isn't silently
  // pre-selected and absorbing arrow-key nudges.
  useEffect(() => {
    if (selected != null && !ranges.has(selected)) {
      setSelected(null);
      setTip((s) => ({ ...s, show: false }));
    }
  }, [ranges, selected]);

  // keep the anchored time fixed when the zoom level changes
  useLayoutEffect(() => {
    const a = zoomAnchor.current;
    const vp = viewportRef.current;
    if (a && vp) {
      vp.scrollLeft = a.time * pxPerSec - a.offset;
      zoomAnchor.current = null;
    }
  }, [pxPerSec]);

  const applyZoom = useCallback((next: number, anchorClientX?: number) => {
    const vp = viewportRef.current;
    const curPx = live.current.pxPerSec;
    if (vp) {
      const rect = vp.getBoundingClientRect();
      const offset =
        anchorClientX != null ? anchorClientX - rect.left : vp.clientWidth / 2;
      zoomAnchor.current = { time: (vp.scrollLeft + offset) / curPx, offset };
    }
    setPxPerSec(clampNum(next, ZOOM_MIN, ZOOM_MAX));
  }, []);

  function zoom(factor: number) {
    applyZoom(pxPerSec * factor);
  }
  function zoomFit() {
    const w = viewportRef.current?.clientWidth ?? 960;
    zoomAnchor.current = { time: 0, offset: 0 };
    setPxPerSec(clampNum((w - 8) / Math.max(1, duration), ZOOM_MIN, ZOOM_MAX));
  }

  // native wheel listener (passive:false so ctrl-zoom / horizontal-scroll can
  // preventDefault). Keyed on vpEl so it (re)attaches when the track mounts.
  useEffect(() => {
    const vp = vpEl;
    if (!vp) return;
    function onWheel(e: WheelEvent) {
      if (e.ctrlKey) {
        e.preventDefault();
        applyZoom(
          live.current.pxPerSec * (e.deltaY < 0 ? 1.15 : 1 / 1.15),
          e.clientX
        );
        return;
      }
      // scroll the timeline horizontally; honour the larger axis (trackpads
      // emit horizontal swipes as deltaX with deltaY ~ 0)
      const d =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (d !== 0 && vp!.scrollWidth > vp!.clientWidth) {
        e.preventDefault();
        vp!.scrollLeft += d;
      }
    }
    vp.addEventListener("wheel", onWheel, { passive: false });
    return () => vp.removeEventListener("wheel", onWheel);
  }, [applyZoom, vpEl]);

  if (ranges.size === 0 || duration <= 0) return null;

  // sprite tiles live in one multi-row sheet image; backgroundSize must be the
  // WHOLE sheet (scaled to the track height) or every non-first tile crops wrong.
  const spriteScale =
    spriteInfo && spriteInfo.length ? TRACK_H / spriteInfo[0].h : 1;
  let sheetW = 0;
  let sheetH = 0;
  if (spriteInfo) {
    for (const s of spriteInfo) {
      sheetW = Math.max(sheetW, (s.x + s.w) * spriteScale);
      sheetH = Math.max(sheetH, (s.y + s.h) * spriteScale);
    }
  }

  const list = Array.from(ranges.entries());

  return (
    <div className="trim-timeline" style={{ background: "#0e1013", padding: "4px 6px 6px" }}>
      <div className="d-flex align-items-center mb-1" style={{ gap: 6 }}>
        <small className="text-muted">
          拖空白处平移 · 点选红带后 ←/→ 逐帧微调（Shift 右边界 / Alt 左边界）· Ctrl+滚轮缩放
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
        ref={setViewport}
        onMouseDown={onBackgroundDown}
        style={{
          position: "relative",
          overflowX: "auto",
          overflowY: "hidden",
          border: "1px solid rgba(128,128,128,0.4)",
          borderRadius: 4,
          background: "#15171a",
          cursor: "grab",
        }}
      >
        <div style={{ position: "relative", width: trackWidth, height: TRACK_H }}>
          {/* sprite thumbnail strip for orientation */}
          {spriteInfo?.map((sp, i) => {
            const left = sp.start * pxPerSec;
            const w = Math.max(0, (sp.end - sp.start) * pxPerSec);
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
                  backgroundSize: `${sheetW}px ${sheetH}px`,
                  backgroundPosition: `${-sp.x * spriteScale}px ${
                    -sp.y * spriteScale
                  }px`,
                  opacity: 0.5,
                  pointerEvents: "none",
                }}
              />
            );
          })}

          {/* delete-range bands */}
          {list.map(([index, r]) => {
            const left = r.start * pxPerSec;
            const w = Math.max(2, (r.end - r.start) * pxPerSec);
            const isSel = index === selected;
            return (
              <div
                key={`band-${index}`}
                style={{
                  position: "absolute",
                  left,
                  top: 0,
                  width: w,
                  height: TRACK_H,
                  background: isSel ? "rgba(220,53,69,0.6)" : "rgba(220,53,69,0.45)",
                  border: isSel
                    ? "2px solid #ffd24a"
                    : "1px solid rgba(220,53,69,0.95)",
                  boxShadow: isSel ? "0 0 0 2px rgba(255,210,74,0.45)" : undefined,
                  boxSizing: "border-box",
                  cursor: "grab",
                  zIndex: isSel ? 2 : 1,
                }}
                onMouseDown={(e) => onBandDown(e, index, "move")}
                title={`${fmt(r.start)} → ${fmt(r.end)}`}
              >
                <div
                  onMouseDown={(e) => onBandDown(e, index, "start")}
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
                  onMouseDown={(e) => onBandDown(e, index, "end")}
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
                    if (selected === index) setSelected(null);
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
