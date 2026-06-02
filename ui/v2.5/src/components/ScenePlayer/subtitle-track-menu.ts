/* eslint-disable @typescript-eslint/naming-convention */
import videojs from "video.js";
import "./subtitle-track-menu.scss";

// A control-bar dropdown that lists the enhanced-subtitle tracks available for
// the current scene and lets the user pick which one is loaded. The native
// subsCaps button is disabled (enhanced subtitles replace it), so this provides
// the missing manual track selection. Selecting an item calls onSelect with the
// chosen track; an empty value means "off".

export interface ISubtitleTrackOption {
  // unique track source url passed back to the player
  src: string;
  // ISO language code (e.g. "ja", "zh"); "00" means unknown
  lang: string;
  // human-readable label shown in the menu
  label: string;
}

interface ISubtitleTrackMenuOptions {
  onSelect?: (option: ISubtitleTrackOption | null) => void;
}

const MenuButton = videojs.getComponent("MenuButton");
const MenuItem = videojs.getComponent("MenuItem");

class SubtitleTrackMenuButton extends MenuButton {
  private trackOptions: ISubtitleTrackOption[] = [];
  private selectedSrc: string | null = null;
  private selectCallback?: (option: ISubtitleTrackOption | null) => void;

  constructor(player: videojs.Player, options: ISubtitleTrackMenuOptions = {}) {
    super(player, options as videojs.MenuButtonOptions);
    this.selectCallback = options.onSelect;
    this.addClass("vjs-subtitle-track-menu");
    this.controlText("Subtitle track");
    this.updateVisibility();
  }

  buildCSSClass() {
    return `vjs-subtitle-track-menu vjs-subs-caps-button ${super.buildCSSClass()}`;
  }

  // Build the menu items from the current track options.
  createItems() {
    const items: videojs.MenuItem[] = [];
    if (!this.trackOptions || this.trackOptions.length === 0) {
      return items;
    }

    // "Off" item
    const offItem = new MenuItem(this.player(), {
      label: this.localize("Off"),
      selectable: true,
      selected: this.selectedSrc === null,
    });
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    (offItem as any).handleClick = () => {
      this.selectTrack(null);
    };
    items.push(offItem);

    for (const opt of this.trackOptions) {
      const item = new MenuItem(this.player(), {
        label: opt.label,
        selectable: true,
        selected: this.selectedSrc === opt.src,
      });
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      (item as any).handleClick = () => {
        this.selectTrack(opt);
      };
      items.push(item);
    }
    return items;
  }

  private selectTrack(option: ISubtitleTrackOption | null) {
    this.selectedSrc = option ? option.src : null;
    if (this.selectCallback) {
      this.selectCallback(option);
    }
    this.update(); // rebuild items so the checkmark moves
  }

  // Called by the parent to feed in the scene's tracks.
  setTrackOptions(options: ISubtitleTrackOption[], selectedSrc: string | null) {
    this.trackOptions = options || [];
    this.selectedSrc = selectedSrc;
    this.update();
    this.updateVisibility();
  }

  // Keep external selection (e.g. auto-selected default) in sync.
  setSelected(selectedSrc: string | null) {
    this.selectedSrc = selectedSrc;
    this.update();
  }

  // Hide the button entirely when there are no tracks.
  private updateVisibility() {
    if (!this.trackOptions || this.trackOptions.length === 0) {
      this.addClass("vjs-hidden");
    } else {
      this.removeClass("vjs-hidden");
    }
  }
}

videojs.registerComponent("SubtitleTrackMenuButton", SubtitleTrackMenuButton);

function subtitleTrackMenu(
  this: videojs.Player,
  options: ISubtitleTrackMenuOptions = {}
) {
  const player = this;
  const button = new SubtitleTrackMenuButton(player, options);

  const controlBar = player.getChild("ControlBar");
  if (controlBar) {
    // place just before the enhanced-subtitle button / fullscreen toggle
    const anchor =
      controlBar.getChild("EnhancedSubtitleButton") ||
      controlBar.getChild("FullscreenToggle");
    if (anchor) {
      controlBar.addChild(button, {}, controlBar.children().indexOf(anchor));
    } else {
      controlBar.addChild(button);
    }
  }
  return button;
}

videojs.registerPlugin("subtitleTrackMenu", subtitleTrackMenu);

declare module "video.js" {
  interface VideoJsPlayer {
    subtitleTrackMenu(
      options?: ISubtitleTrackMenuOptions
    ): SubtitleTrackMenuButton;
  }
}

export { SubtitleTrackMenuButton };
