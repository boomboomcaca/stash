import * as GQL from "src/core/generated-graphql";
import { VideoJsPlayer } from "video.js";

export type MarkerFragment = Pick<GQL.SceneMarker, "title" | "seconds"> & {
  primary_tag: Pick<GQL.Tag, "name">;
  tags: Array<Pick<GQL.Tag, "name">>;
};

export function getMarkerTitle(marker: MarkerFragment) {
  if (marker.title) {
    return marker.title;
  }

  let ret = marker.primary_tag.name;
  if (marker.tags.length) {
    ret += `, ${marker.tags.map((t) => t.name).join(", ")}`;
  }

  return ret;
}

export interface IScenePlayerProps {
  scene: GQL.SceneDataFragment;
  hideScrubberOverride: boolean;
  autoplay?: boolean;
  permitLoop?: boolean;
  initialTimestamp: number;
  sendSetTimestamp: (setTimestamp: (value: number) => void) => void;
  onComplete: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

// Enhanced Subtitle Navigation Interface
export interface IEnhancedSubtitleNavigation {
  isInWordNavigationMode: boolean;
  isAutoPaused: boolean;
  resumePlayback?: () => void;
  enterWordNavigationMode?: (selectLastWord: boolean) => void;
  exitWordNavigationMode?: () => void;
  getCurrentCueIndex?: () => number;
  onGetPlayer?: () => VideoJsPlayer;
  parsedSubtitles?: {
    cues: Array<{ startTime: number; endTime: number; text: string }>;
  };
  navigateToNextWord?: () => void;
  navigateToPreviousWord?: () => void;
  handleWordSelection?: () => void;
}

// Mobile Touch Controls Plugin Interface
export interface IMobileTouchControlsPlugin {
  setEnhancedSubtitlesEnabled(enabled: boolean): void;
  setSubtitleCues(
    cues: Array<{ startTime: number; endTime: number; text: string }>
  ): void;
  setGetCurrentSubtitleIndex(fn: () => number): void;
  setShowControlBar(fn: () => void): void;
}

// Extend VideoJsPlayer type with custom properties and methods
declare module "video.js" {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  interface VideoJsPlayer {
    // Custom properties for state management
    _lastUpArrowPress?: number;
    _upArrowTimer?: number | null;
    _lastDownArrowPress?: number;
    _downArrowTimer?: number | null;

    // Internal methods that are not in official type definitions
    // Note: VideoJS has this as a method, we're extending the interface
    // Must match the exact signature from VideoJS to avoid conflicts
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    reportUserActivity: (event: any) => void;

    // Custom plugins
    _mobileTouchControlsPlugin?: IMobileTouchControlsPlugin;
  }
}
