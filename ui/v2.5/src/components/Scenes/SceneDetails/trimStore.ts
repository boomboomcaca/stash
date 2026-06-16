import { useEffect, useState } from "react";

// Shared "trim editing session" state so the subtitle checklist (SceneTrimPanel,
// a tab) and the timeline overlay (rendered under the main player in Scene) edit
// the same delete ranges. Scoped to one scene id at a time — switching scenes (or
// re-opening the panel) resets it.

export interface ITrimRange {
  start: number;
  end: number;
}

let curSceneId: string | null = null;
let ranges = new Map<number, ITrimRange>();
const listeners = new Set<() => void>();
const EMPTY: Map<number, ITrimRange> = new Map();

function emit() {
  // new reference so useSyncExternalStore re-renders subscribers
  ranges = new Map(ranges);
  listeners.forEach((l) => l());
}

export const trimStore = {
  // ranges for `sceneId`, or an (empty, stable) map if the store holds another scene
  for(sceneId: string): Map<number, ITrimRange> {
    return curSceneId === sceneId ? ranges : EMPTY;
  },
  has(sceneId: string, index: number): boolean {
    return curSceneId === sceneId && ranges.has(index);
  },
  setRange(sceneId: string, index: number, r: ITrimRange) {
    if (curSceneId !== sceneId) {
      curSceneId = sceneId;
      ranges = new Map();
    }
    ranges.set(index, { start: Math.max(0, r.start), end: Math.max(0, r.end) });
    emit();
  },
  remove(sceneId: string, index: number) {
    if (curSceneId !== sceneId) return;
    if (ranges.delete(index)) emit();
  },
  clear(sceneId: string) {
    curSceneId = sceneId;
    if (ranges.size) {
      ranges = new Map();
    }
    emit();
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useTrimRanges(sceneId: string): Map<number, ITrimRange> {
  const [, bump] = useState(0);
  useEffect(() => trimStore.subscribe(() => bump((n) => n + 1)), []);
  return trimStore.for(sceneId);
}
