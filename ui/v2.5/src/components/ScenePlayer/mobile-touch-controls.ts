import videojs, { VideoJsPlayer } from "video.js";

interface ITouchControlState {
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
  wasMutedBeforeDrag: boolean; // 拖拽前的静音状态

  // 长按倍速控制相关状态
  isLongPressSpeedControl: boolean;
  longPressStartY: number;
  currentSpeedRate: number;
  savedSpeedRate: number; // 记住的倍速

  // 连续点击快进/快退相关状态
  continuousSeekTimer: number | null;
  continuousSeekTotal: number;
  seekFeedbackTimer: number | null;

  // 垂直滑动切换字幕相关状态
  isVerticalSwipe: boolean;
  verticalSwipeTriggered: boolean;

  // 水平滑动选择单词相关状态
  isWordSwipe: boolean;
  wordSwipeStartX: number;
  wordSwipeLastDelta: number; // 用于计算增量
  wordSwipeTriggered: boolean;
}

class MobileTouchControlsPlugin extends videojs.getPlugin("plugin") {
  private state: ITouchControlState = {
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
    wasMutedBeforeDrag: false,

    // 长按倍速控制相关状态初始化
    isLongPressSpeedControl: false,
    longPressStartY: 0,
    currentSpeedRate: 1,
    savedSpeedRate: 1,

    // 连续点击快进/快退相关状态初始化
    continuousSeekTimer: null,
    continuousSeekTotal: 0,
    seekFeedbackTimer: null,

    // 垂直滑动切换字幕相关状态初始化
    isVerticalSwipe: false,
    verticalSwipeTriggered: false,

    // 水平滑动选择单词相关状态初始化
    isWordSwipe: false,
    wordSwipeStartX: 0,
    wordSwipeLastDelta: 0,
    wordSwipeTriggered: false,
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

  // 快进/快退反馈相关
  private seekFeedbackElement: HTMLElement | null = null;

  // 增强字幕相关
  private enhancedSubtitlesEnabled: boolean = false;
  private subtitleCues: Array<{
    startTime: number;
    endTime: number;
    text: string;
  }> = [];
  private getCurrentSubtitleIndex: (() => number) | null = null;
  private showControlBar: (() => void) | null = null;

  // 场景切换回调
  private onNextScene: (() => void) | null = null;
  private onPreviousScene: (() => void) | null = null;

  // 单词导航回调
  private navigateToNextWord: (() => void) | null = null;
  private navigateToPreviousWord: (() => void) | null = null;
  private enterWordNavigationMode: ((selectLastWord?: boolean) => void) | null =
    null;
  private exitWordNavigationMode: (() => void) | null = null;
  private handleWordSelection: (() => Promise<void>) | null = null;
  private isInWordNavigationMode: (() => boolean) | null = null;
  private isDraggingMode: boolean = false; // 标记是否正在拖动
  private originalReportUserActivity: ((event?: Event) => void) | null = null; // 保存原始的 reportUserActivity

  private readonly LONG_PRESS_DURATION = 500; // 长按触发时间（毫秒）
  private readonly DOUBLE_TAP_DURATION = 300; // 双击检测时间（毫秒）
  private readonly TRIPLE_TAP_DURATION = 400; // 三连击检测时间（毫秒）
  private readonly CONTINUOUS_TAP_TIMEOUT = 500; // 连续点击超时时间（毫秒）
  private readonly DOUBLE_TAP_DISTANCE = 50; // 双击检测距离（像素）
  private readonly SEEK_STEP = 10; // 默认快进/快退步长（秒）
  private readonly CONTINUOUS_SEEK_STEP = 5; // 连续点击每次增加的步长（秒）

  // 拖拽进度相关常量
  private readonly DRAG_THRESHOLD = 15; // 开始拖拽的最小距离（像素）
  private readonly MAX_VERTICAL_DRAG = 100; // 拖拽时允许的最大垂直偏移（像素）
  private readonly VERTICAL_SWIPE_THRESHOLD = 30; // 垂直滑动切换字幕的阈值（像素）

  // 单词滑动选择相关常量
  private readonly WORD_SWIPE_THRESHOLD = 25; // 触发单词选择的滑动距离阈值（像素）
  private readonly WORD_SWIPE_STEP = 40; // 每个单词切换需要的滑动距离（像素）
  private readonly WORD_SWIPE_VELOCITY_THRESHOLD = 0.3; // 快速滑动的速度阈值
  private wordSwipeStartTime: number = 0; // 记录滑动开始时间

  // 长按倍速控制相关常量
  private readonly SPEED_CONTROL_SENSITIVITY = 20; // 倍速控制灵敏度（像素）- 提高灵敏度
  private readonly MIN_SPEED_RATE = 0.25; // 最小倍速
  private readonly MAX_SPEED_RATE = 20; // 最大倍速
  private readonly SPEED_RATES = [
    0.25, 0.5, 0.75, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 4, 6,
    8, 10, 12, 16, 20,
  ]; // 支持所有Video.js倍速档位
  private readonly SPEED_STORAGE_KEY = "stash-video-speed-rate"; // localStorage存储键

  // 辅助函数：触发触觉反馈（震动）
  private triggerHapticFeedback(): void {
    try {
      if (navigator.vibrate) {
        navigator.vibrate(10); // 短促的震动反馈
      }
    } catch {
      // 忽略震动失败
    }
  }

  // 辅助函数：处理单词滑动选择
  private handleWordSwipe(deltaX: number): void {
    // 计算当前滑动距离应该对应的单词步数
    const currentSteps = Math.floor(Math.abs(deltaX) / this.WORD_SWIPE_STEP);
    const lastSteps = Math.floor(
      Math.abs(this.state.wordSwipeLastDelta) / this.WORD_SWIPE_STEP
    );

    // 只有当步数变化时才触发单词切换
    if (currentSteps > lastSteps) {
      // 计算需要切换的次数
      const stepsToNavigate = currentSteps - lastSteps;

      for (let i = 0; i < stepsToNavigate; i++) {
        if (deltaX > 0) {
          // 右滑：下一个单词
          this.navigateToNextWord?.();
        } else {
          // 左滑：上一个单词
          this.navigateToPreviousWord?.();
        }
        this.triggerHapticFeedback();
      }
    }

    // 更新上次的滑动距离
    this.state.wordSwipeLastDelta = deltaX;
  }

  // 辅助函数：统一的播放控制
  private playIfPaused(): void {
    if (this.player.paused()) {
      this.player.play()?.catch(() => {
        // 静默处理播放失败，避免控制台污染
      });
    }
  }

  // 辅助函数：统一的字幕跳转
  private jumpToSubtitle(cue: { startTime: number; text: string }): void {
    this.player.currentTime(cue.startTime);
    this.playIfPaused();
  }

  // 辅助函数：查找最接近当前时间的字幕索引
  private findNearestCueIndex(
    currentTime: number,
    cues: Array<{ startTime: number; endTime: number; text: string }>,
    currentIndex: number
  ): number {
    // 如果当前索引有效，直接返回
    if (currentIndex >= 0 && currentIndex < cues.length) {
      return currentIndex;
    }

    // 如果没有字幕，返回 -1
    if (!cues || cues.length === 0) {
      return -1;
    }

    // 查找最接近的字幕
    // 优先查找已经开始的字幕（即使已过结束时间）
    for (let i = 0; i < cues.length; i++) {
      if (currentTime >= cues[i].startTime && currentTime <= cues[i].endTime) {
        return i;
      }
    }

    // 如果没有正在进行的字幕，查找下一个即将开始的字幕
    for (let i = 0; i < cues.length; i++) {
      if (currentTime < cues[i].startTime) {
        return i;
      }
    }

    // 如果已经过了所有字幕，返回最后一个字幕的索引
    return cues.length - 1;
  }

  // 辅助函数：获取下一个字幕的索引
  private getNextSubtitleIndex(
    currentIndex: number,
    currentTime: number
  ): number {
    const cues = this.subtitleCues;
    if (!cues || cues.length === 0) return -1;

    if (currentIndex >= 0) {
      // 当前有字幕显示，跳到下一条
      return currentIndex + 1;
    } else {
      // 当前没有字幕显示，找到下一个即将开始的字幕
      for (let i = 0; i < cues.length; i++) {
        if (currentTime < cues[i].startTime) {
          return i;
        }
      }
      // 如果已经过了所有字幕开始时间，没有下一条
      return cues.length;
    }
  }

  // 辅助函数：获取上一个字幕的索引
  private getPreviousSubtitleIndex(
    currentIndex: number,
    currentTime: number
  ): number {
    const cues = this.subtitleCues;
    if (!cues || cues.length === 0) return -1;

    if (currentIndex >= 0) {
      // 当前有字幕显示，跳到上一条
      return currentIndex - 1;
    } else {
      // 当前没有字幕显示，找到最后一个已经结束的字幕
      for (let i = cues.length - 1; i >= 0; i--) {
        if (currentTime > cues[i].endTime) {
          return i;
        }
      }
      // 如果在所有字幕之前，没有上一条
      return -1;
    }
  }

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
    } catch {
      // 忽略错误
    }
    return 1; // 默认1倍速
  }

  // 保存倍速设置
  private saveSpeedRate(rate: number): void {
    try {
      localStorage.setItem(this.SPEED_STORAGE_KEY, rate.toString());
    } catch {
      // 忽略保存失败
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
      currentIndex = this.SPEED_RATES.indexOf(
        this.getClosestSpeedRate(baseSpeedRate)
      );
    }

    // 计算滑动步数，使用更灵敏的计算方式
    // 每25像素为一个档位，并且支持小数步长以实现更平滑的响应
    const sensitivitySteps = -deltaY / this.SPEED_CONTROL_SENSITIVITY;
    const steps = Math.round(sensitivitySteps);

    // 对于小幅度滑动，也要给予反馈，提高响应灵敏度
    const minStep =
      Math.abs(sensitivitySteps) > 0.2 ? Math.sign(sensitivitySteps) : 0;
    const finalSteps = steps !== 0 ? steps : minStep;

    const newIndex = Math.max(
      0,
      Math.min(this.SPEED_RATES.length - 1, currentIndex + finalSteps)
    );

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
  private showSpeedFeedback(
    speedRate: number,
    preventAutoHide: boolean = false
  ): void {
    if (!this.speedFeedbackElement) {
      this.createSpeedFeedbackElement();
    }

    if (this.speedFeedbackElement) {
      // 根据倍速提供更友好的显示文本
      let displayText = `${speedRate}x`;
      if (speedRate > 1) {
        displayText += " 快进";
      } else if (speedRate < 1) {
        displayText += " 慢放";
      } else {
        displayText = "正常速度";
      }

      this.speedFeedbackElement.textContent = displayText;
      this.speedFeedbackElement.classList.add("visible");

      // 清除之前的计时器
      if (this.speedFeedbackTimer) {
        clearTimeout(this.speedFeedbackTimer);
        this.speedFeedbackTimer = null;
      }

      // 只有在不阻止自动隐藏时才设置自动隐藏计时器
      if (!preventAutoHide) {
        this.speedFeedbackTimer = window.setTimeout(() => {
          if (this.speedFeedbackElement) {
            this.speedFeedbackElement.classList.remove("visible");
          }
        }, 1000);
      }
    }
  }

  // 创建倍速反馈元素
  private createSpeedFeedbackElement(): void {
    const playerEl = this.player.el();
    if (!playerEl) return;

    this.speedFeedbackElement = document.createElement("div");
    this.speedFeedbackElement.className = "mobile-speed-feedback";
    this.speedFeedbackElement.textContent = "1x";

    playerEl.appendChild(this.speedFeedbackElement);
  }

  // 移除倍速反馈元素
  private removeSpeedFeedbackElement(): void {
    if (this.speedFeedbackElement && this.speedFeedbackElement.parentNode) {
      this.speedFeedbackElement.parentNode.removeChild(
        this.speedFeedbackElement
      );
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

    // 只在移动设备上启用
    if (this.shouldEnableTouchControls()) {
      this.initializeTouchControls();
    }

    // 绑定并监听屏幕方向变化
    this.boundOrientationChange = () => {
      // 不再重置播放速度，保持用户设置的播放速度

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
    // 检查是否为移动触摸设备
    const isMobile = window.matchMedia("(max-width: 1199px)").matches;
    const isTouch = window.matchMedia("(pointer: coarse)").matches;

    // 检查是否在 Playwright 或自动化测试环境中
    // navigator.webdriver 在自动化浏览器中为 true
    // 也支持通过 window.__FORCE_TOUCH_CONTROLS__ 手动强制启用
    const isAutomation = navigator.webdriver === true;
    const forceEnabled =
      (window as Window & { __FORCE_TOUCH_CONTROLS__?: boolean })
        .__FORCE_TOUCH_CONTROLS__ === true;

    // 在自动化环境中，只需要 isMobile 即可启用（跳过 pointer:coarse 检查）
    if ((isAutomation || forceEnabled) && isMobile) {
      return true;
    }

    // 只有在移动设备且支持触摸时才启用触摸控制
    return isMobile && isTouch;
  }

  private updateTouchControlsState(): void {
    // 检查当前触摸控制状态
    const shouldEnable = this.shouldEnableTouchControls();
    const isCurrentlyEnabled = this.boundTouchStart !== null;

    if (shouldEnable && !isCurrentlyEnabled) {
      // 需要启用但当前未启用 - 初始化触摸控制
      this.initializeTouchControls();
    } else if (!shouldEnable && isCurrentlyEnabled) {
      // 需要禁用但当前已启用 - 移除触摸控制
      this.removeTouchControls();
    }
  }

  private initializeTouchControls(): void {
    const videoEl = this.player.el().querySelector("video");
    if (!videoEl) {
      return;
    }

    // 移除现有的事件监听器
    this.removeTouchControls();

    // 绑定事件处理函数并保存引用
    this.boundTouchStart = this.handleTouchStart.bind(this);
    this.boundTouchEnd = this.handleTouchEnd.bind(this);
    this.boundTouchMove = this.handleTouchMove.bind(this);

    // 添加触摸事件监听器
    videoEl.addEventListener("touchstart", this.boundTouchStart, {
      passive: false,
    });
    videoEl.addEventListener("touchend", this.boundTouchEnd, {
      passive: false,
    });
    videoEl.addEventListener("touchmove", this.boundTouchMove, {
      passive: false,
    });

    // 添加样式
    this.addTouchControlStyles();
  }

  private removeTouchControls(): void {
    const videoEl = this.player.el().querySelector("video");
    if (!videoEl) {
      return;
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

    // 清除连续点击相关计时器
    if (this.state.continuousSeekTimer) {
      clearTimeout(this.state.continuousSeekTimer);
      this.state.continuousSeekTimer = null;
    }
    if (this.state.seekFeedbackTimer) {
      clearTimeout(this.state.seekFeedbackTimer);
      this.state.seekFeedbackTimer = null;
    }

    // 移除快进/快退反馈
    this.removeSeekFeedback();

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

    // 重置单词滑动状态
    this.state.isWordSwipe = false;
    this.state.wordSwipeStartX = x;
    this.state.wordSwipeLastDelta = 0;
    this.state.wordSwipeTriggered = false;
    this.wordSwipeStartTime = Date.now();

    // 开始长按计时器
    this.state.longPressTimer = window.setTimeout(() => {
      // 只有在没有进入拖拽模式时才触发长按
      if (!this.state.isDragging) {
        this.handleLongPress();
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

    // 如果是垂直滑动结束，重置状态
    if (this.state.isVerticalSwipe) {
      this.state.isVerticalSwipe = false;
      this.state.verticalSwipeTriggered = false;
      event.preventDefault();
      return;
    }

    // 如果是单词滑动结束，重置状态并处理快速滑动
    if (this.state.isWordSwipe) {
      // 计算滑动速度和方向
      const deltaX = x - this.state.wordSwipeStartX;
      const elapsed = Date.now() - this.wordSwipeStartTime;
      const velocity = Math.abs(deltaX) / elapsed; // px/ms

      // 快速滑动时额外触发一次单词切换（惯性效果）
      if (
        velocity > this.WORD_SWIPE_VELOCITY_THRESHOLD &&
        Math.abs(deltaX) > 50
      ) {
        if (deltaX > 0) {
          this.navigateToNextWord?.();
          this.triggerHapticFeedback();
        } else {
          this.navigateToPreviousWord?.();
          this.triggerHapticFeedback();
        }
      }

      this.state.isWordSwipe = false;
      this.state.wordSwipeLastDelta = 0;
      this.state.wordSwipeTriggered = false;
      event.preventDefault();
      return;
    }

    // 如果是长按结束，处理倍速控制结束
    if (this.state.isLongPress) {
      // 保存最后调整的倍速作为新的默认倍速（如果与当前保存的不同）
      if (this.state.currentSpeedRate !== this.state.savedSpeedRate) {
        this.state.savedSpeedRate = this.state.currentSpeedRate;
        this.saveSpeedRate(this.state.savedSpeedRate);
      }

      // 根据保存的倍速决定松手后的播放速度
      if (this.state.savedSpeedRate < 1) {
        // 慢放模式：松手后恢复到保存的慢放倍速
        this.player.playbackRate(this.state.savedSpeedRate);
      } else {
        // 快进模式：松手后恢复到 1x 正常速度
        this.player.playbackRate(1);
      }

      // 立即隐藏倍速反馈
      if (this.speedFeedbackElement) {
        this.speedFeedbackElement.classList.remove("visible");
      }

      // 清除可能存在的自动隐藏计时器
      if (this.speedFeedbackTimer) {
        clearTimeout(this.speedFeedbackTimer);
        this.speedFeedbackTimer = null;
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
    // 注意：对于连续点击，我们需要放宽时间限制，只要在 CONTINUOUS_TAP_TIMEOUT 内都算连续点击
    const tapTimeout =
      !this.enhancedSubtitlesEnabled || this.subtitleCues.length === 0
        ? this.CONTINUOUS_TAP_TIMEOUT
        : this.TRIPLE_TAP_DURATION;

    if (timeSinceLastTap < tapTimeout && distance < this.DOUBLE_TAP_DISTANCE) {
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

      // 分支处理：增强字幕启用 vs 未启用
      if (this.enhancedSubtitlesEnabled && this.subtitleCues.length > 0) {
        // 原有逻辑：增强字幕启用时的处理
        if (this.state.tapCount === 3) {
          // 三连击
          this.handleTripleTap(x);
          this.state.tapCount = 0;
          this.state.lastTapTime = 0;
        } else if (this.state.tapCount === 2) {
          // 可能是双击，等待看是否有第三击
          this.state.tripleTapTimer = window.setTimeout(() => {
            this.handleDoubleTap(x);
            this.state.tapCount = 0;
            this.state.lastTapTime = 0;
            this.state.tripleTapTimer = null;
          }, this.TRIPLE_TAP_DURATION);
        } else if (this.state.tapCount === 1) {
          // 可能是单击，等待看是否有第二击
          this.state.doubleTapTimer = window.setTimeout(() => {
            this.handleSingleTap();
            this.state.tapCount = 0;
            this.state.lastTapTime = 0;
            this.state.doubleTapTimer = null;
          }, this.DOUBLE_TAP_DURATION);
        }
      } else {
        // 新逻辑：增强字幕未启用时的连续点击累积快进/快退

        // 清除连续点击重置计时器（如果有）
        if (this.state.continuousSeekTimer) {
          clearTimeout(this.state.continuousSeekTimer);
          this.state.continuousSeekTimer = null;
        }

        if (this.state.tapCount >= 2) {
          // 2次或更多次点击：立即执行快进/快退并累积
          this.handleContinuousSeek(x);

          // 设置连续点击重置计时器
          this.state.continuousSeekTimer = window.setTimeout(() => {
            this.state.tapCount = 0;
            this.state.continuousSeekTotal = 0;
            this.removeSeekFeedback();
            this.state.continuousSeekTimer = null;
          }, this.CONTINUOUS_TAP_TIMEOUT);
        }
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

      // 清除连续点击相关状态
      if (this.state.continuousSeekTimer) {
        clearTimeout(this.state.continuousSeekTimer);
        this.state.continuousSeekTimer = null;
      }
      this.state.continuousSeekTotal = 0;
      this.removeSeekFeedback();

      // 等待可能的双击（用于两种模式）
      this.state.doubleTapTimer = window.setTimeout(() => {
        this.handleSingleTap();
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
        this.showSpeedFeedback(newSpeedRate, true);
      }

      event.preventDefault();
      return;
    }

    // 检测是否开始拖拽、垂直滑动或单词滑动
    if (
      !this.state.isDragging &&
      !this.state.isLongPress &&
      !this.state.isVerticalSwipe &&
      !this.state.isWordSwipe &&
      distance > this.DRAG_THRESHOLD
    ) {
      const horizontalDistance = Math.abs(deltaX);
      const verticalDistance = Math.abs(deltaY);

      // 如果垂直移动距离大于水平移动距离，则进入垂直滑动模式
      // 用于切换字幕（增强字幕启用时）或切换场景（无字幕时）
      if (verticalDistance > horizontalDistance) {
        // 如果已经在选词模式，向下滑动退出选词模式
        if (this.isInWordNavigationMode?.() && deltaY > 0) {
          this.exitWordNavigationMode?.();
          this.triggerHapticFeedback();

          // 切换播放/暂停（与键盘↑行为一致）
          if (this.player.paused()) {
            this.player.play()?.catch(() => {});
          } else {
            this.player.pause();
          }

          // 设置垂直滑动状态为已触发，防止后续触发字幕切换
          this.state.isVerticalSwipe = true;
          this.state.verticalSwipeTriggered = true;

          // 取消长按计时器
          if (this.state.longPressTimer) {
            clearTimeout(this.state.longPressTimer);
            this.state.longPressTimer = null;
          }

          event.preventDefault();
          return;
        }

        // 只有在有字幕可切换或有场景切换回调时才进入垂直滑动模式
        const hasSubtitles =
          this.enhancedSubtitlesEnabled && this.subtitleCues.length > 0;
        const hasSceneCallbacks = this.onNextScene || this.onPreviousScene;

        if (hasSubtitles || hasSceneCallbacks) {
          this.state.isVerticalSwipe = true;
          this.state.verticalSwipeTriggered = false;

          // 取消长按计时器
          if (this.state.longPressTimer) {
            clearTimeout(this.state.longPressTimer);
            this.state.longPressTimer = null;
          }
        }
      }
      // 如果水平移动距离大于垂直移动距离，且垂直偏移不太大
      else if (
        horizontalDistance > verticalDistance &&
        verticalDistance < this.MAX_VERTICAL_DRAG
      ) {
        // 如果增强字幕启用且有单词导航回调，进入单词滑动模式
        if (
          this.enhancedSubtitlesEnabled &&
          this.navigateToNextWord &&
          this.navigateToPreviousWord
        ) {
          this.state.isWordSwipe = true;
          this.state.wordSwipeStartX = this.state.dragStartX;
          this.state.wordSwipeLastDelta = 0;

          // 如果还没进入单词导航模式，先进入
          if (
            this.enterWordNavigationMode &&
            !this.isInWordNavigationMode?.()
          ) {
            // 根据滑动方向决定选择第一个还是最后一个单词
            const selectLastWord = deltaX < 0;
            this.enterWordNavigationMode(selectLastWord);
          }

          // 取消长按计时器
          if (this.state.longPressTimer) {
            clearTimeout(this.state.longPressTimer);
            this.state.longPressTimer = null;
          }
        } else {
          // 如果增强字幕未启用，进入拖拽进度模式
          this.state.isDragging = true;
          this.isDraggingMode = true; // 标记正在拖动

          // 记录拖拽前的播放状态和静音状态并暂停播放
          this.state.wasPlayingBeforeDrag = !this.player.paused();
          this.state.wasMutedBeforeDrag = this.player.muted() ?? false;
          if (this.state.wasPlayingBeforeDrag) {
            this.player.pause();
          }

          // 取消长按计时器
          if (this.state.longPressTimer) {
            clearTimeout(this.state.longPressTimer);
            this.state.longPressTimer = null;
          }

          // 当拖动开始时，显示控制栏但不启动自动隐藏计时器
          if (this.showControlBar) {
            this.showControlBar();
          }
        }
      }
    }

    // 如果已经在单词滑动模式，处理单词切换
    if (this.state.isWordSwipe) {
      this.handleWordSwipe(deltaX);
      event.preventDefault();
      return;
    }

    // 如果已经在拖拽模式，更新进度
    if (this.state.isDragging) {
      this.updateDragProgress(deltaX);
      event.preventDefault();
      return;
    }

    // 如果已经在垂直滑动模式，检测是否触发字幕切换或场景切换
    if (this.state.isVerticalSwipe && !this.state.verticalSwipeTriggered) {
      if (Math.abs(deltaY) > this.VERTICAL_SWIPE_THRESHOLD) {
        this.state.verticalSwipeTriggered = true;

        // 如果增强字幕启用，切换字幕
        if (this.enhancedSubtitlesEnabled && this.subtitleCues.length > 0) {
          const currentIndex = this.getCurrentSubtitleIndex?.() ?? -1;
          const currentTime = this.player.currentTime() || 0;

          if (deltaY < 0) {
            // 上滑：下一个字幕
            const targetIndex = this.getNextSubtitleIndex(
              currentIndex,
              currentTime
            );
            if (targetIndex >= 0 && targetIndex < this.subtitleCues.length) {
              this.jumpToSubtitle(this.subtitleCues[targetIndex]);
            }
          } else {
            // 下滑：上一个字幕
            const targetIndex = this.getPreviousSubtitleIndex(
              currentIndex,
              currentTime
            );
            if (targetIndex >= 0) {
              this.jumpToSubtitle(this.subtitleCues[targetIndex]);
            }
          }
        } else {
          // 如果没有字幕，切换场景（上一首/下一首）
          if (deltaY < 0) {
            // 上滑：下一个场景
            this.onNextScene?.();
          } else {
            // 下滑：上一个场景
            this.onPreviousScene?.();
          }
        }
      }
      event.preventDefault();
      return;
    }

    // 如果移动距离过大且不在长按状态，取消长按
    if (this.state.longPressTimer && !this.state.isLongPress && distance > 20) {
      clearTimeout(this.state.longPressTimer);
      this.state.longPressTimer = null;
    }
  }

  private handleSingleTap(): void {
    // 如果在选词模式，单击触发单词选择
    if (this.isInWordNavigationMode?.()) {
      this.handleWordSelection?.();
      return;
    }

    if (this.player.paused()) {
      this.player.play()?.catch(() => {});
    } else {
      this.player.pause();
    }
  }

  private handleDoubleTap(x: number): void {
    // 如果增强字幕已启用，处理字幕相关操作
    if (this.enhancedSubtitlesEnabled && this.subtitleCues.length > 0) {
      const currentIndex = this.getCurrentSubtitleIndex?.() ?? -1;
      const currentTime = this.player.currentTime() || 0;
      const nearestIndex = this.findNearestCueIndex(
        currentTime,
        this.subtitleCues,
        currentIndex
      );

      // 检查是否有当前字幕（currentIndex 为 -1 表示没有当前字幕）
      if (
        currentIndex === -1 &&
        nearestIndex >= 0 &&
        nearestIndex < this.subtitleCues.length
      ) {
        // 没有当前字幕，播放上一个字幕
        if (nearestIndex > 0) {
          this.jumpToSubtitle(this.subtitleCues[nearestIndex - 1]);
          return;
        } else if (nearestIndex === 0) {
          // 如果 nearestIndex 为 0，说明在第一个字幕之前，直接播放第一个字幕
          this.jumpToSubtitle(this.subtitleCues[0]);
          return;
        }
      } else if (
        currentIndex >= 0 &&
        nearestIndex >= 0 &&
        nearestIndex < this.subtitleCues.length
      ) {
        // 有当前字幕，重播当前字幕
        this.jumpToSubtitle(this.subtitleCues[nearestIndex]);
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

  private handleTripleTap(x: number): void {
    // 三连击仅在增强字幕启用时生效
    if (!this.enhancedSubtitlesEnabled || this.subtitleCues.length === 0) {
      return;
    }

    const currentIndex = this.getCurrentSubtitleIndex?.() ?? -1;
    const currentTime = this.player.currentTime() || 0;

    const playerEl = this.player.el() as HTMLElement;
    const videoWidth = playerEl?.offsetWidth || 0;
    const isLeftSide = x < videoWidth / 2;

    if (isLeftSide) {
      // 左侧三连击：播放上一个字幕
      const targetIndex = this.getPreviousSubtitleIndex(
        currentIndex,
        currentTime
      );
      if (targetIndex >= 0) {
        this.jumpToSubtitle(this.subtitleCues[targetIndex]);
      }
    } else {
      // 右侧三连击：播放下一个字幕
      const targetIndex = this.getNextSubtitleIndex(currentIndex, currentTime);
      if (targetIndex >= 0 && targetIndex < this.subtitleCues.length) {
        this.jumpToSubtitle(this.subtitleCues[targetIndex]);
      }
    }
  }

  private handleContinuousSeek(x: number): void {
    const playerEl = this.player.el() as HTMLElement;
    const videoWidth = playerEl?.offsetWidth || 0;
    const isLeftSide = x < videoWidth / 2;

    // 确定本次点击的快进/快退方向
    // 注意：这里简化处理，如果中途改变点击方向，会从当前累积值继续加减
    // 例如：先右点两次(+10)，再左点一次(-5)，总计(+5)
    const seekStep = isLeftSide
      ? -this.CONTINUOUS_SEEK_STEP
      : this.CONTINUOUS_SEEK_STEP;

    // 累积快进/快退时间
    // 如果是第2次点击（双击），起始值为 seekStep * 1 (即 5s 或 -5s)
    // 如果 tapCount > 2，则在原有基础上增加 seekStep
    if (this.state.tapCount === 2) {
      this.state.continuousSeekTotal = seekStep;
    } else {
      this.state.continuousSeekTotal += seekStep;
    }

    // 执行跳转
    this.seekRelative(seekStep);

    // 显示反馈
    this.showSeekFeedback(this.state.continuousSeekTotal);
  }

  private showSeekFeedback(totalSeconds: number): void {
    if (!this.seekFeedbackElement) {
      this.createSeekFeedbackElement();
    }

    if (this.seekFeedbackElement) {
      const absSeconds = Math.abs(totalSeconds);
      const directionText = totalSeconds > 0 ? "快进" : "快退";
      const sign = totalSeconds > 0 ? "+" : "-";

      this.seekFeedbackElement.textContent = `${directionText} ${sign}${absSeconds}s`;
      this.seekFeedbackElement.classList.add("visible");

      // 移除可能存在的自动隐藏计时器（由连续点击逻辑控制隐藏）
      if (this.state.seekFeedbackTimer) {
        clearTimeout(this.state.seekFeedbackTimer);
        this.state.seekFeedbackTimer = null;
      }
    }
  }

  private removeSeekFeedback(): void {
    if (this.seekFeedbackElement) {
      this.seekFeedbackElement.classList.remove("visible");
    }

    if (this.state.seekFeedbackTimer) {
      clearTimeout(this.state.seekFeedbackTimer);
      this.state.seekFeedbackTimer = null;
    }
  }

  private createSeekFeedbackElement(): void {
    const playerEl = this.player.el();
    if (!playerEl) return;

    this.seekFeedbackElement = document.createElement("div");
    this.seekFeedbackElement.className = "mobile-seek-feedback";
    this.seekFeedbackElement.textContent = "";

    playerEl.appendChild(this.seekFeedbackElement);
  }

  private handleLongPress(): void {
    // 长按：启动倍速控制模式
    // 如果保存的倍速 < 1x（慢放模式），长按时恢复到 1x
    // 如果保存的倍速 >= 1x（快进模式），长按时使用保存的倍速
    try {
      this.state.originalPlaybackRate = this.player.playbackRate() || 1;
      this.state.isLongPress = true;
      this.state.isLongPressSpeedControl = true;

      // 保存长按开始的Y坐标，用于后续的垂直滑动检测
      this.state.longPressStartY = this.state.dragStartY;

      // 根据保存的倍速决定长按时的初始倍速
      if (this.state.savedSpeedRate < 1) {
        // 慢放模式：长按时恢复到 1x 正常速度
        this.state.currentSpeedRate = 1;
      } else {
        // 快进模式：长按时使用保存的默认倍速
        this.state.currentSpeedRate = this.state.savedSpeedRate;
      }
      this.player.playbackRate(this.state.currentSpeedRate);

      // 长按时立即显示当前倍速，且阻止自动隐藏
      this.showSpeedFeedback(this.state.currentSpeedRate, true);

      // 确保视频在播放状态
      if (this.player.paused()) {
        this.player.play()?.catch(() => {
          // 忽略播放失败
        });
      }
    } catch {
      // 忽略错误
    }
  }

  private seekRelative(seconds: number): void {
    const currentTime = this.player.currentTime() || 0;
    const duration = this.player.duration() || 0;
    const newTime = Math.max(0, Math.min(currentTime + seconds, duration));
    this.player.currentTime(newTime);
  }

  private updateDragProgress(deltaX: number): void {
    const duration = this.player.duration() || 0;
    if (duration === 0) return;

    // 单手优化算法：连续非线性映射（纯幂函数）
    // 移除分段逻辑，消除临界点突兀感，提供一致的"越滑越快"手感
    const sign = Math.sign(deltaX);
    const absDelta = Math.abs(deltaX);

    // 参数配置
    // DAMPING (阻尼系数): 类似于"摩擦力"，值越大越难滑
    // EXPONENT (指数): 决定加速的猛烈程度，2.4 提供了平滑的起步和强劲的后劲
    const DAMPING = 18;
    const EXPONENT = 2.4;

    // 核心公式：(距离 / 阻尼) ^ 指数
    // 20px -> ~1.3s
    // 50px -> ~11s
    // 100px -> ~60s
    // 200px -> ~318s (5分半)
    // 300px -> ~840s (14分钟)
    let seekSeconds = Math.pow(absDelta / DAMPING, EXPONENT);

    // 安全限制：单次滑动最大不超过视频时长的 75% 或 45分钟
    const maxSeek = Math.min(duration * 0.75, 2700);
    seekSeconds = Math.min(seekSeconds, maxSeek);

    const progressDelta = sign * seekSeconds;
    const newProgress = Math.max(
      0,
      Math.min(this.state.dragStartTime + progressDelta, duration)
    );

    this.state.dragCurrentProgress = newProgress;

    // 实时更新进度条和时间显示的视觉反馈
    this.updateVisualFeedback(newProgress);
  }

  private handleDragEnd(): void {
    if (!this.state.isDragging) return;

    // 由于视频时间已经在拖拽过程中实时更新，这里不需要重复设置
    // 只需要恢复播放状态和重置视觉反馈

    // 清除拖动模式标志
    this.isDraggingMode = false;

    // 恢复原始的 reportUserActivity
    if (this.originalReportUserActivity) {
      (this.player as VideoJsPlayer).reportUserActivity =
        this.originalReportUserActivity;
      this.originalReportUserActivity = null;
    }

    // 恢复原始播放状态和静音状态
    if (this.state.wasPlayingBeforeDrag) {
      // 先确保静音状态正确，再播放
      this.player.muted(this.state.wasMutedBeforeDrag);
      this.player.play()?.catch(() => {
        // 忽略播放失败
      });
    }

    // 重置视觉反馈
    this.resetVisualFeedback();

    // 在拖动结束时，启动控制栏的自动隐藏计时器
    // 这会触发用户活动，让Video.js启动自动隐藏计时器
    if (this.enhancedSubtitlesEnabled && this.showControlBar) {
      // 重新调用 showControlBar 来启动自动隐藏计时器（它会设置2秒后自动隐藏并重新锁定）
      this.showControlBar();
    } else if (this.enhancedSubtitlesEnabled) {
      // 如果没有 showControlBar 回调，但我们修改了 reportUserActivity，需要重新锁定控制栏
      const playerEl = this.player.el();
      if (playerEl) {
        // 2秒后重新锁定控制栏
        setTimeout(() => {
          if (playerEl && this.enhancedSubtitlesEnabled) {
            playerEl.classList.remove("vjs-controls-unlocked-once");
            playerEl.classList.add("vjs-controls-locked-hidden");
            this.player.userActive(false);
          }
        }, 2000);
      }
    }

    // 重置拖拽状态
    this.state.isDragging = false;
    this.state.dragCurrentProgress = 0;
    this.state.wasPlayingBeforeDrag = false;
  }

  private updateVisualFeedback(currentProgress: number): void {
    try {
      // 更新视频的实际时间位置
      // 注意：在拖动过程中，currentTime 的更新可能会触发 Video.js 的用户活动检测
      // 但我们通过修改 reportUserActivity 来阻止这个行为
      const videoElement = this.player
        .el()
        .querySelector("video") as HTMLVideoElement;
      if (videoElement) {
        videoElement.currentTime = currentProgress;
      }

      // 手动触发 timeupdate 事件，让进度条更新，但不触发用户活动（通过 reportUserActivity 拦截）
      try {
        if (videoElement && videoElement.readyState >= 2) {
          // 直接触发timeupdate事件，但由于我们修改了 reportUserActivity，它不会重置自动隐藏计时器
          this.player.trigger("timeupdate");
        }
      } catch {
        // 忽略错误
      }

      // 为拖拽状态添加视觉样式
      const playerEl = this.player.el();
      if (!playerEl.classList.contains("vjs-touch-seeking")) {
        playerEl.classList.add("vjs-touch-seeking");
      }
    } catch {
      // 忽略错误
    }
  }

  private resetVisualFeedback(): void {
    try {
      // 移除拖拽状态的视觉样式
      const playerEl = this.player.el();
      if (playerEl.classList.contains("vjs-touch-seeking")) {
        playerEl.classList.remove("vjs-touch-seeking");
      }
    } catch {
      // 忽略错误
    }
  }

  private formatTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, "0")}:${secs
        .toString()
        .padStart(2, "0")}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, "0")}`;
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
      .mobile-speed-feedback,
      .mobile-seek-feedback {
        position: absolute;
        top: 3%;
        left: 50%;
        transform: translate(-50%, 0);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 8px 16px;
        border-radius: 8px;
        font-size: 16px;
        font-weight: bold;
        z-index: 1000;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
        user-select: none;
        font-family: system-ui, -apple-system, sans-serif;
      }
      
      .mobile-speed-feedback.visible,
      .mobile-seek-feedback.visible {
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
      window.removeEventListener(
        "orientationchange",
        this.boundOrientationChange
      );
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

    // 清理快进/快退反馈元素
    if (this.seekFeedbackElement && this.seekFeedbackElement.parentNode) {
      this.seekFeedbackElement.parentNode.removeChild(this.seekFeedbackElement);
      this.seekFeedbackElement = null;
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
    // 总是重置到1x正常播放速度
    const currentRate = this.player.playbackRate() || 1;
    if (currentRate !== 1) {
      this.player.playbackRate(1);
      this.state.isLongPress = false;
      this.state.isLongPressSpeedControl = false;
      this.state.currentSpeedRate = 1;
    }
  }

  // 公共方法：设置增强字幕状态
  public setEnhancedSubtitlesEnabled(enabled: boolean): void {
    this.enhancedSubtitlesEnabled = enabled;
  }

  // 公共方法：设置字幕列表
  public setSubtitleCues(
    cues: Array<{ startTime: number; endTime: number; text: string }>
  ): void {
    this.subtitleCues = cues;
  }

  // 公共方法：设置获取当前字幕索引的回调函数
  public setGetCurrentSubtitleIndex(callback: () => number): void {
    this.getCurrentSubtitleIndex = callback;
  }

  // 公共方法：设置显示控制栏的回调函数
  public setShowControlBar(callback: () => void): void {
    this.showControlBar = callback;
  }

  // 公共方法：设置下一个场景的回调函数
  public setOnNextScene(callback: () => void): void {
    this.onNextScene = callback;
  }

  // 公共方法：设置上一个场景的回调函数
  public setOnPreviousScene(callback: () => void): void {
    this.onPreviousScene = callback;
  }

  // 公共方法：设置单词导航回调函数
  public setWordNavigationCallbacks(callbacks: {
    navigateToNextWord: () => void;
    navigateToPreviousWord: () => void;
    enterWordNavigationMode: (selectLastWord?: boolean) => void;
    exitWordNavigationMode: () => void;
    handleWordSelection: () => Promise<void>;
    isInWordNavigationMode: () => boolean;
  }): void {
    this.navigateToNextWord = callbacks.navigateToNextWord;
    this.navigateToPreviousWord = callbacks.navigateToPreviousWord;
    this.enterWordNavigationMode = callbacks.enterWordNavigationMode;
    this.exitWordNavigationMode = callbacks.exitWordNavigationMode;
    this.handleWordSelection = callbacks.handleWordSelection;
    this.isInWordNavigationMode = callbacks.isInWordNavigationMode;
  }
}

// 注册插件
videojs.registerPlugin("mobileTouchControls", function (this: VideoJsPlayer) {
  // 如果已经存在插件实例，先销毁它
  if (
    (
      this as VideoJsPlayer & {
        _mobileTouchControlsPlugin?: MobileTouchControlsPlugin;
      }
    )._mobileTouchControlsPlugin
  ) {
    (
      (
        this as VideoJsPlayer & {
          _mobileTouchControlsPlugin?: MobileTouchControlsPlugin;
        }
      )._mobileTouchControlsPlugin as MobileTouchControlsPlugin
    ).dispose();
  }

  // 创建新的插件实例并保存引用
  (
    this as VideoJsPlayer & {
      _mobileTouchControlsPlugin?: MobileTouchControlsPlugin;
    }
  )._mobileTouchControlsPlugin = new MobileTouchControlsPlugin(this);
});

export default MobileTouchControlsPlugin;
