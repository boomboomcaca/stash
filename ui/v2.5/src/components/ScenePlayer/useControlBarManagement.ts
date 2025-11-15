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

  // 临时解锁控制栏的函数（由AP图标双击调用）
  const temporarilyUnlockControlBar = useCallback(() => {
    const player = getPlayer();
    if (!player) {
      return;
    }

    const playerEl = player.el();
    if (playerEl) {
      // 清除之前的计时器（如果有）
      if (unlockTimerRef.current) {
        clearTimeout(unlockTimerRef.current);
      }
      
      // 设置控制栏可见标记
      controlBarVisibleRef.current = true;
      
      // 如果增强字幕没有开启，完全依赖Video.js的正常用户活跃机制
      if (!showEnhancedSubtitlesRef.current) {
        // 直接返回，让Video.js按照原生机制处理用户活跃状态和控制栏显示
        // Video.js会自动检测到用户活动（左右方向键），显示控制栏并在inactivityTimeout后自动隐藏
        return;
      }
      
      // 增强字幕开启时的特殊处理
      // 添加临时解锁类（先添加后移除锁定类，确保临时解锁优先级更高）
      playerEl.classList.add('vjs-controls-unlocked-once');
      playerEl.classList.remove('vjs-controls-locked-hidden');
      
      // 强制触发用户活跃状态，这会让Video.js显示控制栏
      // 由于我们修改了reportUserActivity，这里会因为有vjs-controls-unlocked-once类而正常工作
      if ((player as any).reportUserActivity) {
        (player as any).reportUserActivity(new Event('useractive'));
      }
      player.userActive(true);
      
      // 3秒后自动隐藏并重新锁定
      unlockTimerRef.current = window.setTimeout(() => {
        // 清除控制栏可见标记
        controlBarVisibleRef.current = false;
        
        // 只有在增强字幕仍然开启时才重新锁定
        if (!showEnhancedSubtitlesRef.current || !playerEl) {
          unlockTimerRef.current = null;
          return;
        }
        
        // 先强制设置为不活跃
        player.userActive(false);
        
        // 然后重新添加锁定类并移除解锁类
        playerEl.classList.remove('vjs-controls-unlocked-once');
        playerEl.classList.add('vjs-controls-locked-hidden');
        
        unlockTimerRef.current = null;
      }, 3000);
    }
  }, [getPlayer, showEnhancedSubtitlesRef]);

  // 隐藏控制栏的函数
  const hideControlBar = useCallback(() => {
    const player = getPlayer();
    if (!player) {
      return;
    }

    const playerEl = player.el();
    if (playerEl) {
      // 清除之前的计时器（如果有）
      if (unlockTimerRef.current) {
        clearTimeout(unlockTimerRef.current);
        unlockTimerRef.current = null;
      }
      
      // 清除控制栏可见标记
      controlBarVisibleRef.current = false;
      
      // 先强制设置为不活跃
      player.userActive(false);
      
      // 如果增强字幕开启，重新添加锁定类并移除解锁类
      if (showEnhancedSubtitlesRef.current) {
        playerEl.classList.remove('vjs-controls-unlocked-once');
        playerEl.classList.add('vjs-controls-locked-hidden');
      }
    }
  }, [getPlayer, showEnhancedSubtitlesRef]);

  // 保持 ref 与函数同步，确保 hotkeys 始终调用最新的函数
  useEffect(() => {
    temporarilyUnlockControlBarRef.current = temporarilyUnlockControlBar;
  }, [temporarilyUnlockControlBar]);
  
  useEffect(() => {
    hideControlBarRef.current = hideControlBar;
  }, [hideControlBar]);

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
        originalReportUserActivityRef.current = (player as any).reportUserActivity;
      }
      const originalReportUserActivity = originalReportUserActivityRef.current;
      
      if (!originalReportUserActivity) {
        return;
      }
      
      (player as any).reportUserActivity = function(this: typeof player, event?: Event) {
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
      
      // 添加自定义类来强制隐藏控制栏
      const playerEl = player.el();
      if (playerEl) {
        playerEl.classList.add('vjs-controls-locked-hidden');
        
        // 确保播放器能够接收键盘事件
        // 设置tabindex使播放器可以获得焦点
        playerEl.setAttribute('tabindex', '0');
        
        // 确保播放器有焦点，这样键盘事件才能被处理
        (playerEl as HTMLElement).focus();
        
        // 监听焦点丢失事件，重新获得焦点
        const handleFocusLoss = () => {
          // 延迟一点时间再重新获得焦点，避免与其他元素冲突
          setTimeout(() => {
            if (playerEl && playerEl.classList.contains('vjs-controls-locked-hidden')) {
              (playerEl as HTMLElement).focus();
            }
          }, 100);
        };
        
        playerEl.addEventListener('blur', handleFocusLoss);
        
        // 存储清理函数
        (playerEl as any)._focusLossHandler = handleFocusLoss;
      }
      
      
      // 清理函数：恢复原始方法
      return () => {
        if (originalReportUserActivityRef.current) {
          (player as any).reportUserActivity = originalReportUserActivityRef.current;
        }
        
        // 清理焦点管理
        const playerEl = player.el();
        if (playerEl && (playerEl as any)._focusLossHandler) {
          playerEl.removeEventListener('blur', (playerEl as any)._focusLossHandler);
          delete (playerEl as any)._focusLossHandler;
        }
      };
    } else {
      // 增强字幕关闭时，解除锁定
      
      // 恢复原始的 reportUserActivity 方法
      if (originalReportUserActivityRef.current) {
        (player as any).reportUserActivity = originalReportUserActivityRef.current;
        originalReportUserActivityRef.current = null;
      }
      
      // 清除临时解锁计时器（如果有）
      if (unlockTimerRef.current) {
        clearTimeout(unlockTimerRef.current);
        unlockTimerRef.current = null;
      }
      
      // 移除自定义类
      const playerEl = player.el();
      if (playerEl) {
        playerEl.classList.remove('vjs-controls-locked-hidden');
        playerEl.classList.remove('vjs-controls-unlocked-once');
        
        // 清理焦点管理
        if ((playerEl as any)._focusLossHandler) {
          playerEl.removeEventListener('blur', (playerEl as any)._focusLossHandler);
          delete (playerEl as any)._focusLossHandler;
        }
      }
      
      // 不主动触发 userActive，让 Video.js 按照正常的用户交互来处理控制栏显示和隐藏
      // 这样可以确保 inactivityTimeout 机制正常工作
      
    }
  }, [getPlayer, showEnhancedSubtitles]);

  // 同步增强字幕状态到移动触摸控件
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;
    
    const touchPlugin = (player as any)._mobileTouchControlsPlugin;
    if (touchPlugin && typeof touchPlugin.setEnhancedSubtitlesEnabled === 'function') {
      touchPlugin.setEnhancedSubtitlesEnabled(showEnhancedSubtitles);
    }
  }, [getPlayer, showEnhancedSubtitles]);

  // 同步字幕列表到移动触摸控件
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;
    
    const touchPlugin = (player as any)._mobileTouchControlsPlugin;
    if (touchPlugin && typeof touchPlugin.setSubtitleCues === 'function') {
      touchPlugin.setSubtitleCues(subtitleCues);
    }
  }, [getPlayer, subtitleCues]);

  // 同步当前字幕索引获取函数到移动触摸控件
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;
    
    const touchPlugin = (player as any)._mobileTouchControlsPlugin;
    if (touchPlugin && typeof touchPlugin.setGetCurrentSubtitleIndex === 'function') {
      touchPlugin.setGetCurrentSubtitleIndex(() => currentSubtitleIndex);
    }
  }, [getPlayer, currentSubtitleIndex]);

  // 同步显示控制栏函数到移动触摸控件
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;
    
    const touchPlugin = (player as any)._mobileTouchControlsPlugin;
    if (touchPlugin && typeof touchPlugin.setShowControlBar === 'function') {
      touchPlugin.setShowControlBar(temporarilyUnlockControlBar);
    }
  }, [getPlayer, temporarilyUnlockControlBar]);

  return {
    temporarilyUnlockControlBar,
    hideControlBar,
  };
}

