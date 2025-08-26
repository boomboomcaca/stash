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

  private readonly LONG_PRESS_DURATION = 500; // 长按触发时间（毫秒）
  private readonly DOUBLE_TAP_DURATION = 300; // 双击检测时间（毫秒）
  private readonly DOUBLE_TAP_DISTANCE = 50; // 双击检测距离（像素）
  private readonly FAST_FORWARD_RATE = 20; // 快进倍速
  private readonly SEEK_STEP = 5; // 快进/快退步长（秒）

  constructor(player: VideoJsPlayer) {
    super(player);

    // 只在移动设备横屏模式下启用
    if (this.shouldEnableTouchControls()) {
      this.initializeTouchControls();
    }

    // 监听屏幕方向变化
    window.addEventListener("orientationchange", () => {
      setTimeout(() => {
        if (this.shouldEnableTouchControls()) {
          this.initializeTouchControls();
        } else {
          this.removeTouchControls();
        }
      }, 100);
    });
  }

  private shouldEnableTouchControls(): boolean {
    // 检查是否为移动设备且处于横屏模式
    const isMobile = window.matchMedia("(max-width: 1199px)").matches;
    const isLandscape = window.matchMedia("(orientation: landscape)").matches;
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    
    return isMobile && isLandscape && isTouch;
  }

  private initializeTouchControls(): void {
    const videoEl = this.player.el().querySelector("video");
    if (!videoEl) return;

    // 移除现有的事件监听器
    this.removeTouchControls();

    // 添加触摸事件监听器
    videoEl.addEventListener("touchstart", this.handleTouchStart.bind(this), { passive: false });
    videoEl.addEventListener("touchend", this.handleTouchEnd.bind(this), { passive: false });
    videoEl.addEventListener("touchmove", this.handleTouchMove.bind(this), { passive: false });

    // 添加样式
    this.addTouchControlStyles();
  }

  private removeTouchControls(): void {
    const videoEl = this.player.el().querySelector("video");
    if (!videoEl) return;

    videoEl.removeEventListener("touchstart", this.handleTouchStart.bind(this));
    videoEl.removeEventListener("touchend", this.handleTouchEnd.bind(this));
    videoEl.removeEventListener("touchmove", this.handleTouchMove.bind(this));

    // 恢复原始播放速度
    if (this.state.isLongPress) {
      this.player.playbackRate(this.state.originalPlaybackRate);
      this.state.isLongPress = false;
    }
  }

  private handleTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) return;

    const touch = event.touches[0];
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    const x = touch.clientX - rect.left;
    const y = touch.clientY - rect.top;

    // 记录触摸位置
    this.state.lastTapPosition = { x, y };

    // 添加触摸反馈样式
    this.player.el().classList.add("vjs-touching");

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

    // 移除触摸反馈样式
    this.player.el().classList.remove("vjs-touching");

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
      // 双击
      this.handleDoubleTap(x, y);
      this.state.lastTapTime = 0; // 重置，避免连续双击
    } else {
      // 单击
      this.handleSingleTap(x, y);
      this.state.lastTapTime = now;
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
        this.player.play().catch((error) => {
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
    const videoWidth = this.player.el().offsetWidth;
    const isLeftSide = x < videoWidth / 2;

    if (isLeftSide) {
      // 左侧双击：后退5秒
      this.seekRelative(-this.SEEK_STEP);
    } else {
      // 右侧双击：前进5秒
      this.seekRelative(this.SEEK_STEP);
    }
  }

  private handleLongPress(x: number, y: number): void {
    // 长按：20倍速播放
    try {
      this.state.originalPlaybackRate = this.player.playbackRate();
      this.player.playbackRate(this.FAST_FORWARD_RATE);
      this.state.isLongPress = true;
      
      // 确保视频在播放状态
      if (this.player.paused()) {
        this.player.play().catch((error) => {
          console.warn("长按播放失败:", error);
        });
      }
    } catch (error) {
      console.warn("长按操作失败:", error);
    }
  }

  private seekRelative(seconds: number): void {
    const currentTime = this.player.currentTime();
    const duration = this.player.duration();
    const newTime = Math.max(0, Math.min(currentTime + seconds, duration));
    this.player.currentTime(newTime);
  }

  private addTouchControlStyles(): void {
    // 添加触摸控制提示样式
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
      
      /* 横屏模式下的触摸控制提示 */
      @media (orientation: landscape) and (max-width: 1199px) {
        .video-js.vjs-touch-enabled::after {
          content: "单击播放/暂停 | 左侧双击后退5秒 | 右侧双击前进5秒 | 长按20倍速";
          position: absolute;
          top: 10px;
          left: 50%;
          transform: translateX(-50%);
          background: rgba(0, 0, 0, 0.7);
          color: white;
          padding: 5px 10px;
          border-radius: 4px;
          font-size: 12px;
          z-index: 1000;
          opacity: 0;
          transition: opacity 0.3s;
          pointer-events: none;
        }
        
        .video-js.vjs-touch-enabled:hover::after {
          opacity: 1;
        }
      }
    `;
    document.head.appendChild(style);
  }
}

// 注册插件
videojs.registerPlugin("mobileTouchControls", function() {
  new MobileTouchControlsPlugin(this);
});

export default MobileTouchControlsPlugin;
