import React, { useEffect, useMemo, useState } from "react";
import { Button, Form } from "react-bootstrap";
import * as GQL from "src/core/generated-graphql";
import { useToast } from "src/hooks/Toast";

interface ISceneTrimPanelProps {
  scene: GQL.SceneDataFragment;
}

interface ICue {
  index: number;
  start: number;
  end: number;
  text: string;
}

// Mirrors ScenePlayer/useSceneLoading buildCaptionTrackSrc: scene.paths.caption
// may already carry a signed-URL query, so pick the correct separator rather
// than always appending "?".
function buildCaptionTrackSrc(
  base: string | null | undefined,
  lang: string,
  type: string
): string {
  const b = base ?? "";
  const sep = b.includes("?") ? "&" : "?";
  return `${b}${sep}lang=${encodeURIComponent(lang)}&type=${encodeURIComponent(
    type
  )}`;
}

// parseTimestamp handles both SRT (HH:MM:SS,mmm) and VTT (HH:MM:SS.mmm), and the
// optional-hours short form (MM:SS.mmm).
function parseTimestamp(s: string): number {
  const m = s
    .trim()
    .replace(",", ".")
    .match(/(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseFloat(m[3]);
  return h * 3600 + min * 60 + sec;
}

// parseSubtitles parses SRT/VTT into time-ordered cues. It ignores headers,
// indices and styling blocks by keying off the "-->" timing line.
function parseSubtitles(text: string): ICue[] {
  const cues: ICue[] = [];
  const body = text.replace(/^﻿/, "");
  const blocks = body.split(/\r?\n\r?\n/);
  let index = 0;
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim() !== "");
    const tlIdx = lines.findIndex((l) => l.includes("-->"));
    if (tlIdx < 0) continue;
    const [startStr, endStr] = lines[tlIdx].split("-->");
    const start = parseTimestamp(startStr);
    const end = parseTimestamp(endStr);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    // strip a leading speaker tag (e.g. "[Speaker 0]: ") for display only;
    // deletion is purely time-based so this is cosmetic.
    const txt = lines
      .slice(tlIdx + 1)
      .join(" ")
      .trim()
      .replace(/^\[[^\]]*\]:\s*/, "");
    cues.push({ index: index++, start, end, text: txt });
  }
  return cues;
}

function fmtTime(t: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export const SceneTrimPanel: React.FC<ISceneTrimPanelProps> = ({ scene }) => {
  const Toast = useToast();
  const [sceneTrim, { loading: submitting }] = GQL.useSceneTrimMutation();

  const captions = useMemo(() => scene.captions ?? [], [scene.captions]);
  const captionBase = scene.paths?.caption;

  const [captionIdx, setCaptionIdx] = useState(0);
  const [cues, setCues] = useState<ICue[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loadingCues, setLoadingCues] = useState(false);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const caption = captions[captionIdx];
    if (!caption || !captionBase) {
      setCues([]);
      return;
    }

    let cancelled = false;
    setLoadingCues(true);
    setError(null);
    setSelected(new Set());

    const url = buildCaptionTrackSrc(
      captionBase,
      caption.language_code,
      caption.caption_type
    );

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((text) => {
        if (cancelled) return;
        setCues(parseSubtitles(text));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setCues([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCues(false);
      });

    return () => {
      cancelled = true;
    };
  }, [captionBase, captionIdx, captions]);

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  const selectedCount = selected.size;
  const totalDeleteSeconds = useMemo(
    () =>
      cues
        .filter((c) => selected.has(c.index))
        .reduce((acc, c) => acc + (c.end - c.start), 0),
    [cues, selected]
  );

  async function onTrim() {
    const ranges = cues
      .filter((c) => selected.has(c.index))
      .map((c) => ({ start: c.start, end: c.end }));
    if (ranges.length === 0) return;
    try {
      await sceneTrim({
        variables: { id: scene.id, deleteRanges: ranges, replace },
      });
      Toast.success(
        `Trim job started: removing ${ranges.length} segment(s)${
          replace ? " (replacing original)" : " (new .trimmed.mp4)"
        }`
      );
      setSelected(new Set());
    } catch (e) {
      Toast.error(e);
    }
  }

  return (
    <div className="container scene-trim-panel">
      <h5>Trim by Subtitle</h5>
      <p className="text-muted">
        Tick the subtitle lines to <strong>remove</strong> from the video. The
        remaining parts are joined into a new <code>.trimmed.mp4</code> and the
        captions are re-timed to match. Run this before dubbing so nothing needs
        re-aligning.
      </p>

      {captions.length === 0 && (
        <div className="text-warning">
          This scene has no captions yet — generate subtitles first.
        </div>
      )}

      {captions.length > 1 && (
        <Form.Group controlId="scene-trim-caption">
          <Form.Label>Caption track</Form.Label>
          <Form.Control
            as="select"
            value={captionIdx}
            onChange={(e) =>
              setCaptionIdx(parseInt(e.currentTarget.value, 10))
            }
          >
            {captions.map((c, i) => (
              <option key={`${c.language_code}-${c.caption_type}`} value={i}>
                {c.language_code} ({c.caption_type})
              </option>
            ))}
          </Form.Control>
        </Form.Group>
      )}

      {error && (
        <div className="text-danger">Failed to load captions: {error}</div>
      )}
      {loadingCues && <div>Loading subtitles…</div>}

      {cues.length > 0 && (
        <>
          <div className="d-flex justify-content-between align-items-center mb-2">
            <span>
              {selectedCount} / {cues.length} selected
              {selectedCount > 0 &&
                ` · ${fmtTime(totalDeleteSeconds)} to remove`}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setSelected(new Set())}
              disabled={selectedCount === 0}
            >
              Clear
            </Button>
          </div>

          <div
            className="scene-trim-cues"
            style={{
              maxHeight: "50vh",
              overflowY: "auto",
              border: "1px solid rgba(128,128,128,0.4)",
              borderRadius: 4,
            }}
          >
            {cues.map((c) => (
              <label
                key={c.index}
                className="d-flex align-items-start p-1 mb-0"
                style={{
                  cursor: "pointer",
                  background: selected.has(c.index)
                    ? "rgba(220,53,69,0.25)"
                    : "transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(c.index)}
                  onChange={() => toggle(c.index)}
                  className="mr-2 mt-1"
                />
                <span
                  className="text-muted mr-2"
                  style={{
                    minWidth: "5.5em",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {fmtTime(c.start)}
                </span>
                <span>{c.text}</span>
              </label>
            ))}
          </div>

          <Form.Check
            type="checkbox"
            id="scene-trim-replace"
            className="mt-3"
            label="Replace the original file (otherwise write a new .trimmed.mp4)"
            checked={replace}
            onChange={(e) => setReplace(e.currentTarget.checked)}
          />

          <Button
            variant="danger"
            className="mt-2"
            disabled={selectedCount === 0 || submitting}
            onClick={onTrim}
          >
            {submitting
              ? "Starting…"
              : `Trim — remove ${selectedCount} segment${
                  selectedCount === 1 ? "" : "s"
                }`}
          </Button>
        </>
      )}
    </div>
  );
};

export default SceneTrimPanel;
