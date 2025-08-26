import videojs, { VideoJsPlayer } from "video.js";

interface TouchControlState {
  isLongPress: boolean;
  longPressTimer: number | null;
  lastTapTime: number;
  lastTapPosition: { x: number; y: number };
  doubleTapTimer: number | null;
  originalPlaybackRate: number;
}

class MobileTouchControlsPlugin extends videojs.getPlugin("plugin") {
  private state: TouchControlState = {
    isLongPress: false,
    longPressTimer: null,
    lastTapTime: 0,
    lastTapPosition: { x: 0, y: 0 },
    doubleTapTimer: null,
    originalPlaybackRate: 1,
  };

  // 绑定的事件处理函数引用，用于正确移除事件监听器
  private boundTouchStart: ((event: TouchEvent) => void) | null = null;
  private boundTouchEnd: ((event: TouchEvent) => void) | null = null;
  private boundTouchMove: ((event: TouchEvent) => void) | null = null;
  
  // 防抖计时器
  private resizeTimer: number | null = null;

  private readonly LONG_PRESS_DURATION = 500; // 长按触发时间（毫秒）
  private readonly DOUBLE_TAP_DURATION = 300; // 双击检测时间（毫秒）
  private readonly DOUBLE_TAP_DISTANCE = 50; // 双击检测距离（像素）
  private readonly FAST_FORWARD_RATE = 20; // 快进倍速
  private readonly SEEK_STEP = 10; // 快进/快退步长（秒）

  constructor(player: VideoJsPlayer) {
    super(player);

    // 只在移动设备横屏模式下启用
    if (this.shouldEnableTouchControls()) {
      this.initializeTouchControls();
    }

    // 监听屏幕方向变化
    window.addEventListener("orientationchange", () => {
      // 立即重置播放速度
      this.resetPlaybackRate();
      
      // 延迟检查触摸控制状态，确保屏幕尺寸已更新
      setTimeout(() => {
        this.updateTouchControlsState();
      }, 150);
    });

    // 监听窗口大小变化（处理某些浏览器的方向变化）
    window.addEventListener("resize", () => {
      // 使用防抖处理resize事件
      if (this.resizeTimer) {
        clearTimeout(this.resizeTimer);
      }
      
      this.resizeTimer = setTimeout(() => {
        this.updateTouchControlsState();
      }, 100);
    });
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
    
    if (shouldEnable) {
      // 如果需要启用触摸控制，先检查是否已经启用
      if (!this.boundTouchStart) {
        this.initializeTouchControls();
      }
    } else {
      // 如果需要禁用触摸控制，确保完全移除
      this.removeTouchControls();
    }
  }

  private initializeTouchControls(): void {
    const videoEl = this.player.el().querySelector("video");
    if (!videoEl) return;

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

    // 添加样式
    this.addTouchControlStyles();
  }

  private removeTouchControls(): void {
    const videoEl = this.player.el().querySelector("video");
    if (!videoEl) return;

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

    // 重置触摸控制状态
    this.state.isLongPress = false;
    this.state.lastTapTime = 0;
    this.state.doubleTapTimer = null;
    this.state.longPressTimer = null;
  }

  private handleTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    // 记录触摸位置
    this.state.lastTapPosition = { x, y };

    // 重置长按状态
    this.state.isLongPress = false;

    // 开始长按计时器
    this.state.longPressTimer = window.setTimeout(() => {
      this.handleLongPress(x, y);
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
    // 如果移动距离过大，取消长按
    if (this.state.longPressTimer) {
      const touch = event.touches[0];
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      
      const distance = Math.sqrt(
        Math.pow(x - this.state.lastTapPosition.x, 2) + 
        Math.pow(y - this.state.lastTapPosition.y, 2)
      );

      if (distance > 20) {
        clearTimeout(this.state.longPressTimer);
        this.state.longPressTimer = null;
      }
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
      

    `;
    document.head.appendChild(style);
  }

  dispose(): void {
    // 在插件销毁时重置播放速度
    this.resetPlaybackRate();
    
    // 移除事件监听器
    this.removeTouchControls();
    
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
  new MobileTouchControlsPlugin(this);
});

export default MobileTouchControlsPlugin;
