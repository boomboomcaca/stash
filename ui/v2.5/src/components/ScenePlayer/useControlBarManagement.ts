import { useCallback, useEffect, useRef } from "react";
import { VideoJsPlayer } from "video.js";

interface UseControlBarManagementProps {
  getPlayer: () => VideoJsPlayer | null;
  showEnhancedSubtitles: boolean;
  showEnhancedSubtitlesRef: React.MutableRefObject<boolean>;
  subtitleCues: Array<{ startTime: number; endTime: number; text: string }>;
  currentSubtitleIndex: number;
  controlBarVisibleRef: React.MutableRefObject<boolean>;
  temporarilyUnlockControlBarRef: React.MutableRefObject<(() => void) | null>;
  hideControlBarRef: React.MutableRefObject<(() => void) | null>;
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
}: UseControlBarManagementProps) {
  const unlockTimerRef = useRef<number | null>(null);
  const originalReportUserActivityRef = useRef<((event?: Event) => void) | null>(null);

  const clearUnlockTimer = () => {
    if (unlockTimerRef.current) {
      clearTimeout(unlockTimerRef.current);
      unlockTimerRef.current = null;
    }
  };

  const setControlBarLock = (playerEl: HTMLElement, locked: boolean) => {
    playerEl.classList.toggle('vjs-controls-locked-hidden', locked);
    playerEl.classList.toggle('vjs-controls-unlocked-once', !locked);
  };

  const temporarilyUnlockControlBar = useCallback(() => {
    const player = getPlayer();
    const playerEl = player?.el();
    if (!player || !playerEl) return;

    clearUnlockTimer();
    controlBarVisibleRef.current = true;
    
    if (!showEnhancedSubtitlesRef.current) return;
    
    setControlBarLock(playerEl, false);
    player.reportUserActivity(new Event('useractive'));
    player.userActive(true);
    
    unlockTimerRef.current = window.setTimeout(() => {
      controlBarVisibleRef.current = false;
      if (showEnhancedSubtitlesRef.current && playerEl) {
        player.userActive(false);
        setControlBarLock(playerEl, true);
      }
      unlockTimerRef.current = null;
    }, 3000);
  }, [getPlayer, showEnhancedSubtitlesRef]);

  const hideControlBar = useCallback(() => {
    const player = getPlayer();
    const playerEl = player?.el();
    if (!player || !playerEl) return;

    clearUnlockTimer();
    controlBarVisibleRef.current = false;
    player.userActive(false);
    
    if (showEnhancedSubtitlesRef.current) {
      setControlBarLock(playerEl, true);
    }
  }, [getPlayer, showEnhancedSubtitlesRef]);

  useEffect(() => {
    temporarilyUnlockControlBarRef.current = temporarilyUnlockControlBar;
    hideControlBarRef.current = hideControlBar;
  }, [temporarilyUnlockControlBar, hideControlBar]);

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
      
      player.reportUserActivity = function(this: typeof player, event?: any) {
        const playerEl = player.el();
        
        // 如果是键盘事件，允许报告用户活跃（这样Video.js可以处理键盘事件）
        if (event && event.type === 'keydown') {
          return originalReportUserActivity.call(this, event);
        }
        
        // 对于其他事件（如鼠标移动、点击等），在锁定期间不报告用户活跃
        // 除非是临时解锁状态
        if (playerEl && !playerEl.classList.contains('vjs-controls-unlocked-once')) {
          return;
        }
        
        return originalReportUserActivity.call(this, event);
      };
      
      const playerEl = player.el();
      if (playerEl) {
        playerEl.classList.add('vjs-controls-locked-hidden');
        playerEl.setAttribute('tabindex', '0');
        (playerEl as HTMLElement).focus();
        
        const handleFocusLoss = () => {
          setTimeout(() => {
            if (playerEl?.classList.contains('vjs-controls-locked-hidden')) {
              (playerEl as HTMLElement).focus();
            }
          }, 100);
        };
        
        playerEl.addEventListener('blur', handleFocusLoss);
        (playerEl as any)._focusLossHandler = handleFocusLoss;
      }
      
      // 清理函数：恢复原始方法
      return () => {
        if (originalReportUserActivityRef.current) {
          player.reportUserActivity = originalReportUserActivityRef.current;
        }
        
        // 清理焦点管理
        const playerEl = player.el();
        if (playerEl && (playerEl as any)._focusLossHandler) {
          playerEl.removeEventListener('blur', (playerEl as any)._focusLossHandler);
          delete (playerEl as any)._focusLossHandler;
        }
      };
    } else {
      if (originalReportUserActivityRef.current) {
        player.reportUserActivity = originalReportUserActivityRef.current;
        originalReportUserActivityRef.current = null;
      }
      
      clearUnlockTimer();
      
      const playerEl = player.el();
      if (playerEl) {
        playerEl.classList.remove('vjs-controls-locked-hidden', 'vjs-controls-unlocked-once');
        
        if ((playerEl as any)._focusLossHandler) {
          playerEl.removeEventListener('blur', (playerEl as any)._focusLossHandler);
          delete (playerEl as any)._focusLossHandler;
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
  }, [getPlayer, showEnhancedSubtitles, subtitleCues, currentSubtitleIndex, temporarilyUnlockControlBar]);

  return {
    temporarilyUnlockControlBar,
    hideControlBar,
  };
}

