import videojs from "video.js";

// 获取VideoJS的PlaybackRateMenuButton组件
const PlaybackRateMenuButton = videojs.getComponent("PlaybackRateMenuButton");

// 仅在组件存在时定义和注册自定义组件
let CustomPlaybackRateMenuButton: typeof PlaybackRateMenuButton | undefined;

if (PlaybackRateMenuButton) {
  // 自定义播放速度菜单按钮，在触摸设备上点击时显示菜单而不是切换速度
  class CustomPlaybackRateMenuButtonImpl extends PlaybackRateMenuButton {
    handleClick(event: videojs.EventTarget.Event) {
      // 检查是否是触摸设备
      const isTouchDevice =
        typeof window !== "undefined" &&
        ("ontouchstart" in window ||
          (typeof navigator !== "undefined" &&
            navigator.maxTouchPoints &&
            navigator.maxTouchPoints > 0));

      // 在触摸设备上，始终显示菜单而不是切换速度
      // VideoJS的MenuButton在移动设备上默认会切换选项而不是显示菜单
      // 我们覆盖这个行为，让它总是显示菜单
      if (isTouchDevice) {
        // 触摸设备：显示菜单
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        const self = this as any;
        if (self.menu && typeof self.menu.hasClass === "function") {
          if (self.menu.hasClass("vjs-lock-showing")) {
            // 如果菜单已经打开，关闭它
            self.unpressButton();
          } else {
            // 如果菜单未打开，打开它
            self.pressButton();
          }
        }
        // 阻止默认的切换行为
        // videojs.EventTarget.Event 可能包装了原生事件，尝试访问原始事件
        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        const nativeEvent = (event as any)?.originalEvent || (event as any);
        if (nativeEvent && typeof nativeEvent.preventDefault === "function") {
          nativeEvent.preventDefault();
        }
        if (nativeEvent && typeof nativeEvent.stopPropagation === "function") {
          nativeEvent.stopPropagation();
        }
        return;
      }

      // 非触摸设备：使用默认行为（可能会切换）
      // @ts-ignore
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (super.handleClick as any)(event);
    }
  }

  CustomPlaybackRateMenuButton = CustomPlaybackRateMenuButtonImpl;

  // 注册自定义组件
  videojs.registerComponent(
    "PlaybackRateMenuButton",
    CustomPlaybackRateMenuButtonImpl
  );
} else {
  // console.warn("PlaybackRateMenuButton component not found, skipping custom implementation");
}

export default CustomPlaybackRateMenuButton;
