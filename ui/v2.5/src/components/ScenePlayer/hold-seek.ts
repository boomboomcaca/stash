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
//      · Backward → the browser can't play at a negative rate, so we seek the
//        playhead backwards (fastSeek to the nearest keyframe when the timeline
//        is aligned; throttled precise seeks on offset transcodes). Rewind is a
//        simulated scrub, not true playback.
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
}

const RATES = [2, 4, 8, 16, 20]; // speed steps, ramps up while held
const rampMs = 800; // time held before stepping up a gear
// Rewind can't use playbackRate, so it seeks the playhead backwards. Seeking
// within already-buffered data — the common case when rewinding over content
// just watched (direct play keeps it all; VHS/transcode keep a window) — is
// cheap, so we refresh nearly every frame for smooth motion. Seeking OUTSIDE
// the buffer is expensive (re-fetch / transcode restart), so we throttle there
// to avoid a reload storm and the stutter it causes.
const bufferedSeekIntervalMs = 33; // ~30fps within buffered data (smooth)
const uncachedSeekIntervalMs = 200; // throttled outside the buffer (avoid reloads)
// If no further auto-repeat keydown arrives within this window we assume the
// key was released but the keyup was lost, and stop. Auto-repeat fires every
// ~30-50ms, so this only trips on a genuine release.
const idleMs = 500;

const states = new WeakMap<VideoJsPlayer, HoldSeekState>();

function getVideoEl(player: VideoJsPlayer): HTMLVideoElement | null {
  return player.el()?.querySelector("video") ?? null;
}

// True if time t (absolute playhead seconds) falls inside a buffered range,
// i.e. seeking there is cheap and won't trigger a re-fetch / transcode restart.
function isBuffered(player: VideoJsPlayer, t: number): boolean {
  try {
    const b = player.buffered();
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) && t <= b.end(i)) return true;
    }
  } catch {
    // buffered() can throw on a torn-down tech; treat as not buffered
  }
  return false;
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
    const video = getVideoEl(player);
    // When the native timeline matches the player timeline (direct play or an
    // adaptive HLS/DASH source — NOT an offset transcode, where they differ by
    // offsetStart), drive the native element directly.
    const aligned =
      !!video && Math.abs(video.currentTime - player.currentTime()) < 0.5;

    if (aligned && typeof video.fastSeek === "function") {
      // fastSeek jumps to the nearest keyframe — cheap, ideal for rewind — and
      // bypasses the offset middleware and the React timeupdate churn, so frames
      // refresh far more smoothly than precise per-frame seeks.
      video.fastSeek(state.virtualTime);
    } else {
      // Offset transcode source: go through the offset-aware player.currentTime
      // and throttle seeks outside the buffer to avoid transcode reload storms.
      const minInterval = isBuffered(player, state.virtualTime)
        ? bufferedSeekIntervalMs
        : uncachedSeekIntervalMs;
      if (ts - state.lastSeekTs >= minInterval) {
        player.currentTime(state.virtualTime);
        state.lastSeekTs = ts;
      }
    }
  } else {
    // forward playback advances currentTime natively; stop at the end
    if (player.ended()) {
      stopHoldSeek(player);
      return;
    }
  }

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
