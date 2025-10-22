import videojs, { VideoJsPlayer } from "video.js";

interface TouchControlState {
  isLongPress: boolean;
  longPressTimer: number | null;
  lastTapTime: number;
  lastTapPosition: { x: number; y: number };
  doubleTapTimer: number | null;
  tripleTapTimer: number | null;
  tapCount: number;
  originalPlaybackRate: number;
  
  // 拖拽进度相关状态
  isDragging: boolean;
  dragStartX: number;
  dragStartY: number;
  dragStartTime: number;
  dragCurrentProgress: number;
  wasPlayingBeforeDrag: boolean; // 拖拽前的播放状态
  
  // 长按倍速控制相关状态
  isLongPressSpeedControl: boolean;
  longPressStartY: number;
  currentSpeedRate: number;
  savedSpeedRate: number; // 记住的倍速
}

class MobileTouchControlsPlugin extends videojs.getPlugin("plugin") {
  private state: TouchControlState = {
    isLongPress: false,
    longPressTimer: null,
    lastTapTime: 0,
    lastTapPosition: { x: 0, y: 0 },
    doubleTapTimer: null,
    tripleTapTimer: null,
    tapCount: 0,
    originalPlaybackRate: 1,
    
    // 拖拽进度相关状态初始化
    isDragging: false,
    dragStartX: 0,
    dragStartY: 0,
    dragStartTime: 0,
    dragCurrentProgress: 0,
    wasPlayingBeforeDrag: false,
    
    // 长按倍速控制相关状态初始化
    isLongPressSpeedControl: false,
    longPressStartY: 0,
    currentSpeedRate: 1,
    savedSpeedRate: 1,
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
  
  // 倍速反馈相关
  private speedFeedbackElement: HTMLElement | null = null;
  private speedFeedbackTimer: number | null = null;

  // 增强字幕相关
  private enhancedSubtitlesEnabled: boolean = false;
  private subtitleCues: Array<{ startTime: number; endTime: number; text: string }> = [];
  private getCurrentSubtitleIndex: (() => number) | null = null;

  private readonly LONG_PRESS_DURATION = 500; // 长按触发时间（毫秒）
  private readonly DOUBLE_TAP_DURATION = 300; // 双击检测时间（毫秒）
  private readonly TRIPLE_TAP_DURATION = 400; // 三连击检测时间（毫秒）
  private readonly DOUBLE_TAP_DISTANCE = 50; // 双击检测距离（像素）
  private readonly SEEK_STEP = 10; // 快进/快退步长（秒）
  
  // 拖拽进度相关常量
  private readonly DRAG_THRESHOLD = 15; // 开始拖拽的最小距离（像素）
  private readonly MAX_VERTICAL_DRAG = 100; // 拖拽时允许的最大垂直偏移（像素）
  
  // 长按倍速控制相关常量
  private readonly SPEED_CONTROL_SENSITIVITY = 20; // 倍速控制灵敏度（像素）- 提高灵敏度
  private readonly MIN_SPEED_RATE = 0.25; // 最小倍速
  private readonly MAX_SPEED_RATE = 20; // 最大倍速
  private readonly SPEED_RATES = [0.25, 0.5, 0.75, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 4, 6, 8, 10, 12, 16, 20]; // 支持所有Video.js倍速档位
  private readonly SPEED_STORAGE_KEY = 'stash-video-speed-rate'; // localStorage存储键

  // 加载保存的倍速设置
  private loadSavedSpeedRate(): number {
    try {
      const saved = localStorage.getItem(this.SPEED_STORAGE_KEY);
      if (saved) {
        const rate = parseFloat(saved);
        if (rate >= this.MIN_SPEED_RATE && rate <= this.MAX_SPEED_RATE) {
          return rate;
        }
      }
    } catch (error) {
      console.warn("[MobileTouchControls] 加载倍速设置失败:", error);
    }
    return 1; // 默认1倍速
  }

  // 保存倍速设置
  private saveSpeedRate(rate: number): void {
    try {
      localStorage.setItem(this.SPEED_STORAGE_KEY, rate.toString());
    } catch (error) {
      console.warn("[MobileTouchControls] 保存倍速设置失败:", error);
    }
  }

  // 根据垂直滑动距离计算倍速
  private calculateSpeedFromGesture(deltaY: number): number {
    // 向上滑动为负值，向下滑动为正值
    // 向上滑动增加倍速，向下滑动减少倍速
    
    // 使用保存的默认倍速作为基准（长按的默认倍速）
    const baseSpeedRate = this.state.savedSpeedRate;
    let currentIndex = this.SPEED_RATES.indexOf(baseSpeedRate);
    if (currentIndex === -1) {
      // 如果默认倍速不在预设数组中，找到最接近的
      currentIndex = this.SPEED_RATES.indexOf(this.getClosestSpeedRate(baseSpeedRate));
    }
    
    // 计算滑动步数，使用更灵敏的计算方式
    // 每25像素为一个档位，并且支持小数步长以实现更平滑的响应
    const sensitivitySteps = -deltaY / this.SPEED_CONTROL_SENSITIVITY;
    const steps = Math.round(sensitivitySteps);
    
    // 对于小幅度滑动，也要给予反馈，提高响应灵敏度
    const minStep = Math.abs(sensitivitySteps) > 0.2 ? Math.sign(sensitivitySteps) : 0;
    const finalSteps = steps !== 0 ? steps : minStep;
    
    const newIndex = Math.max(0, Math.min(this.SPEED_RATES.length - 1, currentIndex + finalSteps));
    
    return this.SPEED_RATES[newIndex];
  }

  // 获取最接近的倍速档位
  private getClosestSpeedRate(targetRate: number): number {
    let closest = this.SPEED_RATES[0];
    let minDiff = Math.abs(targetRate - closest);
    
    for (const rate of this.SPEED_RATES) {
      const diff = Math.abs(targetRate - rate);
      if (diff < minDiff) {
        minDiff = diff;
        closest = rate;
      }
    }
    return closest;
  }

  // 显示倍速反馈
  private showSpeedFeedback(speedRate: number): void {
    if (!this.speedFeedbackElement) {
      this.createSpeedFeedbackElement();
    }
    
    if (this.speedFeedbackElement) {
      // 根据倍速提供更友好的显示文本
      let displayText = `${speedRate}x`;
      if (speedRate > 1) {
        displayText += ' 快进';
      } else if (speedRate < 1) {
        displayText += ' 慢放';
      } else {
        displayText = '正常速度';
      }
      
      this.speedFeedbackElement.textContent = displayText;
      this.speedFeedbackElement.classList.add('visible');
      
      // 清除之前的计时器
      if (this.speedFeedbackTimer) {
        clearTimeout(this.speedFeedbackTimer);
      }
      
      // 所有情况下都设置1秒后自动隐藏计时器
      this.speedFeedbackTimer = window.setTimeout(() => {
        if (this.speedFeedbackElement) {
          this.speedFeedbackElement.classList.remove('visible');
        }
      }, 1000);
    }
  }

  // 创建倍速反馈元素
  private createSpeedFeedbackElement(): void {
    const playerEl = this.player.el();
    if (!playerEl) return;
    
    this.speedFeedbackElement = document.createElement('div');
    this.speedFeedbackElement.className = 'mobile-speed-feedback';
    this.speedFeedbackElement.textContent = '1x';
    
    playerEl.appendChild(this.speedFeedbackElement);
  }

  // 移除倍速反馈元素
  private removeSpeedFeedbackElement(): void {
    if (this.speedFeedbackElement && this.speedFeedbackElement.parentNode) {
      this.speedFeedbackElement.parentNode.removeChild(this.speedFeedbackElement);
      this.speedFeedbackElement = null;
    }
    
    if (this.speedFeedbackTimer) {
      clearTimeout(this.speedFeedbackTimer);
      this.speedFeedbackTimer = null;
    }
  }

  constructor(player: VideoJsPlayer) {
    super(player);

    // 初始化倍速设置 - 加载保存的默认倍速
    this.state.savedSpeedRate = this.loadSavedSpeedRate();
    this.state.currentSpeedRate = 1;

    console.log("[MobileTouchControls] 插件初始化，保存的默认倍速:", this.state.savedSpeedRate);

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
      // 重置播放速度到1x正常速度
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
    
    if (this.state.tripleTapTimer) {
      clearTimeout(this.state.tripleTapTimer);
      this.state.tripleTapTimer = null;
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
    this.state.tapCount = 0;
    this.state.doubleTapTimer = null;
    this.state.tripleTapTimer = null;
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
    this.state.wasPlayingBeforeDrag = false;
    
    // 重置长按倍速控制状态
    this.state.isLongPressSpeedControl = false;
    this.state.longPressStartY = 0;
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
    this.state.isLongPressSpeedControl = false;
    this.state.longPressStartY = y;
    this.state.currentSpeedRate = 1;

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

    // 如果是长按结束，处理倍速控制结束
    if (this.state.isLongPress) {
      // 保存最后调整的倍速作为新的默认倍速（如果与当前保存的不同）
      if (this.state.currentSpeedRate !== this.state.savedSpeedRate) {
        this.state.savedSpeedRate = this.state.currentSpeedRate;
        this.saveSpeedRate(this.state.savedSpeedRate);
        console.log("[MobileTouchControls] 保存新的默认倍速:", this.state.savedSpeedRate);
      }
      
      // 释放手指后恢复到1x正常速度
      this.player.playbackRate(1);
      console.log("[MobileTouchControls] 长按结束，恢复1x正常速度");
      
      // 隐藏倍速反馈
      if (this.speedFeedbackElement) {
        this.speedFeedbackElement.classList.remove('visible');
      }
      
      this.state.isLongPress = false;
      this.state.isLongPressSpeedControl = false;
      this.state.currentSpeedRate = 1;
      event.preventDefault();
      return;
    }

    // 检测单击、双击和三连击
    const now = Date.now();
    const timeSinceLastTap = now - this.state.lastTapTime;
    const distance = Math.sqrt(
      Math.pow(x - this.state.lastTapPosition.x, 2) + 
      Math.pow(y - this.state.lastTapPosition.y, 2)
    );

    // 如果距离上次点击时间在检测范围内且距离足够近，增加点击计数
    if (timeSinceLastTap < this.TRIPLE_TAP_DURATION && distance < this.DOUBLE_TAP_DISTANCE) {
      this.state.tapCount++;
      this.state.lastTapTime = now;
      this.state.lastTapPosition = { x, y };
      
      // 清除之前的计时器
      if (this.state.doubleTapTimer) {
        clearTimeout(this.state.doubleTapTimer);
        this.state.doubleTapTimer = null;
      }
      if (this.state.tripleTapTimer) {
        clearTimeout(this.state.tripleTapTimer);
        this.state.tripleTapTimer = null;
      }
      
      // 检查点击次数
      if (this.state.tapCount === 3) {
        // 三连击
        this.handleTripleTap(x, y);
        this.state.tapCount = 0;
        this.state.lastTapTime = 0;
      } else if (this.state.tapCount === 2) {
        // 可能是双击，等待看是否有第三击
        this.state.tripleTapTimer = window.setTimeout(() => {
          this.handleDoubleTap(x, y);
          this.state.tapCount = 0;
          this.state.lastTapTime = 0;
          this.state.tripleTapTimer = null;
        }, this.TRIPLE_TAP_DURATION);
      } else if (this.state.tapCount === 1) {
        // 可能是单击，等待看是否有第二击
        this.state.doubleTapTimer = window.setTimeout(() => {
          this.handleSingleTap(x, y);
          this.state.tapCount = 0;
          this.state.lastTapTime = 0;
          this.state.doubleTapTimer = null;
        }, this.DOUBLE_TAP_DURATION);
      }
    } else {
      // 时间间隔过长或距离过远，重置为第一次点击
      this.state.tapCount = 1;
      this.state.lastTapTime = now;
      this.state.lastTapPosition = { x, y };
      
      // 清除之前的计时器
      if (this.state.doubleTapTimer) {
        clearTimeout(this.state.doubleTapTimer);
        this.state.doubleTapTimer = null;
      }
      if (this.state.tripleTapTimer) {
        clearTimeout(this.state.tripleTapTimer);
        this.state.tripleTapTimer = null;
      }
      
      // 等待可能的双击或三连击
      this.state.doubleTapTimer = window.setTimeout(() => {
        this.handleSingleTap(x, y);
        this.state.tapCount = 0;
        this.state.lastTapTime = 0;
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
    
    // 如果已经在长按倍速控制模式，处理垂直滑动
    if (this.state.isLongPressSpeedControl) {
      const verticalDelta = y - this.state.longPressStartY;
      const newSpeedRate = this.calculateSpeedFromGesture(verticalDelta);
      
      if (newSpeedRate !== this.state.currentSpeedRate) {
        this.state.currentSpeedRate = newSpeedRate;
        this.player.playbackRate(newSpeedRate);
        this.showSpeedFeedback(newSpeedRate);
        console.log("[MobileTouchControls] 倍速临时调整为:", newSpeedRate);
      }
      
      event.preventDefault();
      return;
    }
    
    // 检测是否开始拖拽
    if (!this.state.isDragging && !this.state.isLongPress && distance > this.DRAG_THRESHOLD) {
      const horizontalDistance = Math.abs(deltaX);
      const verticalDistance = Math.abs(deltaY);
      
      // 如果水平移动距离大于垂直移动距离，且垂直偏移不太大，则进入拖拽模式
      if (horizontalDistance > verticalDistance && verticalDistance < this.MAX_VERTICAL_DRAG) {
        this.state.isDragging = true;
        
        // 记录拖拽前的播放状态并暂停播放
        this.state.wasPlayingBeforeDrag = !this.player.paused();
        if (this.state.wasPlayingBeforeDrag) {
          this.player.pause();
        }
        
        // 取消长按计时器
        if (this.state.longPressTimer) {
          clearTimeout(this.state.longPressTimer);
          this.state.longPressTimer = null;
        }
        
        console.log("[MobileTouchControls] 开始拖拽进度模式，播放状态:", this.state.wasPlayingBeforeDrag);
      }
    }
    
    // 如果已经在拖拽模式，更新进度
    if (this.state.isDragging) {
      this.updateDragProgress(deltaX, rect.width);
      event.preventDefault();
      return;
    }
    
    // 如果移动距离过大且不在长按状态，取消长按
    if (this.state.longPressTimer && !this.state.isLongPress && distance > 20) {
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
    // 如果增强字幕已启用，双击重播当前字幕
    if (this.enhancedSubtitlesEnabled && this.getCurrentSubtitleIndex && this.subtitleCues.length > 0) {
      const currentIndex = this.getCurrentSubtitleIndex();
      if (currentIndex >= 0 && currentIndex < this.subtitleCues.length) {
        const currentCue = this.subtitleCues[currentIndex];
        console.log("[MobileTouchControls] 双击重播当前字幕:", currentCue.text);
        this.player.currentTime(currentCue.startTime);
        if (this.player.paused()) {
          this.player.play()?.catch((error) => {
            console.warn("播放失败:", error);
          });
        }
        return;
      }
    }

    // 默认行为：左侧后退，右侧前进
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

  private handleTripleTap(x: number, y: number): void {
    // 三连击仅在增强字幕启用时生效
    if (!this.enhancedSubtitlesEnabled || !this.getCurrentSubtitleIndex || this.subtitleCues.length === 0) {
      console.log("[MobileTouchControls] 三连击需要增强字幕启用");
      return;
    }

    const playerEl = this.player.el() as HTMLElement;
    const videoWidth = playerEl?.offsetWidth || 0;
    const isLeftSide = x < videoWidth / 2;
    
    const currentIndex = this.getCurrentSubtitleIndex();
    
    if (isLeftSide) {
      // 左侧三连击：播放上一个字幕
      if (currentIndex > 0) {
        const prevCue = this.subtitleCues[currentIndex - 1];
        console.log("[MobileTouchControls] 三连击左侧，播放上一个字幕:", prevCue.text);
        this.player.currentTime(prevCue.startTime);
        if (this.player.paused()) {
          this.player.play()?.catch((error) => {
            console.warn("播放失败:", error);
          });
        }
      } else {
        console.log("[MobileTouchControls] 已经是第一个字幕");
      }
    } else {
      // 右侧三连击：播放下一个字幕
      if (currentIndex < this.subtitleCues.length - 1) {
        const nextCue = this.subtitleCues[currentIndex + 1];
        console.log("[MobileTouchControls] 三连击右侧，播放下一个字幕:", nextCue.text);
        this.player.currentTime(nextCue.startTime);
        if (this.player.paused()) {
          this.player.play()?.catch((error) => {
            console.warn("播放失败:", error);
          });
        }
      } else {
        console.log("[MobileTouchControls] 已经是最后一个字幕");
      }
    }
  }

  private handleLongPress(x: number, y: number): void {
    // 长按：启动倍速控制模式，使用保存的默认倍速
    try {
      this.state.originalPlaybackRate = this.player.playbackRate() || 1;
      this.state.isLongPress = true;
      this.state.isLongPressSpeedControl = true;
      
      // 保存长按开始的Y坐标，用于后续的垂直滑动检测
      this.state.longPressStartY = this.state.dragStartY;
      
      // 设置初始倍速为保存的默认倍速（按住不放的默认倍速）
      this.state.currentSpeedRate = this.state.savedSpeedRate;
      this.player.playbackRate(this.state.currentSpeedRate);
      
      // 移除立即显示反馈消息，只有在垂直滑动时才显示
      // this.showSpeedFeedback(this.state.currentSpeedRate);
      
      console.log("[MobileTouchControls] 长按倍速控制模式启动，默认倍速:", this.state.savedSpeedRate);
      
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
    
    // 由于视频时间已经在拖拽过程中实时更新，这里不需要重复设置
    // 只需要恢复播放状态和重置视觉反馈
    
    // 恢复原始播放状态
    if (this.state.wasPlayingBeforeDrag) {
      this.player.play()?.catch((error) => {
        console.warn("[MobileTouchControls] 恢复播放失败:", error);
      });
    }
    
    // 重置视觉反馈
    this.resetVisualFeedback();
    
    // 重置拖拽状态
    this.state.isDragging = false;
    this.state.dragCurrentProgress = 0;
    this.state.wasPlayingBeforeDrag = false;
  }

  private updateVisualFeedback(currentProgress: number, duration: number): void {
    try {
      // 更新视频的实际时间位置
      this.player.currentTime(currentProgress);
      
      // 简化的视频帧更新 - 避免重复的DOM操作
      try {
        const videoElement = this.player.el().querySelector('video') as HTMLVideoElement;
        if (videoElement && videoElement.readyState >= 2) {
          // 只触发timeupdate事件，让VideoJS自己处理UI更新
          videoElement.dispatchEvent(new Event('timeupdate', { bubbles: true }));
        }
      } catch (frameError) {
        console.warn("[MobileTouchControls] 更新视频帧失败:", frameError);
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
      
      /* 倍速反馈样式 */
      .mobile-speed-feedback {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 24px;
        font-weight: bold;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
        user-select: none;
        font-family: system-ui, -apple-system, sans-serif;
      }
      
      .mobile-speed-feedback.visible {
        opacity: 1;
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
    
    // 清理倍速反馈元素
    this.removeSpeedFeedbackElement();
    
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
    // 总是重置到1x正常播放速度
    const currentRate = this.player.playbackRate() || 1;
    if (currentRate !== 1) {
      this.player.playbackRate(1);
      this.state.isLongPress = false;
      this.state.isLongPressSpeedControl = false;
      this.state.currentSpeedRate = 1;
      console.log("[MobileTouchControls] 播放速度重置为1x正常速度");
    }
  }

  // 公共方法：设置增强字幕状态
  public setEnhancedSubtitlesEnabled(enabled: boolean): void {
    this.enhancedSubtitlesEnabled = enabled;
    console.log("[MobileTouchControls] 增强字幕状态:", enabled ? "已启用" : "已禁用");
  }

  // 公共方法：设置字幕列表
  public setSubtitleCues(cues: Array<{ startTime: number; endTime: number; text: string }>): void {
    this.subtitleCues = cues;
    console.log("[MobileTouchControls] 已设置字幕列表，共", cues.length, "条");
  }

  // 公共方法：设置获取当前字幕索引的回调函数
  public setGetCurrentSubtitleIndex(callback: () => number): void {
    this.getCurrentSubtitleIndex = callback;
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
