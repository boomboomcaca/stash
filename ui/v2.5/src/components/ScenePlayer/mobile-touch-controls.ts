import videojs, { VideoJsPlayer } from "video.js";

interface TouchControlState {
  isLongPress: boolean;
  longPressTimer: number | null;
  lastTapTime: number;
  lastTapPosition: { x: number; y: number };
  doubleTapTimer: number | null;
  originalPlaybackRate: number;
  
  // 拖拽进度相关状态
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  dragStartTime: number;
  dragCurrentProgress: number;
}

class MobileTouchControlsPlugin extends videojs.getPlugin("plugin") {
  private state: TouchControlState = {
    isLongPress: false,
    longPressTimer: null,
    lastTapTime: 0,
    lastTapPosition: { x: 0, y: 0 },
    doubleTapTimer: null,
    originalPlaybackRate: 1,
    
    // 拖拽进度相关状态初始化
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartTime: 0,
    dragCurrentProgress: 0,
  };

  // 绑定的事件处理函数引用，用于正确移除事件监听器
  private boundTouchStart: ((event: TouchEvent) => void) | null = null;
  private boundTouchEnd: ((event: TouchEvent) => void) | null = null;
  private boundTouchMove: ((event: TouchEvent) => void) | null = null;
  
  // 全局事件监听器引用，用于正确移除
  private boundOrientationChange: (() => void) | null = null;
  private boundResize: (() => void) | null = null;
  
  // 防抖计时器
  private resizeTimer: number | null = null;

  private readonly LONG_PRESS_DURATION = 500; // 长按触发时间（毫秒）
  private readonly DOUBLE_TAP_DURATION = 300; // 双击检测时间（毫秒）
  private readonly DOUBLE_TAP_DISTANCE = 50; // 双击检测距离（像素）
  private readonly FAST_FORWARD_RATE = 20; // 快进倍速
  private readonly SEEK_STEP = 10; // 快进/快退步长（秒）
  
  // 拖拽进度相关常量
  private readonly DRAG_THRESHOLD = 15; // 开始拖拽的最小距离（像素）
  private readonly MAX_VERTICAL_DRAG = 100; // 拖拽时允许的最大垂直偏移（像素）

  constructor(player: VideoJsPlayer) {
    super(player);

    console.log("[MobileTouchControls] 插件初始化");

    // 只在移动设备横屏模式下启用
    if (this.shouldEnableTouchControls()) {
      console.log("[MobileTouchControls] 满足启用条件，初始化触摸控制");
      this.initializeTouchControls();
    } else {
      console.log("[MobileTouchControls] 不满足启用条件，跳过初始化");
    }

    // 绑定并监听屏幕方向变化
    this.boundOrientationChange = () => {
      console.log("[MobileTouchControls] 屏幕方向变化事件");
      // 立即重置播放速度
      this.resetPlaybackRate();
      
      // 延迟检查触摸控制状态，确保屏幕尺寸已更新
      setTimeout(() => {
        this.updateTouchControlsState();
      }, 150);
    };
    window.addEventListener("orientationchange", this.boundOrientationChange);

    // 绑定并监听窗口大小变化（处理某些浏览器的方向变化）
    this.boundResize = () => {
      // 使用防抖处理resize事件
      if (this.resizeTimer) {
        clearTimeout(this.resizeTimer);
      }
      
      this.resizeTimer = setTimeout(() => {
        this.updateTouchControlsState();
      }, 100);
    };
    window.addEventListener("resize", this.boundResize);
  }

  private shouldEnableTouchControls(): boolean {
    // 检查是否为移动设备且处于横屏模式
    const isMobile = window.matchMedia("(max-width: 1199px)").matches;
    const isLandscape = window.matchMedia("(orientation: landscape)").matches;
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    
    // 更精确的横屏检测：检查屏幕宽高比
    const isLandscapeByRatio = window.innerWidth > window.innerHeight;
    
    // 只有在移动设备、触摸设备、且处于横屏模式时才启用触摸控制
    return isMobile && isTouch && (isLandscape || isLandscapeByRatio);
  }

