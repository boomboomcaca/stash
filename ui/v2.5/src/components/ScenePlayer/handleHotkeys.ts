import { VideoJsPlayer } from "video.js";
import { togglePseudoFullscreen } from "./util";
import { IEnhancedSubtitleNavigation } from "./types";

export function handleHotkeys(
  player: VideoJsPlayer,
  event: KeyboardEvent,
  toggleEnhancedSubtitles?: () => void,
  resetSubtitleFontSize?: () => void,
  showControlBar?: () => void,
  enhancedSubtitleNavigation?: IEnhancedSubtitleNavigation,
  isControlBarVisible?: () => boolean,
  hideControlBar?: () => void
) {
  function seekStep(step: number) {
    const time = player.currentTime() + step;
    const duration = player.duration();
    if (time < 0) {
      player.currentTime(0);
    } else if (time < duration) {
      player.currentTime(time);
    } else {
      player.currentTime(duration);
    }

    // 当调整播放进度时，如果增强字幕已开启，显示控制栏
    if (showControlBar) {
      showControlBar();
    }
  }

  function seekPercent(percent: number) {
    const duration = player.duration();
    const time = duration * percent;
    player.currentTime(time);
  }

  function seekPercentRelative(percent: number) {
    const duration = player.duration();
    const currentTime = player.currentTime();
    const time = currentTime + duration * percent;
    if (time > duration) return;
    player.currentTime(time);
  }

  function toggleABLooping() {
    const opts = player.abLoopPlugin.getOptions();
    if (!opts.start) {
      opts.start = player.currentTime();
    } else if (!opts.end) {
      opts.end = player.currentTime();
      opts.enabled = true;
    } else {
      opts.start = 0;
      opts.end = 0;
      opts.enabled = false;
    }
    player.abLoopPlugin.setOptions(opts);
  }

  // Check if control bar is visible
  const controlBarVisible = isControlBarVisible ? isControlBarVisible() : false;

  // Handle ESC key to hide control bar when it's visible
  if (event.which === 27) {
    // If not in word navigation mode and auto-paused, resume playback
    if (
      !enhancedSubtitleNavigation?.isInWordNavigationMode &&
      enhancedSubtitleNavigation?.isAutoPaused &&
      enhancedSubtitleNavigation?.resumePlayback
    ) {
      event.preventDefault();
      event.stopPropagation();
      enhancedSubtitleNavigation.resumePlayback();
      return;
    }

    if (
      controlBarVisible &&
      hideControlBar &&
      !enhancedSubtitleNavigation?.isInWordNavigationMode
    ) {
      event.preventDefault();
      event.stopPropagation();
      hideControlBar();
      return;
    }
  }

  // Handle enhanced subtitle navigation
  if (enhancedSubtitleNavigation && !controlBarVisible) {
    // Enter word navigation mode with left/right arrows when enhanced subtitles are active
    // and control bar is not visible
    if (
      !enhancedSubtitleNavigation.isInWordNavigationMode &&
      (event.which === 37 || event.which === 39)
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (enhancedSubtitleNavigation.enterWordNavigationMode) {
        // Left arrow (37) selects last word, right arrow (39) selects first word
        const selectLastWord = event.which === 37;
        enhancedSubtitleNavigation.enterWordNavigationMode(selectLastWord);
      }
      return;
    }

    // Handle word navigation mode
    if (enhancedSubtitleNavigation.isInWordNavigationMode) {
      switch (event.which) {
        case 37: // left arrow - navigate to previous word
          event.preventDefault();
          event.stopPropagation();
          if (enhancedSubtitleNavigation.navigateToPreviousWord) {
            enhancedSubtitleNavigation.navigateToPreviousWord();
          }
          return;
        case 39: // right arrow - navigate to next word
          event.preventDefault();
          event.stopPropagation();
          if (enhancedSubtitleNavigation.navigateToNextWord) {
            enhancedSubtitleNavigation.navigateToNextWord();
          }
          return;
        case 27: // ESC - exit word navigation mode
          event.preventDefault();
          event.stopPropagation();
          if (enhancedSubtitleNavigation.exitWordNavigationMode) {
            enhancedSubtitleNavigation.exitWordNavigationMode();
          }
          return;
        case 13: // Enter/OK - lookup selected word
          event.preventDefault();
          event.stopPropagation();
          if (enhancedSubtitleNavigation.handleWordSelection) {
            enhancedSubtitleNavigation.handleWordSelection();
          }
          return;
        case 38: // up arrow - exit word navigation mode and toggle play/pause
          event.preventDefault();
          event.stopPropagation();
          if (enhancedSubtitleNavigation.exitWordNavigationMode) {
            enhancedSubtitleNavigation.exitWordNavigationMode();
          }
          // Toggle play/pause after exiting word navigation mode
          if (player.paused()) {
            player.play();
          } else {
            player.pause();
          }
          return;
        case 40: // down arrow - handle in code below
          // Will be handled below
          break;
      }
    }
  }

  // Handle normal seek when control bar is visible or enhanced subtitles not active
  let seekFactor = 10;
  if (event.shiftKey) {
    seekFactor = 5;
  } else if (event.ctrlKey || event.altKey) {
    seekFactor = 60;
  }
  switch (event.which) {
    case 39: // right arrow
      seekStep(seekFactor);
      break;
    case 37: // left arrow
      seekStep(-seekFactor);
      break;
  }

  // toggle player looping with shift+l
  if (event.shiftKey && event.which === 76) {
    player.loop(!player.loop());
    return;
  }

  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return;
  }

  const skipButtons = player.skipButtons();
  if (skipButtons) {
    // handle multimedia keys
    switch (event.key) {
      case "MediaTrackNext":
        if (!skipButtons.onNext) return;
        skipButtons.onNext();
        break;
      case "MediaTrackPrevious":
        if (!skipButtons.onPrevious) return;
        skipButtons.onPrevious();
        break;
      // MediaPlayPause handled by videojs
    }
  }

  switch (event.which) {
    case 32: // space
      if (enhancedSubtitleNavigation?.isInWordNavigationMode) {
        // In word navigation mode, space key should lookup selected word
        event.preventDefault();
        event.stopPropagation();
        if (enhancedSubtitleNavigation.handleWordSelection) {
          enhancedSubtitleNavigation.handleWordSelection();
        }
        break;
      }
      // Otherwise, normal play/pause
      if (player.paused()) player.play();
      else player.pause();
      break;
    case 13: // enter
      if (enhancedSubtitleNavigation?.isInWordNavigationMode) {
        // In word navigation mode, enter should lookup selected word
        event.preventDefault();
        event.stopPropagation();
        if (enhancedSubtitleNavigation.handleWordSelection) {
          enhancedSubtitleNavigation.handleWordSelection();
        }
        break;
      }
      // Otherwise, normal play/pause
      if (player.paused()) player.play();
      else player.pause();
      break;
    case 77: // m
      player.muted(!player.muted());
      break;
    case 70: // f
      togglePseudoFullscreen(player);
      break;
    case 76: // l
      toggleABLooping();
      break;
    case 38: // up arrow
      if (enhancedSubtitleNavigation) {
        // Handle single/double press for up arrow
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        const lastPress = player._lastUpArrowPress || 0;
        const timeSinceLastPress = now - lastPress;

        // Clear any pending single-click timer
        if (player._upArrowTimer) {
          clearTimeout(player._upArrowTimer);
          player._upArrowTimer = null;
        }

        if (timeSinceLastPress < 400 && timeSinceLastPress > 0) {
          // Double up arrow - go to next subtitle
          const currentCueIndex =
            enhancedSubtitleNavigation.getCurrentCueIndex?.() ?? -1;
          const videoTime =
            enhancedSubtitleNavigation.onGetPlayer?.().currentTime() ?? 0;
          const cues = enhancedSubtitleNavigation.parsedSubtitles?.cues;

          if (cues && cues.length > 0) {
            let targetIndex: number;

            if (currentCueIndex >= 0) {
              // Currently showing a subtitle, go to next one
              targetIndex = currentCueIndex + 1;
            } else {
              // Not showing any subtitle, find the next upcoming subtitle
              targetIndex = -1;
              for (let i = 0; i < cues.length; i++) {
                if (videoTime < cues[i].startTime) {
                  targetIndex = i;
                  break;
                }
              }
              // If no upcoming subtitle found, stay at current position
              if (targetIndex === -1) {
                targetIndex = cues.length; // This will skip the jump
              }
            }

            if (targetIndex >= 0 && targetIndex < cues.length) {
              const navPlayer = enhancedSubtitleNavigation.onGetPlayer?.();
              if (navPlayer) {
                const nextCue = cues[targetIndex];
                if (nextCue) {
                  navPlayer.currentTime(nextCue.startTime);
                  // Resume playback if paused
                  if (navPlayer.paused()) {
                    navPlayer.play();
                  }
                }
              }
            }
          }
          player._lastUpArrowPress = 0;
        } else {
          // Single up arrow - toggle play/pause (will trigger after timeout)
          player._lastUpArrowPress = now;

          player._upArrowTimer = setTimeout(() => {
            // Only execute if this is still a single press (not a double press)
            const checkTime = Date.now();
            const timeSincePress = checkTime - (player._lastUpArrowPress || 0);

            if (timeSincePress >= 400 && player._lastUpArrowPress !== 0) {
              // This was a single press, not a double press
              if (player.paused()) {
                player.play();
              } else {
                player.pause();
              }
            }
            player._lastUpArrowPress = 0;
            player._upArrowTimer = null;
          }, 400);
        }
        return;
      }
      player.volume(player.volume() + 0.1);
      break;
    case 40: // down arrow
      if (enhancedSubtitleNavigation) {
        // Down arrow: single press to repeat current subtitle, double press to go to previous subtitle
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        const lastPress = player._lastDownArrowPress || 0;
        const timeSinceLastPress = now - lastPress;

        // Clear any pending single-click timer
        if (player._downArrowTimer) {
          clearTimeout(player._downArrowTimer);
          player._downArrowTimer = null;
        }

        if (timeSinceLastPress < 400 && timeSinceLastPress > 0) {
          // Double down arrow - go to previous subtitle
          const currentCueIndex =
            enhancedSubtitleNavigation.getCurrentCueIndex?.() ?? -1;
          const videoTime =
            enhancedSubtitleNavigation.onGetPlayer?.().currentTime() ?? 0;
          const cues = enhancedSubtitleNavigation.parsedSubtitles?.cues;

          if (cues && cues.length > 0) {
            let targetIndex: number;

            if (currentCueIndex >= 0) {
              // Currently showing a subtitle, go to previous one
              targetIndex = currentCueIndex - 1;
            } else {
              // Not showing any subtitle, find the last subtitle that has ended
              targetIndex = -1;
              for (let i = cues.length - 1; i >= 0; i--) {
                if (videoTime > cues[i].endTime) {
                  targetIndex = i;
                  break;
                }
              }
              // If we're before all subtitles, no previous to go to
            }

            if (targetIndex >= 0 && targetIndex < cues.length) {
              const navPlayer = enhancedSubtitleNavigation.onGetPlayer?.();
              if (navPlayer) {
                const prevCue = cues[targetIndex];
                if (prevCue) {
                  navPlayer.currentTime(prevCue.startTime);
                  // Resume playback if paused
                  if (navPlayer.paused()) {
                    navPlayer.play();
                  }
                }
              }
            }
          }
          player._lastDownArrowPress = 0;
        } else {
          // Single down arrow - repeat current subtitle
          player._lastDownArrowPress = now;

          player._downArrowTimer = setTimeout(() => {
            // Only execute if this is still a single press (not a double press)
            const checkTime = Date.now();
            const timeSincePress =
              checkTime - (player._lastDownArrowPress || 0);

            if (timeSincePress >= 400 && player._lastDownArrowPress !== 0) {
              // This was a single press, not a double press
              const currentCueIndex =
                enhancedSubtitleNavigation?.getCurrentCueIndex?.() ?? -1;
              const videoTime =
                enhancedSubtitleNavigation?.onGetPlayer?.().currentTime() ?? 0;
              const cues = enhancedSubtitleNavigation?.parsedSubtitles?.cues;

              if (cues && cues.length > 0) {
                let targetIndex: number;

                if (currentCueIndex >= 0) {
                  // Currently showing a subtitle, repeat it
                  targetIndex = currentCueIndex;
                } else {
                  // Not showing any subtitle, go to previous subtitle
                  targetIndex = -1;
                  for (let i = cues.length - 1; i >= 0; i--) {
                    if (videoTime > cues[i].endTime) {
                      targetIndex = i;
                      break;
                    }
                  }
                }

                if (targetIndex >= 0 && targetIndex < cues.length) {
                  const targetCue = cues[targetIndex];
                  if (targetCue) {
                    const navPlayer =
                      enhancedSubtitleNavigation.onGetPlayer?.();
                    if (navPlayer) {
                      navPlayer.currentTime(targetCue.startTime);
                      // Resume playback if paused
                      if (navPlayer.paused()) {
                        navPlayer.play();
                      }
                    }
                  }
                }
              }
            }
            player._lastDownArrowPress = 0;
            player._downArrowTimer = null;
          }, 400);
        }
        return;
      }
      player.volume(player.volume() - 0.1);
      break;
    case 48: // 0
      player.currentTime(0);
      break;
    case 49: // 1
      seekPercent(0.1);
      break;
    case 50: // 2
      seekPercent(0.2);
      break;
    case 51: // 3
      seekPercent(0.3);
      break;
    case 52: // 4
      seekPercent(0.4);
      break;
    case 53: // 5
      seekPercent(0.5);
      break;
    case 54: // 6
      seekPercent(0.6);
      break;
    case 55: // 7
      seekPercent(0.7);
      break;
    case 56: // 8
      seekPercent(0.8);
      break;
    case 57: // 9
      seekPercent(0.9);
      break;
    case 221: // ]
      seekPercentRelative(0.1);
      break;
    case 219: // [
      seekPercentRelative(-0.1);
      break;
    case 67: // c
      // Toggle enhanced subtitles with 'c' key
      if (toggleEnhancedSubtitles) {
        toggleEnhancedSubtitles();
      }
      break;
    case 82: // r
      // Reset subtitle font size with 'r' key
      if (resetSubtitleFontSize) {
        resetSubtitleFontSize();
      }
      break;
  }
}
