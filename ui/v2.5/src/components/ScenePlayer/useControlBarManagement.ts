import { useCallback, useEffect, useRef } from "react";
import { VideoJsPlayer } from "video.js";
import { IEnhancedSubtitleNavigation } from "./types";

interface IUseControlBarManagementProps {
  getPlayer: () => VideoJsPlayer | null;
  showEnhancedSubtitles: boolean;
  showEnhancedSubtitlesRef: React.MutableRefObject<boolean>;
  subtitleCues: Array<{ startTime: number; endTime: number; text: string }>;
  currentSubtitleIndex: number;
  controlBarVisibleRef: React.MutableRefObject<boolean>;
  temporarilyUnlockControlBarRef: React.MutableRefObject<(() => void) | null>;
  hideControlBarRef: React.MutableRefObject<(() => void) | null>;
  enhancedSubtitleNavigationRef: React.MutableRefObject<IEnhancedSubtitleNavigation | null>;
}

export function useControlBarManagement({
  getPlayer,
  showEnhancedSubtitles,
  showEnhancedSubtitlesRef,
  subtitleCues,
  currentSubtitleIndex,
  controlBarVisibleRef,
  temporarilyUnlockControlBarRef,
  hideControlBarRef,
  enhancedSubtitleNavigationRef,
}: IUseControlBarManagementProps) {
  const unlockTimerRef = useRef<number | null>(null);
  const originalReportUserActivityRef = useRef<
    ((event?: Event) => void) | null
  >(null);

  const clearUnlockTimer = () => {
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = null;
    }
  };

  const setControlBarLock = (playerEl: HTMLElement, locked: boolean) => {
    playerEl.classList.toggle("vjs-controls-locked-hidden", locked);
    playerEl.classList.toggle("vjs-controls-unlocked-once", !locked);
  };

  const temporarilyUnlockControlBar = useCallback(() => {
    const player = getPlayer();
    const playerEl = player?.el() as HTMLElement | undefined;
    if (!player || !playerEl) return;

    clearUnlockTimer();
    controlBarVisibleRef.current = true;

    if (!showEnhancedSubtitlesRef.current) return;

    setControlBarLock(playerEl, false);
    player.reportUserActivity(new Event("useractive"));
    player.userActive(true);

    unlockTimerRef.current = window.setTimeout(() => {
      controlBarVisibleRef.current = false;
      if (showEnhancedSubtitlesRef.current && playerEl) {
        player.userActive(false);
        setControlBarLock(playerEl, true);
      }
      unlockTimerRef.current = null;
    }, 3000);
  }, [getPlayer, showEnhancedSubtitlesRef, controlBarVisibleRef]);

  const hideControlBar = useCallback(() => {
    const player = getPlayer();
    const playerEl = player?.el() as HTMLElement | undefined;
    if (!player || !playerEl) return;

    clearUnlockTimer();
    controlBarVisibleRef.current = false;
    player.userActive(false);

    if (showEnhancedSubtitlesRef.current) {
      setControlBarLock(playerEl, true);
    }
  }, [getPlayer, showEnhancedSubtitlesRef, controlBarVisibleRef]);

  useEffect(() => {
    temporarilyUnlockControlBarRef.current = temporarilyUnlockControlBar;
    hideControlBarRef.current = hideControlBar;
  }, [
    temporarilyUnlockControlBar,
    hideControlBar,
    temporarilyUnlockControlBarRef,
    hideControlBarRef,
  ]);

  // 控制栏锁定逻辑：当增强字幕开启时，锁定隐藏控制栏
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    if (showEnhancedSubtitles) {
      // 禁用Video.js的用户活跃检测
      player.userActive(false);

      // 修改Video.js的用户活跃检测机制
      // 允许键盘事件触发用户活跃，但保持控制栏锁定
      // 保存原始的 reportUserActivity 方法（如果还没有保存）
      if (!originalReportUserActivityRef.current) {
        originalReportUserActivityRef.current = player.reportUserActivity;
      }
      const originalReportUserActivity = originalReportUserActivityRef.current;

      if (!originalReportUserActivity) {
        return;
      }

      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      player.reportUserActivity = function (this: typeof player, event?: any) {
        const el = player.el();

        // 如果是键盘事件，允许报告用户活跃（这样Video.js可以处理键盘事件）
        if (event && event.type === "keydown") {
          return originalReportUserActivity.call(this, event);
        }

        // 对于其他事件（如鼠标移动、点击等），在锁定期间不报告用户活跃
        // 除非是临时解锁状态
        if (el && !el.classList.contains("vjs-controls-unlocked-once")) {
          return;
        }

        return originalReportUserActivity.call(this, event);
      };

      const playerEl = player.el() as HTMLElement & {
        _focusLossHandler?: () => void;
      };
      if (playerEl) {
        playerEl.classList.add("vjs-controls-locked-hidden");
        playerEl.setAttribute("tabindex", "0");
        playerEl.focus();

        const handleFocusLoss = () => {
          setTimeout(() => {
            if (playerEl?.classList.contains("vjs-controls-locked-hidden")) {
              playerEl.focus();
            }
          }, 100);
        };

        playerEl.addEventListener("blur", handleFocusLoss);
        playerEl._focusLossHandler = handleFocusLoss;
      }

      // 清理函数：恢复原始方法
      return () => {
        if (originalReportUserActivityRef.current) {
          player.reportUserActivity = originalReportUserActivityRef.current;
        }

        // 清理焦点管理
        const el = player.el() as HTMLElement & {
          _focusLossHandler?: () => void;
        };
        if (el && el._focusLossHandler) {
          el.removeEventListener("blur", el._focusLossHandler);
          delete el._focusLossHandler;
        }
      };
    } else {
      if (originalReportUserActivityRef.current) {
        player.reportUserActivity = originalReportUserActivityRef.current;
        originalReportUserActivityRef.current = null;
      }

      clearUnlockTimer();

      const playerEl = player.el() as HTMLElement & {
        _focusLossHandler?: () => void;
      };
      if (playerEl) {
        playerEl.classList.remove(
          "vjs-controls-locked-hidden",
          "vjs-controls-unlocked-once"
        );

        if (playerEl._focusLossHandler) {
          playerEl.removeEventListener("blur", playerEl._focusLossHandler);
          delete playerEl._focusLossHandler;
        }
      }
    }
  }, [getPlayer, showEnhancedSubtitles]);

  // 同步所有状态到移动触摸控件
  useEffect(() => {
    const player = getPlayer();
    const touchPlugin = player?._mobileTouchControlsPlugin;
    if (!touchPlugin) return;

    touchPlugin.setEnhancedSubtitlesEnabled?.(showEnhancedSubtitles);
    touchPlugin.setSubtitleCues?.(subtitleCues);
    touchPlugin.setGetCurrentSubtitleIndex?.(() => currentSubtitleIndex);
    touchPlugin.setShowControlBar?.(temporarilyUnlockControlBar);
  }, [
    getPlayer,
    showEnhancedSubtitles,
    subtitleCues,
    currentSubtitleIndex,
    temporarilyUnlockControlBar,
  ]);

  // 传递单词导航回调到移动触摸控件
  // 回调函数每次调用时都从 ref 中读取最新值，避免闭包捕获旧状态
  useEffect(() => {
    if (!showEnhancedSubtitles) return;

    const setupWordNavigation = () => {
      const player = getPlayer();
      const touchPlugin = player?._mobileTouchControlsPlugin;

      if (touchPlugin && enhancedSubtitleNavigationRef.current) {
        // 注意：回调函数内部每次调用时都读取 ref.current，确保获取最新状态
        touchPlugin.setWordNavigationCallbacks?.({
          navigateToNextWord: () =>
            enhancedSubtitleNavigationRef.current?.navigateToNextWord?.(),
          navigateToPreviousWord: () =>
            enhancedSubtitleNavigationRef.current?.navigateToPreviousWord?.(),
          enterWordNavigationMode: (selectLastWord?: boolean) =>
            enhancedSubtitleNavigationRef.current?.enterWordNavigationMode?.(
              selectLastWord ?? false
            ),
          exitWordNavigationMode: () =>
            enhancedSubtitleNavigationRef.current?.exitWordNavigationMode?.(),
          handleWordSelection: async () =>
            enhancedSubtitleNavigationRef.current?.handleWordSelection?.(),
          isInWordNavigationMode: () =>
            enhancedSubtitleNavigationRef.current?.isInWordNavigationMode ??
            false,
        });
        return true;
      }
      return false;
    };

    // 立即尝试设置
    if (setupWordNavigation()) return;

    // 使用 interval 持续重试，直到成功或超时
    let retryCount = 0;
    const maxRetries = 10;
    const retryInterval = setInterval(() => {
      retryCount++;
      if (setupWordNavigation() || retryCount >= maxRetries) {
        clearInterval(retryInterval);
      }
    }, 200);

    return () => clearInterval(retryInterval);
  }, [
    showEnhancedSubtitles,
    getPlayer,
    enhancedSubtitleNavigationRef,
    subtitleCues,
  ]);

  return {
    temporarilyUnlockControlBar,
    hideControlBar,
  };
}
