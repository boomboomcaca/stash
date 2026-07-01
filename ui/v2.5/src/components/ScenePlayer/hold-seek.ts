import { VideoJsPlayer } from "video.js";

// Hold-to-seek: holding Left/Right (or A/D) ramps into variable-speed
// fast-forward / rewind instead of firing many 10s jumps per second.
//
//  - A single tap (!event.repeat) still seeks ±10s — handled by the caller.
//  - Holding the key (event.repeat) enters this module and ramps the speed up
//    through RATES (2× → 4× → … → 20×) the longer it is held:
//      · Forward  → native playbackRate (smooth, keeps audio, and does NOT
//        trigger a transcode reload). Browsers cap playbackRate (~16×) and a
//        live transcode may not encode fast enough to sustain high rates, so
//        the *effective* forward speed can be lower than requested.
//      · Backward → the browser can't play at a negative rate, so we step
//        currentTime backwards. Each step is a seek (expensive on transcoded
//        sources), so the actual video frame is refreshed at a THROTTLED rate
//        while a requestAnimationFrame loop keeps the on-screen time/OSD moving
//        smoothly. Rewind is inherently a simulated scrub, not true playback.
//  - Releasing the key (keyup), losing focus, or ~idleMs with no further
//    repeat event (a dropped keyup) all restore the pre-hold rate and
//    play/pause state.

interface HoldSeekState {
  dir: 1 | -1;
  savedRate: number;
  wasPaused: boolean;
  level: number; // index into RATES
  virtualTime: number; // continuous playhead used to drive smooth rewind
  lastSeekTs: number; // performance.now() of the last real rewind seek
  lastFrameTs: number; // performance.now() of the last rAF tick
  rampTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  raf?: number;
  osd?: HTMLElement;
}

const RATES = [2, 4, 8, 16, 20]; // speed steps, ramps up while held
const rampMs = 800; // time held before stepping up a gear
// Rewind refreshes the actual video frame at most this often. Higher = fewer
// transcode reloads / less stutter, at the cost of choppier frames. The OSD and
// on-screen time still move smoothly every animation frame regardless.
const rewindSeekIntervalMs = 200;
// If no further auto-repeat keydown arrives within this window we assume the
// key was released but the keyup was lost, and stop. Auto-repeat fires every
// ~30-50ms, so this only trips on a genuine release.
const idleMs = 500;

const states = new WeakMap<VideoJsPlayer, HoldSeekState>();

function formatTime(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function scheduleRamp(player: VideoJsPlayer, state: HoldSeekState) {
  state.rampTimer = setTimeout(() => {
    if (state.level < RATES.length - 1) {
      state.level++;
      if (state.dir === 1) {
        player.playbackRate(RATES[state.level]);
      }
      scheduleRamp(player, state);
    }
  }, rampMs);
}

function armIdleWatchdog(player: VideoJsPlayer, state: HoldSeekState) {
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => stopHoldSeek(player), idleMs);
}

function tick(player: VideoJsPlayer, state: HoldSeekState, ts: number) {
  const dt = (ts - state.lastFrameTs) / 1000;
  state.lastFrameTs = ts;
  const rate = RATES[state.level];

  if (state.dir === -1) {
    // advance the virtual playhead every frame (smooth), but only commit an
    // actual seek at the throttled interval to avoid a reload storm.
    state.virtualTime -= rate * dt;
    if (state.virtualTime <= 0) {
      state.virtualTime = 0;
      player.currentTime(0);
      stopHoldSeek(player);
      return;
    }
    if (ts - state.lastSeekTs >= rewindSeekIntervalMs) {
      player.currentTime(state.virtualTime);
      state.lastSeekTs = ts;
    }
  } else {
    // forward playback advances currentTime natively; just mirror it
    state.virtualTime = player.currentTime();
    if (player.ended()) {
      stopHoldSeek(player);
      return;
    }
  }

  updateOsd(state);
  state.raf = requestAnimationFrame((t) => tick(player, state, t));
}

function startHoldSeek(player: VideoJsPlayer, dir: 1 | -1) {
  const now = performance.now();
  const state: HoldSeekState = {
    dir,
    savedRate: player.playbackRate(),
    wasPaused: player.paused(),
    level: 0,
    virtualTime: player.currentTime(),
    lastSeekTs: now,
    lastFrameTs: now,
  };
  states.set(player, state);

  if (dir === 1) {
    if (player.paused()) player.play()?.catch(() => {});
    player.playbackRate(RATES[0]);
  } else {
    // pause native playback; the rewind loop drives currentTime instead
    player.pause();
  }

  scheduleRamp(player, state);
  armIdleWatchdog(player, state);
  showOsd(player, state);
  state.raf = requestAnimationFrame((t) => tick(player, state, t));
}

// Called from handleHotkeys on a repeated Left/Right keydown.
export function holdSeekKeydown(player: VideoJsPlayer, dir: 1 | -1) {
  const cur = states.get(player);
  if (cur) {
    if (cur.dir === dir) {
      armIdleWatchdog(player, cur); // still held — refresh the watchdog
      return;
    }
    stopHoldSeek(player); // direction reversed mid-hold — restart
  }
  startHoldSeek(player, dir);
}

// Called on keyup / blur / dispose. Restores rate and play state.
export function stopHoldSeek(player: VideoJsPlayer) {
  const state = states.get(player);
  if (!state) return;
  states.delete(player);

  if (state.rampTimer) clearTimeout(state.rampTimer);
  if (state.idleTimer) clearTimeout(state.idleTimer);
  if (state.raf !== undefined) cancelAnimationFrame(state.raf);

  // land on the exact virtual position (the throttled seek may lag behind)
  if (state.dir === -1) {
    player.currentTime(state.virtualTime > 0 ? state.virtualTime : 0);
  }

  player.playbackRate(state.savedRate);
  if (state.wasPaused) {
    player.pause();
  } else {
    player.play()?.catch(() => {});
  }

  hideOsd(state);
}

export function holdSeekKeyup(player: VideoJsPlayer, e: KeyboardEvent) {
  if (!states.get(player)) return;
  switch (e.which) {
    case 37: // left
    case 39: // right
    case 65: // a
    case 68: // d
      stopHoldSeek(player);
      break;
  }
}

function showOsd(player: VideoJsPlayer, state: HoldSeekState) {
  const el = document.createElement("div");
  el.className = "vjs-hold-seek-osd";
  el.setAttribute("aria-hidden", "true");
  state.osd = el;
  updateOsd(state);
  player.el().appendChild(el);
}

function updateOsd(state: HoldSeekState) {
  if (!state.osd) return;
  const arrow = state.dir === 1 ? "»»" : "««";
  state.osd.textContent = `${arrow} ${RATES[state.level]}×  ${formatTime(
    state.virtualTime
  )}`;
}

function hideOsd(state: HoldSeekState) {
  state.osd?.remove();
  state.osd = undefined;
}