  private updateTouchControlsState(): void {
    // 检查当前触摸控制状态
    const shouldEnable = this.shouldEnableTouchControls();
    const isCurrentlyEnabled = this.boundTouchStart !== null;
    
    console.log("[MobileTouchControls] updateTouchControlsState:", {
      shouldEnable,
      isCurrentlyEnabled,
      orientation: window.screen?.orientation?.type || "unknown",
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight
    });
    
    if (shouldEnable && !isCurrentlyEnabled) {
      // 需要启用但当前未启用 - 初始化触摸控制
      console.log("[MobileTouchControls] 启用触摸控制");
      this.initializeTouchControls();
    } else if (!shouldEnable && isCurrentlyEnabled) {
      // 需要禁用但当前已启用 - 移除触摸控制
      console.log("[MobileTouchControls] 禁用触摸控制");
      this.removeTouchControls();
    } else {
      console.log("[MobileTouchControls] 触摸控制状态无需改变");
    }
  }

  private initializeTouchControls(): void {
    const videoEl = this.player.el().querySelector("video");
    if (!videoEl) {
      console.warn("[MobileTouchControls] Video element not found");
      return;
    }

    console.log("[MobileTouchControls] 初始化触摸控制");

    // 移除现有的事件监听器
    this.removeTouchControls();

    // 绑定事件处理函数并保存引用
    this.boundTouchStart = this.handleTouchStart.bind(this);
    this.boundTouchEnd = this.handleTouchEnd.bind(this);
    this.boundTouchMove = this.handleTouchMove.bind(this);

    // 添加触摸事件监听器
    videoEl.addEventListener("touchstart", this.boundTouchStart, { passive: false });
    videoEl.addEventListener("touchend", this.boundTouchEnd, { passive: false });
    videoEl.addEventListener("touchmove", this.boundTouchMove, { passive: false });

    console.log("[MobileTouchControls] 触摸事件监听器已添加");

    // 添加样式
    this.addTouchControlStyles();
  }

  private removeTouchControls(): void {
    const videoEl = this.player.el().querySelector("video");
    if (!videoEl) {
      console.warn("[MobileTouchControls] Video element not found during removal");
      return;
    }

    // 只有在已绑定的情况下才输出日志和移除事件监听器
    if (this.boundTouchStart || this.boundTouchEnd || this.boundTouchMove) {
      console.log("[MobileTouchControls] 移除触摸事件监听器");
    }

    // 使用绑定后的函数引用来移除事件监听器
    if (this.boundTouchStart) {
      videoEl.removeEventListener("touchstart", this.boundTouchStart);
    }
    if (this.boundTouchEnd) {
      videoEl.removeEventListener("touchend", this.boundTouchEnd);
    }
    if (this.boundTouchMove) {
      videoEl.removeEventListener("touchmove", this.boundTouchMove);
    }

    // 清理所有计时器
    if (this.state.longPressTimer) {
      clearTimeout(this.state.longPressTimer);
      this.state.longPressTimer = null;
    }
    
    if (this.state.doubleTapTimer) {
      clearTimeout(this.state.doubleTapTimer);
      this.state.doubleTapTimer = null;
    }

    // 无论长按状态如何，都恢复原始播放速度
    // 这确保在屏幕旋转时播放速度被正确重置
    if (this.state.originalPlaybackRate !== undefined) {
      this.player.playbackRate(this.state.originalPlaybackRate);
      this.state.isLongPress = false;
    }

    // 清除函数引用
    this.boundTouchStart = null;
    this.boundTouchEnd = null;
    this.boundTouchMove = null;

    // 重置触摸控制状态
    this.state.isLongPress = false;
    this.state.lastTapTime = 0;
    this.state.doubleTapTimer = null;
    this.state.longPressTimer = null;
    
    // 重置拖拽状态
    if (this.state.isDragging) {
      this.resetVisualFeedback();
      this.state.isDragging = false;
    }
    this.state.dragStartX = 0;
    this.state.dragStartY = 0;
    this.state.dragStartTime = 0;
    this.state.dragCurrentProgress = 0;
  }

