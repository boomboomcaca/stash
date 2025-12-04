import videojs from "video.js";

export const VIDEO_PLAYER_ID = "VideoJsPlayer";

export const getPlayer = () => videojs.getPlayer(VIDEO_PLAYER_ID);

export const getPlayerPosition = () => getPlayer()?.currentTime();

// 伪全屏工具函数
const PSEUDO_FULLSCREEN_CLASS = "vjs-pseudo-fullscreen";
let pseudoFullscreenState = false;
let pseudoFullscreenListeners: Array<(isFullscreen: boolean) => void> = [];

export function isPseudoFullscreen(): boolean {
  return pseudoFullscreenState;
}

export function enterPseudoFullscreen(player: videojs.Player): void {
  if (pseudoFullscreenState) return;

  const playerEl = player.el();
  if (!playerEl) return;

  pseudoFullscreenState = true;
  playerEl.classList.add(PSEUDO_FULLSCREEN_CLASS);
  document.body.classList.add(PSEUDO_FULLSCREEN_CLASS);

  // 触发全屏事件
  pseudoFullscreenListeners.forEach((listener) => listener(true));
  player.trigger("fullscreenchange");
}

export function exitPseudoFullscreen(player: videojs.Player): void {
  if (!pseudoFullscreenState) return;

  const playerEl = player.el();
  if (!playerEl) return;

  pseudoFullscreenState = false;
  playerEl.classList.remove(PSEUDO_FULLSCREEN_CLASS);
  document.body.classList.remove(PSEUDO_FULLSCREEN_CLASS);

  // 触发全屏事件
  pseudoFullscreenListeners.forEach((listener) => listener(false));
  player.trigger("fullscreenchange");
}

export function togglePseudoFullscreen(player: videojs.Player): void {
  if (pseudoFullscreenState) {
    exitPseudoFullscreen(player);
  } else {
    enterPseudoFullscreen(player);
  }
}

export function addPseudoFullscreenListener(
  listener: (isFullscreen: boolean) => void
): () => void {
  pseudoFullscreenListeners.push(listener);
  return () => {
    pseudoFullscreenListeners = pseudoFullscreenListeners.filter(
      (l) => l !== listener
    );
  };
}
