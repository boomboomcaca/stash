import { useEffect, useRef, useState } from "react";
import videojs, { VideoJsPlayer, VideoJsPlayerOptions } from "video.js";
import { VIDEO_PLAYER_ID, togglePseudoFullscreen, isPseudoFullscreen } from "./util";
import { handleHotkeys } from "./handleHotkeys";

interface IUsePlayerSetupProps {
  videoRef: React.RefObject<HTMLDivElement>;
  uiConfig: {
    showAbLoopControls?: boolean;
    [key: string]: unknown;
  };
  currentSubtitleTrack: string | null;
  showEnhancedSubtitles: boolean;
  setShowEnhancedSubtitles: (value: boolean) => void;
  setResetFontSizeTrigger: React.Dispatch<React.SetStateAction<number>>;
  temporarilyUnlockControlBarRef: React.MutableRefObject<(() => void) | null>;
  enhancedSubtitleNavigationRef: React.MutableRefObject<unknown>;
  controlBarVisibleRef: React.MutableRefObject<boolean>;
  hideControlBarRef: React.MutableRefObject<(() => void) | null>;
  enhancedSubtitleButtonRef: React.MutableRefObject<unknown>;
}

export function usePlayerSetup({
  videoRef,
  uiConfig,
  currentSubtitleTrack,
  showEnhancedSubtitles,
  setShowEnhancedSubtitles,
  setResetFontSizeTrigger,
  temporarilyUnlockControlBarRef,
  enhancedSubtitleNavigationRef,
  controlBarVisibleRef,
  hideControlBarRef,
  enhancedSubtitleButtonRef,
}: IUsePlayerSetupProps) {
  const [_player, setPlayer] = useState<VideoJsPlayer>();
  const sceneId = useRef<string>();

  const getPlayer = useCallback(() => {
    if (!_player) return null;
    if (_player.isDisposed()) return null;
    return _player;
  }, [_player]);

  // Initialize VideoJS player
  useEffect(() => {
    const options: VideoJsPlayerOptions = {
      id: VIDEO_PLAYER_ID,
      controls: true,
      controlBar: {
        pictureInPictureToggle: false,
        volumePanel: {
          inline: false,
        },
        chaptersButton: false,
        subsCapsButton: false, // 禁用原生字幕按钮
      },
      html5: {
        dash: {
          updateSettings: [
            {
              streaming: {
                buffer: {
                  bufferTimeAtTopQuality: 30,
                  bufferTimeAtTopQualityLongForm: 30,
                },
                gaps: {
                  jumpGaps: false,
                  jumpLargeGaps: false,
                },
              },
            },
          ],
        },
      },
      nativeControlsForTouch: false,
      playbackRates: [0.75, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 4, 6, 8, 10, 12, 16, 20],
      inactivityTimeout: 3000,
      preload: "metadata",
      playsinline: true,
      techOrder: ["chromecast", "html5"],
      userActions: {
        hotkeys: function (this: VideoJsPlayer, event) {
          handleHotkeys(
            this, 
            event, 
            () => {
              // 只有在有字幕文件时才允许切换增强字幕
              if (currentSubtitleTrack !== null) {
                setShowEnhancedSubtitles(!showEnhancedSubtitles);
              }
            },
            () => setResetFontSizeTrigger(prev => prev + 1),
            () => {
              // 使用 ref 来调用最新的 temporarilyUnlockControlBar 函数
              if (temporarilyUnlockControlBarRef.current) {
                temporarilyUnlockControlBarRef.current();
              }
            },
            enhancedSubtitleNavigationRef.current,
            () => controlBarVisibleRef.current,
            () => {
              // 使用 ref 来调用最新的 hideControlBar 函数
              if (hideControlBarRef.current) {
                hideControlBarRef.current();
              }
            }
          );
        },
      },
      plugins: {
        airPlay: {},
        chromecast: {},
        vttThumbnails: {
          showTimestamp: true,
        },
        markers: {},
        sourceSelector: {},
        persistVolume: {},
        bigButtons: {},
        seekButtons: {
          forward: 10,
          back: 10,
        },
        skipButtons: {},
        trackActivity: {},
        vrMenu: {},
        abLoopPlugin: {
          start: 0,
          end: false,
          enabled: false,
          loopIfBeforeStart: true,
          loopIfAfterEnd: true,
          pauseAfterLooping: false,
          pauseBeforeLooping: false,
          createButtons: uiConfig?.showAbLoopControls ?? false,
        },
        mobileTouchControls: {},
      },
    };

    const videoEl = document.createElement("video-js");
    videoEl.setAttribute("data-vjs-player", "true");
    videoEl.setAttribute("crossorigin", "anonymous");
    videoEl.classList.add("vjs-big-play-centered");
    videoRef.current!.appendChild(videoEl);

    const vjs = videojs(videoEl, options);

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const settings = (vjs as any).textTrackSettings;
    settings.setValues({
      backgroundColor: "#000",
      backgroundOpacity: "0.5",
    });
    settings.updateDisplay();

    vjs.focus();
    setPlayer(vjs);

    // 初始化增强字幕按钮
    const subtitleButton = vjs.enhancedSubtitleButton({
      onToggle: (enabled: boolean) => {
        setShowEnhancedSubtitles(enabled);
      }
    });
    
    // 保存按钮引用
    enhancedSubtitleButtonRef.current = subtitleButton;
    
    // 初始化时设置字幕可用性（默认为不可用，等待场景加载）
    if (subtitleButton && typeof subtitleButton.setSubtitlesAvailable === 'function') {
      subtitleButton.setSubtitlesAvailable(false);
    }

    // 永久禁用所有原生字幕轨道的显示
    const disableNativeSubtitles = () => {
      const tracks = vjs.textTracks();
      if (tracks) {
        for (let i = 0; i < tracks.length; i++) {
          const track = tracks[i];
          if (track.mode !== 'disabled') {
            track.mode = 'disabled';
          }
        }
      }
    };

    // 立即禁用
    disableNativeSubtitles();

    // 监听字幕轨道的变化并立即禁用
    vjs.textTracks().addEventListener('change', disableNativeSubtitles);
    vjs.textTracks().addEventListener('addtrack', disableNativeSubtitles);

    // 在视频加载时也禁用
    vjs.on('loadstart', disableNativeSubtitles);
    vjs.on('loadedmetadata', disableNativeSubtitles);
    vjs.on('canplay', disableNativeSubtitles);

    // 拦截video.js的全屏API，使用伪全屏
    // const originalRequestFullscreen = vjs.requestFullscreen?.bind(vjs);
    // const originalExitFullscreen = vjs.exitFullscreen?.bind(vjs);
    // const originalIsFullscreen = vjs.isFullscreen?.bind(vjs);
    
    if (vjs.requestFullscreen) {
      vjs.requestFullscreen = function() {
        togglePseudoFullscreen(vjs);
        return Promise.resolve();
      };
    }
    
    if (vjs.exitFullscreen) {
      vjs.exitFullscreen = function() {
        togglePseudoFullscreen(vjs);
        return Promise.resolve();
      };
    }
    
    if (vjs.isFullscreen) {
      vjs.isFullscreen = function() {
        return isPseudoFullscreen();
      };
    }

    // 拦截全屏按钮的点击事件（延迟执行，确保控制栏已初始化）
    const interceptFullscreenButton = () => {
      const controlBar = vjs.getChild('ControlBar');
      if (controlBar) {
        const fullscreenToggle = controlBar.getChild('FullscreenToggle');
        if (fullscreenToggle) {
          const originalHandleClick = fullscreenToggle.handleClick?.bind(fullscreenToggle);
          if (originalHandleClick) {
            fullscreenToggle.handleClick = function() {
              togglePseudoFullscreen(vjs);
            };
          }
        }
      }
    };

    // 立即尝试拦截
    interceptFullscreenButton();

    // 如果控制栏还未初始化，等待ready事件
    vjs.ready(() => {
      interceptFullscreenButton();
    });

    // Video player destructor
    return () => {
      vjs.dispose();
      videoEl.remove();
      setPlayer(undefined);

      // reset sceneId to force reload sources
      sceneId.current = undefined;
    };
    // empty deps - only init once
    // showAbLoopControls is necessary to re-init the player when the config changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiConfig?.showAbLoopControls]);

  // 同步增强字幕按钮状态
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;
    
    const button = player.getChild("ControlBar")?.getChild("EnhancedSubtitleButton") as EnhancedSubtitleButton | undefined;
    if (button && typeof button.setEnabled === 'function') {
      button.setEnabled(showEnhancedSubtitles);
    }
  }, [getPlayer, showEnhancedSubtitles]);

  // 根据字幕可用性更新增强字幕按钮的禁用状态
  useEffect(() => {
    const button = enhancedSubtitleButtonRef.current as EnhancedSubtitleButton | undefined;
    if (button && typeof button.setSubtitlesAvailable === 'function') {
      const hasSubtitles = currentSubtitleTrack !== null;
      button.setSubtitlesAvailable(hasSubtitles);
    }
  }, [currentSubtitleTrack, enhancedSubtitleButtonRef]);

  return {
    player: _player,
    getPlayer,
    sceneId,
  };
}

