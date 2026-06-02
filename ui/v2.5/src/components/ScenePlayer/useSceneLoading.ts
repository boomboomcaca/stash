import { useEffect, useCallback } from "react";
import { useIntl } from "react-intl";
import { VideoJsPlayer } from "video.js";
import { UAParser } from "ua-parser-js";
import * as GQL from "src/core/generated-graphql";
import { getLanguageDisplayName } from "src/utils/caption";
import { type IMarker } from "./markers";
import { getMarkerTitle, type MarkerFragment } from "./types";
import ScreenUtils from "src/utils/screen";
import { withApiKey } from "src/core/createClient";

interface IUseSceneLoadingProps {
  getPlayer: () => VideoJsPlayer | null;
  scene: GQL.SceneDataFragment;
  file: GQL.VideoFileDataFragment | undefined;
  sceneId: React.MutableRefObject<string | undefined>;
  interactiveClient: { pause: () => void };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  uiConfig: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interfaceConfig: any;
  autoplay: boolean | undefined;
  initialTimestamp: number;
  setReady: (value: boolean) => void;
  setTime: (value: number) => void;
  setCurrentSubtitleTrack: (value: string | null) => void;
  setSubtitleLanguage: (value: string) => void;
  setSubtitleTrackOptions?: (
    options: ISubtitleTrackOption[],
    selectedSrc: string | null
  ) => void;
  auto: React.MutableRefObject<boolean>;
  started: React.MutableRefObject<boolean>;
}

// One selectable enhanced-subtitle track for the track-selection menu.
export interface ISubtitleTrackOption {
  src: string;
  lang: string;
  label: string;
}