  private handleTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    // 记录触摸位置
    this.state.lastTapPosition = { x, y };
    
    // 记录拖拽起始位置和时间
    this.state.dragStartX = x;
    this.state.dragStartY = y;
    this.state.dragStartTime = this.player.currentTime() || 0;
    this.state.isDragging = false;
    this.state.dragCurrentProgress = 0;

    // 重置长按状态
    this.state.isLongPress = false;

    // 开始长按计时器
    this.state.longPressTimer = window.setTimeout(() => {
      // 只有在没有进入拖拽模式时才触发长按
      if (!this.state.isDragging) {
        this.handleLongPress(x, y);
      }
    }, this.LONG_PRESS_DURATION);

    // 阻止默认行为，避免触发video.js的默认触摸控制
    event.preventDefault();
  }

  private handleTouchEnd(event: TouchEvent): void {
    if (event.changedTouches.length !== 1) return;

    const touch = event.changedTouches[0];
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    // 清除长按计时器
    if (this.state.longPressTimer) {
      clearTimeout(this.state.longPressTimer);
      this.state.longPressTimer = null;
    }

    // 如果是拖拽结束，跳转到对应进度位置
    if (this.state.isDragging) {
      this.handleDragEnd();
      event.preventDefault();
      return;
    }

    // 如果是长按结束，恢复播放速度
    if (this.state.isLongPress) {
      this.player.playbackRate(this.state.originalPlaybackRate);
      this.state.isLongPress = false;
      event.preventDefault();
      return;
    }

    // 检测单击和双击
    const now = Date.now();
    const timeSinceLastTap = now - this.state.lastTapTime;
    const distance = Math.sqrt(
      Math.pow(x - this.state.lastTapPosition.x, 2) + 
      Math.pow(y - this.state.lastTapPosition.y, 2)
    );

    if (timeSinceLastTap < this.DOUBLE_TAP_DURATION && distance < this.DOUBLE_TAP_DISTANCE) {
      // 双击 - 清除可能存在的单击延时计时器
      if (this.state.doubleTapTimer) {
        clearTimeout(this.state.doubleTapTimer);
        this.state.doubleTapTimer = null;
      }
      this.handleDoubleTap(x, y);
      this.state.lastTapTime = 0; // 重置，避免连续双击
    } else {
      // 可能是单击 - 延迟执行以等待可能的双击
      this.state.lastTapTime = now;
      this.state.lastTapPosition = { x, y };
      
      // 清除之前的单击计时器
      if (this.state.doubleTapTimer) {
        clearTimeout(this.state.doubleTapTimer);
      }
      
      // 延迟执行单击操作，等待可能的双击
      this.state.doubleTapTimer = window.setTimeout(() => {
        this.handleSingleTap(x, y);
        this.state.doubleTapTimer = null;
      }, this.DOUBLE_TAP_DURATION);
    }

    event.preventDefault();
  }

  private handleTouchMove(event: TouchEvent): void {
    if (event.touches.length !== 1) return;
    
    const touch = event.touches[0];
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;
    
    const deltaX = x - this.state.dragStartX;
    const deltaY = y - this.state.dragStartY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    
    // 检测是否开始拖拽
    if (!this.state.isDragging && distance > this.DRAG_THRESHOLD) {
      const horizontalDistance = Math.abs(deltaX);
      const verticalDistance = Math.abs(deltaY);
      
      // 如果水平移动距离大于垂直移动距离，且垂直偏移不太大，则进入拖拽模式
      if (horizontalDistance > verticalDistance && verticalDistance < this.MAX_VERTICAL_DRAG) {
        this.state.isDragging = true;
        
        // 取消长按计时器
        if (this.state.longPressTimer) {
          clearTimeout(this.state.longPressTimer);
          this.state.longPressTimer = null;
        }
        
        // 进入拖拽模式（已移除视觉指示器）
        
        console.log("[MobileTouchControls] 开始拖拽进度模式");
      }
    }
    
    // 如果已经在拖拽模式，更新进度
    if (this.state.isDragging) {
      this.updateDragProgress(deltaX, rect.width);
      event.preventDefault();
      return;
    }
    
    // 如果移动距离过大，取消长按
    if (this.state.longPressTimer && distance > 20) {
      clearTimeout(this.state.longPressTimer);
      this.state.longPressTimer = null;
    }
  }

  private handleSingleTap(x: number, y: number): void {
    // 单击切换播放/暂停
    try {
      if (this.player.paused()) {
        this.player.play()?.catch((error) => {
          console.warn("播放失败:", error);
        });
      } else {
        this.player.pause();
      }
    } catch (error) {
      console.warn("单击操作失败:", error);
    }
  }

  private handleDoubleTap(x: number, y: number): void {
    const playerEl = this.player.el() as HTMLElement;
    const videoWidth = playerEl?.offsetWidth || 0;
    const isLeftSide = x < videoWidth / 2;

    if (isLeftSide) {
      // 左侧双击：后退10秒
      this.seekRelative(-this.SEEK_STEP);
    } else {
      // 右侧双击：前进10秒
      this.seekRelative(this.SEEK_STEP);
    }
  }

  private handleLongPress(x: number, y: number): void {
    // 长按：20倍速播放
    try {
      this.state.originalPlaybackRate = this.player.playbackRate() || 1;
      this.player.playbackRate(this.FAST_FORWARD_RATE);
      this.state.isLongPress = true;
      
      // 确保视频在播放状态
      if (this.player.paused()) {
        this.player.play()?.catch((error) => {
          console.warn("长按播放失败:", error);
        });
      }
    } catch (error) {
      console.warn("长按操作失败:", error);
    }
  }

  private seekRelative(seconds: number): void {
    const currentTime = this.player.currentTime() || 0;
    const duration = this.player.duration() || 0;
    const newTime = Math.max(0, Math.min(currentTime + seconds, duration));
    this.player.currentTime(newTime);
  }

  private updateDragProgress(deltaX: number, videoWidth: number): void {
    const duration = this.player.duration() || 0;
    if (duration === 0) return;

    // 计算拖拽的进度偏移
    // 正值向前拖拽（快进），负值向后拖拽（快退）
    const progressDelta = (deltaX / videoWidth) * duration;
    const newProgress = Math.max(0, Math.min(this.state.dragStartTime + progressDelta, duration));
    
    this.state.dragCurrentProgress = newProgress;
    
    // 实时更新进度条和时间显示的视觉反馈
    this.updateVisualFeedback(newProgress, duration);
  }

  private handleDragEnd(): void {
    if (!this.state.isDragging) return;
    
    console.log("[MobileTouchControls] 拖拽结束，跳转到进度:", this.state.dragCurrentProgress);
    
    // 跳转到拖拽的进度位置
    this.player.currentTime(this.state.dragCurrentProgress);
    
    // 重置视觉反馈
    this.resetVisualFeedback();
    
    // 重置拖拽状态
    this.state.isDragging = false;
    this.state.dragCurrentProgress = 0;
  }

  private updateVisualFeedback(currentProgress: number, duration: number): void {
    try {
      // 更新进度条位置
      const progressBar = this.player.el().querySelector('.vjs-play-progress') as HTMLElement;
      if (progressBar) {
        const percentage = (currentProgress / duration) * 100;
        progressBar.style.width = `${percentage}%`;
      }

      // 更新当前时间显示
      const currentTimeDisplay = this.player.el().querySelector('.vjs-current-time-display') as HTMLElement;
      if (currentTimeDisplay) {
        currentTimeDisplay.textContent = this.formatTime(currentProgress);
      }

      // 更新剩余时间显示
      const remainingTimeDisplay = this.player.el().querySelector('.vjs-remaining-time-display') as HTMLElement;
      if (remainingTimeDisplay) {
        const remainingTime = duration - currentProgress;
        remainingTimeDisplay.textContent = `-${this.formatTime(remainingTime)}`;
      }

      // 为拖拽状态添加视觉样式
      const playerEl = this.player.el();
      if (!playerEl.classList.contains('vjs-touch-seeking')) {
        playerEl.classList.add('vjs-touch-seeking');
      }

    } catch (error) {
      console.warn("[MobileTouchControls] 更新视觉反馈时出错:", error);
    }
  }

  private resetVisualFeedback(): void {
    try {
      // 移除拖拽状态的视觉样式
      const playerEl = this.player.el();
      if (playerEl.classList.contains('vjs-touch-seeking')) {
        playerEl.classList.remove('vjs-touch-seeking');
      }
    } catch (error) {
      console.warn("[MobileTouchControls] 重置视觉反馈时出错:", error);
    }
  }

  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  private addTouchControlStyles(): void {
    // 添加基础触摸控制样式
    const styleId = "mobile-touch-controls-styles";
    if (document.getElementById(styleId)) return;

    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `
      .video-js.vjs-touch-enabled {
        touch-action: none;
      }
      
      .video-js.vjs-touch-enabled .vjs-tech {
        pointer-events: auto;
      }
      
      /* 隐藏默认的video.js触摸控制 */
      .video-js.vjs-touch-enabled .vjs-touch-overlay {
        display: none !important;
      }

      /* 拖拽状态的视觉反馈样式 */
      .video-js.vjs-touch-seeking {
        --seeking-transition: none;
      }

      .video-js.vjs-touch-seeking .vjs-play-progress {
        transition: var(--seeking-transition, none) !important;
      }

      .video-js.vjs-touch-seeking .vjs-current-time-display,
      .video-js.vjs-touch-seeking .vjs-remaining-time-display {
        color: #ffdd57 !important;
        font-weight: bold !important;
        transition: var(--seeking-transition, none) !important;
      }

      .video-js.vjs-touch-seeking .vjs-progress-control {
        opacity: 1 !important;
      }

      /* 确保在拖拽时进度条始终可见 */
      .video-js.vjs-touch-seeking .vjs-control-bar {
        opacity: 1 !important;
        visibility: visible !important;
      }
    `;
    document.head.appendChild(style);
  }

  dispose(): void {
    // 在插件销毁时重置播放速度
    this.resetPlaybackRate();
    
    // 清理拖拽状态
    
    // 移除触摸事件监听器
    this.removeTouchControls();
    
    // 移除全局事件监听器
    if (this.boundOrientationChange) {
      window.removeEventListener("orientationchange", this.boundOrientationChange);
      this.boundOrientationChange = null;
    }
    
    if (this.boundResize) {
      window.removeEventListener("resize", this.boundResize);
      this.boundResize = null;
    }
    
    // 清理计时器
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = null;
    }
    
    // 清理样式
    const styleId = "mobile-touch-controls-styles";
    const style = document.getElementById(styleId);
    if (style) {
      style.remove();
    }
    
    // 调用父类的dispose方法
    super.dispose();
  }

  private resetPlaybackRate(): void {
    // 如果当前播放速度不是原始速度，则重置
    const currentRate = this.player.playbackRate() || 1;
    if (currentRate !== this.state.originalPlaybackRate && this.state.originalPlaybackRate !== undefined) {
      this.player.playbackRate(this.state.originalPlaybackRate);
      this.state.isLongPress = false;
    }
  }
}

// 注册插件
videojs.registerPlugin("mobileTouchControls", function() {
  // 如果已经存在插件实例，先销毁它
  if ((this as any)._mobileTouchControlsPlugin) {
    (this as any)._mobileTouchControlsPlugin.dispose();
  }
  
  // 创建新的插件实例并保存引用
  (this as any)._mobileTouchControlsPlugin = new MobileTouchControlsPlugin(this);
});

export default MobileTouchControlsPlugin;
