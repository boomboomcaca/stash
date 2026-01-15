import React, {
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import videojs from "video.js";
import useScript from "src/hooks/useScript";
import "videojs-contrib-dash";
import "videojs-mobile-ui";
import "videojs-seek-buttons";
import "./live";
import "./PlaylistButtons";
import "./source-selector";
import "./persist-volume";
import "./autostart-button";
import MarkersPlugin from "./markers";
void MarkersPlugin;
import "./vtt-thumbnails";
import "./big-buttons";
import "./track-activity";
import "./vrmode";
import "./mobile-touch-controls";
import "./enhanced-subtitle-button";
import "./playback-rate-button";
import "./media-session";
import "./wake-sentinel";
import cx from "classnames";
import {
  useSceneSaveActivity,
  useSceneIncrementPlayCount,
  useConfigureInterface,
} from "src/core/StashService";

import { ScenePlayerScrubber } from "./ScenePlayerScrubber";
import { useConfigurationContext } from "src/hooks/Config";
import {
  ConnectionState,
  InteractiveContext,
} from "src/hooks/Interactive/context";
import { SceneInteractiveStatus } from "src/hooks/Interactive/status";
import { EnhancedSubtitleOverlay } from "./EnhancedSubtitle";
import ScreenUtils from "src/utils/screen";
import { PatchComponent } from "src/patch";

// @ts-ignore
import airplay from "@silvermine/videojs-airplay";
// @ts-ignore
import chromecast from "@silvermine/videojs-chromecast";
import abLoopPlugin from "videojs-abloop";

// register videojs plugins
airplay(videojs);
chromecast(videojs);
abLoopPlugin(window, videojs);

import { IScenePlayerProps } from "./types";
import { usePlayerSetup } from "./usePlayerSetup";
import { usePlayerEvents } from "./usePlayerEvents";
import { useSceneLoading } from "./useSceneLoading";
import { useControlBarManagement } from "./useControlBarManagement";
import { useMediaSession } from "./useMediaSession";
import { ScenePlayerActions } from "./ScenePlayerActions";

export const ScenePlayer: React.FC<IScenePlayerProps> = PatchComponent(
  "ScenePlayer",
  ({
    scene,
    hideScrubberOverride,
    autoplay,
    permitLoop = true,
    initialTimestamp: _initialTimestamp,
    sendSetTimestamp,
    onComplete,
    onNext,
    onPrevious,
    onDelete,
    onRatingChange,
  }) => {
    // 拖拽状态管理
    const draggingState = useRef<{
      isDragging: boolean;
      wasPlaying: boolean;
    }>({
      isDragging: false,
      wasPlaying: false,
    });
    const { configuration } = useConfigurationContext();
    const interfaceConfig = configuration?.interface;
    const uiConfig = configuration?.ui;
    const videoRef = useRef<HTMLDivElement>(null);
    const [sceneSaveActivity] = useSceneSaveActivity();
    const [sceneIncrementPlayCount] = useSceneIncrementPlayCount();
    const [updateInterfaceConfig] = useConfigureInterface();

    const [time, setTime] = useState(0);
    const [ready, setReady] = useState(false);

    const {
      interactive: interactiveClient,
      uploadScript,
      currentScript,
      initialised: interactiveInitialised,
      state: interactiveState,
    } = React.useContext(InteractiveContext);

    const [fullscreen, setFullscreen] = useState(false);
    const [showScrubber, setShowScrubber] = useState(false);
    const [controlBarVisible, setControlBarVisible] = useState(true);
    const [showEnhancedSubtitles, setShowEnhancedSubtitles] = useState(false);
    const [currentSubtitleTrack, setCurrentSubtitleTrack] = useState<
      string | null
    >(null);
    const [subtitleLanguage, setSubtitleLanguage] = useState<string>("en");
    const [resetFontSizeTrigger, setResetFontSizeTrigger] = useState(0);
    const [subtitleCues, setSubtitleCues] = useState<
      Array<{ startTime: number; endTime: number; text: string }>
    >([]);
    const [currentSubtitleIndex, setCurrentSubtitleIndex] =
      useState<number>(-1);

    const started = useRef(false);
    const enhancedSubtitleButtonRef = useRef<HTMLButtonElement>(null);
    const auto = useRef(false);
    const isMouseOverActionsRef = useRef(false);
    const interactiveReady = useRef(false);
    const showEnhancedSubtitlesRef = useRef(showEnhancedSubtitles);
    const enhancedSubtitleNavigationRef = useRef<unknown>(null);
    const minimumPlayPercent = uiConfig?.minimumPlayPercent ?? 0;
    const trackActivity = uiConfig?.trackActivity ?? true;
    const vrTag = uiConfig?.vrTag ?? undefined;

    // 保持 ref 与 state 同步
    useEffect(() => {
      showEnhancedSubtitlesRef.current = showEnhancedSubtitles;
    }, [showEnhancedSubtitles]);

    // Callback to receive navigation ref from EnhancedSubtitleOverlay
    const handleNavigationRef = useCallback((navRef: unknown) => {
      enhancedSubtitleNavigationRef.current = navRef;
    }, []);

    useScript(
      "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1",
      uiConfig?.enableChromecast
    );

    const file = useMemo(
      () => (scene.files.length > 0 ? scene.files[0] : undefined),
      [scene]
    );

    const maxLoopDuration = interfaceConfig?.maximumLoopDuration ?? 0;
    const looping = useMemo(
      () =>
        !!file?.duration &&
        permitLoop &&
        maxLoopDuration !== 0 &&
        file.duration < maxLoopDuration,
      [file, permitLoop, maxLoopDuration]
    );

    // Create refs for control bar management
    const controlBarVisibleRef = useRef(false);
    const temporarilyUnlockControlBarRef = useRef<(() => void) | null>(null);
    const hideControlBarRef = useRef<(() => void) | null>(null);

    // Use player setup hook
    const { getPlayer, sceneId } = usePlayerSetup({
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
    });

    // Use control bar management hook
    const { temporarilyUnlockControlBar, hideControlBar } =
      useControlBarManagement({
        getPlayer,
        showEnhancedSubtitles,
        showEnhancedSubtitlesRef,
        subtitleCues,
        currentSubtitleIndex,
        controlBarVisibleRef,
        temporarilyUnlockControlBarRef,
        hideControlBarRef,
      });

    // Sync control bar management refs
    useEffect(() => {
      temporarilyUnlockControlBarRef.current = temporarilyUnlockControlBar;
    }, [temporarilyUnlockControlBar]);

    useEffect(() => {
      hideControlBarRef.current = hideControlBar;
    }, [hideControlBar]);

    useEffect(() => {
      if (hideScrubberOverride || fullscreen) {
        setShowScrubber(false);
        return;
      }

      const onResize = () => {
        const show = window.innerHeight >= 450 && !ScreenUtils.isMobile();
        setShowScrubber(show);
      };
      onResize();

      window.addEventListener("resize", onResize);

      return () => window.removeEventListener("resize", onResize);
    }, [hideScrubberOverride, fullscreen]);

    useEffect(() => {
      sendSetTimestamp((value: number) => {
        const player = getPlayer();
        if (player && value >= 0) {
          if (player.hasStarted() && player.paused()) {
            player.currentTime(value);
          } else {
            player.play()?.then(() => {
              player.currentTime(value);
            });
          }
        }
      });
    }, [sendSetTimestamp, getPlayer]);

    useEffect(() => {
      const player = getPlayer();
      if (!player) return;
      const skipButtons = player.skipButtons();
      skipButtons.setForwardHandler(onNext);
      skipButtons.setBackwardHandler(onPrevious);

      // 设置移动触摸控件的场景切换回调
      const touchPlugin = player._mobileTouchControlsPlugin;
      if (touchPlugin) {
        touchPlugin.setOnNextScene?.(onNext);
        touchPlugin.setOnPreviousScene?.(onPrevious);
      }
    }, [getPlayer, onNext, onPrevious]);

    useEffect(() => {
      if (scene.interactive && interactiveInitialised) {
        interactiveReady.current = false;
        uploadScript(scene.paths.funscript || "").then(() => {
          interactiveReady.current = true;
        });
      }
    }, [
      uploadScript,
      interactiveInitialised,
      scene.interactive,
      scene.paths.funscript,
    ]);

    // play the script if video started before script upload finished
    useEffect(() => {
      if (interactiveState !== ConnectionState.Ready) return;
      const player = getPlayer();
      if (!player || player.paused()) return;
      interactiveClient.ensurePlaying(player.currentTime());
    }, [interactiveState, getPlayer, interactiveClient]);

    useEffect(() => {
      const player = getPlayer();
      if (!player) return;

      const vrMenu = player.vrMenu();

      let showButton = false;

      if (vrTag) {
        showButton = scene.tags.some((tag) => vrTag === tag.name);
      }

      vrMenu.setShowButton(showButton);
    }, [getPlayer, scene, vrTag]);

    // Use player events hook
    usePlayerEvents({
      getPlayer,
      scene,
      file,
      sceneId,
      interactiveClient,
      interactiveReady,
      started,
      setReady,
      setTime,
      setFullscreen,
      onComplete,
    });

    // Use scene loading hook
    useSceneLoading({
      getPlayer,
      scene,
      file,
      sceneId,
      interactiveClient,
      uiConfig,
      interfaceConfig,
      autoplay,
      initialTimestamp: _initialTimestamp,
      setReady,
      setTime,
      setCurrentSubtitleTrack,
      setSubtitleLanguage,
      auto,
      started,
    });

    useMediaSession({
      getPlayer,
      scene,
      onNext,
      onPrevious,
    });

    // 监听控制栏可见性变化
    useEffect(() => {
      const player = getPlayer();
      if (!player) return;

      const handleUserActive = () => setControlBarVisible(true);
      const handleUserInactive = () => {
        // 如果鼠标在操作按钮上，不隐藏控制栏
        if (!isMouseOverActionsRef.current) {
          setControlBarVisible(false);
        }
      };

      player.on("useractive", handleUserActive);
      player.on("userinactive", handleUserInactive);

      return () => {
        player.off("useractive", handleUserActive);
        player.off("userinactive", handleUserInactive);
      };
    }, [getPlayer]);

    useEffect(() => {
      const player = getPlayer();
      if (!player) return;

      async function saveActivity(resumeTime: number, playDuration: number) {
        if (!scene.id) return;

        await sceneSaveActivity({
          variables: {
            id: scene.id,
            playDuration,
            resume_time: resumeTime,
          },
        });
      }

      async function incrementPlayCount() {
        if (!scene.id) return;

        await sceneIncrementPlayCount({
          variables: {
            id: scene.id,
          },
        });
      }

      const activity = player.trackActivity();
      activity.saveActivity = saveActivity;
      activity.incrementPlayCount = incrementPlayCount;
      activity.minimumPlayPercent = minimumPlayPercent;
      activity.setEnabled(trackActivity);
    }, [
      getPlayer,
      scene,
      vrTag,
      trackActivity,
      minimumPlayPercent,
      sceneIncrementPlayCount,
      sceneSaveActivity,
    ]);

    // Sync autostart button with config changes
    useEffect(() => {
      const player = getPlayer();
      if (!player) return;

      async function updateAutoStart(enabled: boolean) {
        await updateInterfaceConfig({
          variables: {
            input: {
              autostartVideo: enabled,
            },
          },
        });
      }

      const autostartButton = player.autostartButton();
      if (autostartButton) {
        autostartButton.syncWithConfig(
          interfaceConfig?.autostartVideo ?? false
        );
        autostartButton.updateAutoStart = updateAutoStart;
      }
    }, [getPlayer, updateInterfaceConfig, interfaceConfig?.autostartVideo]);

    useEffect(() => {
      const player = getPlayer();
      if (!player) return;

      player.loop(looping);
      interactiveClient.setLooping(looping);
    }, [getPlayer, interactiveClient, looping]);

    useEffect(() => {
      const player = getPlayer();
      if (!player || !ready || !auto.current) {
        return;
      }

      // check if we're waiting for the interactive client
      if (
        scene.interactive &&
        interactiveClient.handyKey &&
        currentScript !== scene.paths.funscript
      ) {
        return;
      }

      player.play();
      auto.current = false;
    }, [getPlayer, scene, ready, interactiveClient, currentScript]);

    // ✅ 将 useCallback 移到组件顶层
    const handleSubtitlesLoaded = useCallback(
      (cues) => setSubtitleCues(cues),
      []
    );
    const handleCurrentCueChange = useCallback(
      (index) => setCurrentSubtitleIndex(index),
      []
    );

    // set up mediaSession plugin
    useEffect(() => {
      const player = getPlayer();
      if (!player) return;

      // set up mediasession plugin
      // get performer names as array
      const performers = scene?.performers.map((p) => p.name).join(", ");
      player
        .mediaSession()
        .setMetadata(
          scene?.title ?? "Stash",
          scene?.studio?.name ?? performers ?? "Stash",
          scene.paths.screenshot || ""
        );
    }, [getPlayer, scene]);

    function onScrubberScroll() {
      if (started.current) {
        getPlayer()?.pause();
      }

      // 当拖动进度条时，如果增强字幕已开启，显示控制栏
      if (showEnhancedSubtitles) {
        temporarilyUnlockControlBar();
      }
    }

    function onScrubberSeek(seconds: number, isDragging?: boolean) {
      const player = getPlayer();
      if (!player) return;

      if (started.current) {
        if (isDragging) {
          // 拖拽开始时，记录播放状态并暂停
          if (!draggingState.current.isDragging) {
            draggingState.current.isDragging = true;
            draggingState.current.wasPlaying = !player.paused();
            if (draggingState.current.wasPlaying) {
              player.pause();
            }
            // 拖拽开始时，如果启用了增强字幕，显示控制栏
            if (showEnhancedSubtitles) {
              temporarilyUnlockControlBar();
            }
          }

          // 拖拽过程中，使用优化的视频帧更新
          player.currentTime(seconds);

          // 简化的视频帧更新 - 只使用必要的操作
          try {
            const videoElement = player
              .el()
              .querySelector("video") as HTMLVideoElement;
            if (videoElement && videoElement.readyState >= 2) {
              // 只触发timeupdate事件即可，避免过多的DOM操作
              videoElement.dispatchEvent(
                new Event("timeupdate", { bubbles: true })
              );
            }
          } catch (error) {}

          // 更新本地时间状态以确保UI同步
          setTime(seconds);
        } else {
          // 拖拽结束时，恢复原始播放状态
          if (draggingState.current.isDragging) {
            draggingState.current.isDragging = false;
            player.currentTime(seconds);

            // 恢复原始播放状态
            if (draggingState.current.wasPlaying) {
              player.play()?.catch(() => {});
            }
          } else {
            // 非拖拽模式的正常seek
            player.currentTime(seconds);
          }
        }
      } else {
        setTime(seconds);
      }
    }

    // Override spacebar to always pause/play
    function onKeyDown(this: HTMLDivElement, event: KeyboardEvent) {
      const player = getPlayer();
      if (!player) return;

      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (event.key == " ") {
        event.preventDefault();
        event.stopPropagation();
        if (player.paused()) {
          player.play();
        } else {
          player.pause();
        }
      }
    }

    const isPortrait =
      file && file.height && file.width && file.height > file.width;

    return (
      <div
        className={cx("VideoPlayer", {
          portrait: isPortrait,
          "no-file": !file,
        })}
        onKeyDownCapture={onKeyDown}
      >
        <div className="video-container">
          <div className="video-wrapper" ref={videoRef}>
            {onDelete && onRatingChange && !showEnhancedSubtitles && (
              <ScenePlayerActions
                rating100={scene.rating100}
                onSetRating={onRatingChange}
                onDelete={onDelete}
                isVisible={controlBarVisible}
                onMouseEnter={() => {
                  isMouseOverActionsRef.current = true;
                }}
                onMouseLeave={() => {
                  isMouseOverActionsRef.current = false;
                }}
              />
            )}
            {currentSubtitleTrack && showEnhancedSubtitles && (
              <EnhancedSubtitleOverlay
                currentTime={time}
                subtitleTrack={currentSubtitleTrack}
                isVisible={showEnhancedSubtitles}
                isFullscreen={fullscreen}
                language={subtitleLanguage}
                onToggleVisibility={() =>
                  setShowEnhancedSubtitles(!showEnhancedSubtitles)
                }
                onPausePlayer={() => getPlayer()?.pause()}
                getPlayerPaused={() => getPlayer()?.paused() ?? true}
                resetFontSizeTrigger={resetFontSizeTrigger}
                onSubtitlesLoaded={handleSubtitlesLoaded}
                onCurrentCueChange={handleCurrentCueChange}
                onAPDoubleClick={temporarilyUnlockControlBar}
                onPlay={() => getPlayer()?.play()}
                onSeekToCue={(cueIndex) => {
                  const player = getPlayer();
                  if (player && subtitleCues[cueIndex]) {
                    player.currentTime(subtitleCues[cueIndex].startTime);
                  }
                }}
                onGetPlayer={getPlayer}
                onNavigationRef={handleNavigationRef}
              />
            )}
          </div>
        </div>
        {scene.interactive &&
          (interactiveState !== ConnectionState.Ready ||
            getPlayer()?.paused()) && <SceneInteractiveStatus />}
        {file && showScrubber && (
          <ScenePlayerScrubber
            file={file}
            scene={scene}
            time={time}
            onSeek={onScrubberSeek}
            onScroll={onScrubberScroll}
          />
        )}
      </div>
    );
  }
);

export default ScenePlayer;
