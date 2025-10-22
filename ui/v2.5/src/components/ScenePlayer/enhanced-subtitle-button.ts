import videojs from "video.js";
import "./enhanced-subtitle-button.scss";

const Button = videojs.getComponent("Button");

interface EnhancedSubtitleButtonOptions {
  onToggle?: (enabled: boolean) => void;
}

class EnhancedSubtitleButton extends Button {
  private subtitlesEnabled: boolean = false;
  private toggleCallback?: (enabled: boolean) => void;

  constructor(player: videojs.Player, options: EnhancedSubtitleButtonOptions = {}) {
    super(player, options);
    this.toggleCallback = options.onToggle;
    this.controlText("增强字幕");
    this.addClass("vjs-enhanced-subtitles-button");
    this.updateIcon();
  }

  buildCSSClass() {
    return `vjs-enhanced-subtitles-button ${super.buildCSSClass()}`;
  }

  handleClick() {
    this.subtitlesEnabled = !this.subtitlesEnabled;
    this.updateIcon();
    
    if (this.toggleCallback) {
      this.toggleCallback(this.subtitlesEnabled);
    }
  }

  updateIcon() {
    // 切换启用状态的类
    if (this.subtitlesEnabled) {
      this.addClass("subtitles-enabled");
    } else {
      this.removeClass("subtitles-enabled");
    }
  }

  setEnabled(enabled: boolean) {
    this.subtitlesEnabled = enabled;
    this.updateIcon();
  }

  isEnabled() {
    return this.subtitlesEnabled;
  }
}

// 注册组件
videojs.registerComponent("EnhancedSubtitleButton", EnhancedSubtitleButton);

// 定义插件
function enhancedSubtitleButton(this: videojs.Player, options: EnhancedSubtitleButtonOptions = {}) {
  const player = this;
  
  // 创建按钮
  const button = new EnhancedSubtitleButton(player, options);
  
  // 添加到控制栏，放在字幕按钮的位置
  const controlBar = player.getChild("ControlBar");
  if (controlBar) {
    // 尝试在全屏按钮之前插入
    const fullscreenToggle = controlBar.getChild("FullscreenToggle");
    if (fullscreenToggle) {
      controlBar.addChild(button, {}, controlBar.children().indexOf(fullscreenToggle));
    } else {
      controlBar.addChild(button);
    }
  }

  return button;
}

// 注册插件
videojs.registerPlugin("enhancedSubtitleButton", enhancedSubtitleButton);

// 扩展类型定义
declare module "video.js" {
  export interface VideoJsPlayer {
    enhancedSubtitleButton: (options?: EnhancedSubtitleButtonOptions) => EnhancedSubtitleButton;
  }
}

export default enhancedSubtitleButton;
export { EnhancedSubtitleButton };

