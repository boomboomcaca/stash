import videojs from "video.js";
import "./enhanced-subtitle-button.scss";

const Button = videojs.getComponent("Button");

interface EnhancedSubtitleButtonOptions {
  onToggle?: (enabled: boolean) => void;
}

class EnhancedSubtitleButton extends Button {
  private subtitlesEnabled: boolean = false;
  private toggleCallback?: (enabled: boolean) => void;
  private subtitlesAvailable: boolean = true;

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
    // 如果字幕不可用，阻止点击
    if (!this.subtitlesAvailable) {
      return;
    }

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
    
    // 更新禁用状态的类
    if (!this.subtitlesAvailable) {
      this.addClass("vjs-disabled");
      this.disable();
      // 强制设置 disabled 属性
      this.el().setAttribute('disabled', 'disabled');
      this.el().setAttribute('aria-disabled', 'true');
    } else {
      this.removeClass("vjs-disabled");
      this.enable();
      // 移除 disabled 属性
      this.el().removeAttribute('disabled');
      this.el().removeAttribute('aria-disabled');
    }
  }

  setEnabled(enabled: boolean) {
    this.subtitlesEnabled = enabled;
    this.updateIcon();
  }

  isEnabled() {
    return this.subtitlesEnabled;
  }

  // 设置字幕是否可用
  setSubtitlesAvailable(available: boolean) {
    this.subtitlesAvailable = available;
    // 如果字幕不可用，关闭字幕
    if (!available && this.subtitlesEnabled) {
      this.subtitlesEnabled = false;
      if (this.toggleCallback) {
        this.toggleCallback(false);
      }
    }
    this.updateIcon();
  }

  getSubtitlesAvailable() {
    return this.subtitlesAvailable;
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