export function useSceneLoading({
  getPlayer,
  scene,
  file,
  sceneId,
  interactiveClient,
  uiConfig,
  interfaceConfig,
  autoplay,
  initialTimestamp,
  setReady,
  setTime,
  setCurrentSubtitleTrack,
  setSubtitleLanguage,
  setSubtitleTrackOptions,
  auto,
  started,
}: IUseSceneLoadingProps) {
  const intl = useIntl();

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    // don't re-initialise the player unless the scene has changed
    if (!file || scene.id === sceneId.current) return;

    sceneId.current = scene.id;

    setReady(false);

    // reset on new scene
    player.trackActivity().reset();

    // always stop the interactive client on initialisation
    interactiveClient.pause();

    const isSafari = UAParser().browser.name?.includes("Safari");
    const isLandscape = file.height && file.width && file.width > file.height;
    const mobileUiOptions = {
      fullscreen: {
        enterOnRotate: true,
        exitOnRotate: true,
        lockOnRotate: true,
        lockToLandscapeOnEnter: uiConfig?.disableMobileMediaAutoRotateEnabled
          ? false
          : isLandscape,
      },
      touchControls: {
        disabled: false, // 改回 true，禁用 videojs-mobile-ui 的触摸控制
      },
    };
    if (!isSafari) {
      player.mobileUi(mobileUiOptions);
    }

    function isDirect(src: URL) {
      return (
        src.pathname.endsWith("/stream") ||
        src.pathname.endsWith("/stream.mpd") ||
        src.pathname.endsWith("/stream.m3u8")
      );
    }

    const { duration } = file;
    const sourceSelector = player.sourceSelector();
    sourceSelector.setSources(
      scene.sceneStreams
        .filter((stream) => {
          const src = new URL(stream.url);
          const isFileTranscode = !isDirect(src);
          const isMp3 = src.pathname.endsWith("/stream.mp3");

          return !(isFileTranscode && isSafari && !isMp3);
        })
        .map((stream) => {
          const src = new URL(stream.url);

          return {
            src: stream.url,
            type: stream.mime_type ?? undefined,
            label: stream.label ?? undefined,
            offset: !isDirect(src),
            duration,
          };
        })
    );

    function getDefaultLanguageCode() {
      return window.navigator.language.split(/[-_]/)[0];
    }

    if (scene.captions && scene.captions.length > 0) {
      const languageCode = getDefaultLanguageCode();
      let hasDefault = false;
      let defaultTrackSrc = null;
      let defaultLang = "en";

      const trackOptions: ISubtitleTrackOption[] = [];

      for (let caption of scene.captions) {
        const lang = caption.language_code;
        const label = `${getLanguageDisplayName(lang, intl.locale)} (${
          caption.caption_type
        })`;
        const setAsDefault = !hasDefault && languageCode == lang;
        const trackSrc =
          withApiKey(
            `${scene.paths.caption}?lang=${lang}&type=${caption.caption_type}`
          ) ?? "";

        if (setAsDefault) {
          hasDefault = true;
          defaultTrackSrc = trackSrc;
          defaultLang = lang;
        }

        trackOptions.push({ src: trackSrc, lang, label });

        // 原生字幕默认不显示，由增强字幕按钮控制增强字幕
        sourceSelector.addTextTrack(
          {
            src: trackSrc,
            kind: "captions",
            srclang: lang,
            label,
            default: false,
          },
          false
        );
      }

      // Set the default or first track for enhanced subtitles
      let selectedSrc: string | null;
      if (defaultTrackSrc) {
        selectedSrc = defaultTrackSrc;
        setCurrentSubtitleTrack(defaultTrackSrc);
        setSubtitleLanguage(defaultLang);
      } else {
        const firstCaption = scene.captions[0];
        selectedSrc =
          withApiKey(
            `${scene.paths.caption}?lang=${firstCaption.language_code}&type=${firstCaption.caption_type}`
          ) ?? "";
        setCurrentSubtitleTrack(selectedSrc);
        setSubtitleLanguage(firstCaption.language_code);
      }

      // Feed the available tracks to the track-selection menu
      setSubtitleTrackOptions?.(trackOptions, selectedSrc);
    } else {
      // 没有字幕时，重置字幕轨道为null
      setCurrentSubtitleTrack(null);
      setSubtitleTrackOptions?.([], null);
    }

    auto.current =
      autoplay ||
      (interfaceConfig?.autostartVideo ?? false) ||
      initialTimestamp > 0;

    const alwaysStartFromBeginning =
      uiConfig?.alwaysStartFromBeginning ?? false;
    const resumeTime = scene.resume_time ?? 0;

    let startPosition = initialTimestamp;
    if (
      !startPosition &&
      !alwaysStartFromBeginning &&
      file.duration > resumeTime
    ) {
      startPosition = resumeTime;
    }

    setTime(startPosition);

    player.load();
    player.focus();

    player.ready(() => {
      player.vttThumbnails().src(withApiKey(scene.paths.vtt) ?? null);

      if (startPosition) {
        player.currentTime(startPosition);
      }
    });

    started.current = false;
  }, [
    getPlayer,
    file,
    scene.id,
    scene.captions,
    scene.paths.caption,
    scene.resume_time,
    scene.sceneStreams,
    scene.paths.vtt,
    interactiveClient,
    autoplay,
    interfaceConfig?.autostartVideo,
    uiConfig?.alwaysStartFromBeginning,
    uiConfig?.disableMobileMediaAutoRotateEnabled,
    initialTimestamp,
    setReady,
    setTime,
    setCurrentSubtitleTrack,
    setSubtitleLanguage,
    setSubtitleTrackOptions,
    auto,
    started,
    sceneId,
    intl.locale,
  ]);

  const loadMarkers = useCallback(
    (player: VideoJsPlayer) => {
      const markerData = scene.scene_markers.map((marker) => ({
        title: getMarkerTitle(marker as MarkerFragment),
        seconds: marker.seconds,
        end_seconds: marker.end_seconds ?? null,
        primaryTag: marker.primary_tag,
      }));

      const markers = player.markers();

      const uniqueTagNames = markerData
        .map((marker) => marker.primaryTag.name)
        .filter((value, index, self) => self.indexOf(value) === index);

      // Wait for colors
      markers.findColors(uniqueTagNames);

      const showRangeTags =
        !ScreenUtils.isMobile() && (uiConfig?.showRangeMarkers ?? true);
      const timestampMarkers: IMarker[] = [];
      const rangeMarkers: IMarker[] = [];

      if (!showRangeTags) {
        for (const marker of markerData) {
          timestampMarkers.push(marker);
        }
      } else {
        for (const marker of markerData) {
          if (marker.end_seconds === null) {
            timestampMarkers.push(marker);
          } else {
            rangeMarkers.push(marker);
          }
        }
      }

      requestAnimationFrame(() => {
        markers.addDotMarkers(timestampMarkers);
        markers.addRangeMarkers(rangeMarkers);
      });
    },
    [scene, uiConfig]
  );

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    if (scene.paths.screenshot) {
      player.poster(withApiKey(scene.paths.screenshot) ?? "");
    } else {
      player.poster("");
    }

    // Define the event handler outside the useEffect
    const handleLoadMetadata = () => {
      loadMarkers(player);
    };

    // Ensure markers are added after player is fully ready and sources are loaded
    if (player.readyState() >= 1) {
      loadMarkers(player);
    } else {
      player.on("loadedmetadata", handleLoadMetadata);
    }

    return () => {
      player.off("loadedmetadata", handleLoadMetadata);
      const markers = player.markers();
      markers.clearMarkers();
    };
  }, [getPlayer, scene, uiConfig, loadMarkers]);
}
