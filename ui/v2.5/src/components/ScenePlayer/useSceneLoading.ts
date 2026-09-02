import { useEffect, useCallback, useRef } from "react";
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
  // biome-ignore lint/suspicious/noExplicitAny: videojs/DOM internals are untyped
  uiConfig: any;
  // biome-ignore lint/suspicious/noExplicitAny: videojs/DOM internals are untyped
  interfaceConfig: any;
  autoplay: boolean | undefined;
  initialTimestamp: number;
  setReady: (value: boolean) => void;
  setTime: (value: number) => void;
  currentSubtitleTrack: string | null;
  subtitleLanguage: string;
  setCurrentSubtitleTrack: (value: string | null) => void;
  setSubtitleLanguage: (value: string) => void;
  setSubtitleTrackOptions?: (
    options: ISubtitleTrackOption[],
    selectedSrc: string | null,
    preserveOff?: boolean
  ) => void;
  auto: React.MutableRefObject<boolean>;
  autostartIntent: React.MutableRefObject<boolean>;
  started: React.MutableRefObject<boolean>;
}

// One selectable enhanced-subtitle track for the track-selection menu.
export interface ISubtitleTrackOption {
  src: string;
  lang: string;
  // caption type (srt/vtt) — distinguishes same-language tracks so the
  // selection can be restored exactly across rebuilds
  type: string;
  label: string;
}

// Build the caption endpoint URL for a given language/type. scene.paths.caption
// may already carry a signed-URL query (?cid=...&expires=...&signature=...) when
// credentials are configured (see signed media URLs). Appending a second "?" for
// lang/type would fold them into the previous param's value, so the server sees
// no lang, matches no caption, and returns an empty body — leaving the enhanced
// subtitle overlay visible but blank. Pick the correct separator instead.
function buildCaptionTrackSrc(
  captionBase: string | null | undefined,
  lang: string,
  type: string
): string {
  const base = captionBase ?? "";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}lang=${encodeURIComponent(lang)}&type=${encodeURIComponent(
    type
  )}`;
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
  currentSubtitleTrack,
  subtitleLanguage,
  setCurrentSubtitleTrack,
  setSubtitleLanguage,
  setSubtitleTrackOptions,
  auto,
  autostartIntent,
  started,
}: IUseSceneLoadingProps) {
  const intl = useIntl();

  // Text tracks added for the current caption set, so the captions effect
  // below can remove them when the set changes without a scene change.
  // options keeps the previous generation's track options so the selection
  // can be restored by language/type across rebuilds.
  const captionTracks = useRef<{
    player: VideoJsPlayer;
    key: string;
    els: HTMLTrackElement[];
    options: ISubtitleTrackOption[];
  } | null>(null);

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

    auto.current =
      autoplay ||
      (interfaceConfig?.autostartVideo ?? false) ||
      initialTimestamp > 0;
    autostartIntent.current = auto.current;

    // let the source selector know whether playback is intended, so it doesn't
    // auto-start during source failover/preload (e.g. transcode fallback in Safari).
    // uses autostartIntent (not auto) because auto is cleared by the one-shot play
    // effect before failover occurs; started covers mid-playback source swaps.
    sourceSelector.setShouldAutoplay(
      () => autostartIntent.current || started.current
    );

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
    auto,
    autostartIntent,
    started,
    sceneId,
  ]);

  // (Re)build the enhanced-subtitle tracks whenever the scene's captions
  // change — including for the SAME scene, e.g. after the subtitles are
  // deleted and the scene is refetched. The init effect above only runs on
  // scene change, so it cannot pick up same-scene caption updates.
  useEffect(() => {
    const player = getPlayer();
    if (!player || !file) return;

    const captions = scene.captions ?? [];
    // identity of the caption set; signed-URL params on scene.paths.caption
    // rotate between refetches, so key on language/type instead of the src
    const key =
      `${scene.id}|${intl.locale}|` +
      captions.map((c) => `${c.language_code}:${c.caption_type}`).join(",");

    const applied = captionTracks.current;
    if (applied && applied.player === player && applied.key === key) return;

    const sourceSelector = player.sourceSelector();

    // remove the tracks built for the previous caption set
    if (applied && applied.player === player) {
      for (const el of applied.els) {
        sourceSelector.removeTextTrack(el);
      }
    }

    const isSameScene =
      applied?.player === player && applied.key.startsWith(`${scene.id}|`);

    const trackOptions: ISubtitleTrackOption[] = [];
    const els: HTMLTrackElement[] = [];

    for (const caption of captions) {
      const lang = caption.language_code;
      const label = `${getLanguageDisplayName(lang, intl.locale)} (${
        caption.caption_type
      })`;
      const trackSrc =
        withApiKey(
          buildCaptionTrackSrc(scene.paths.caption, lang, caption.caption_type)
        ) ?? "";

      trackOptions.push({
        src: trackSrc,
        lang,
        type: caption.caption_type,
        label,
      });

      // 原生字幕默认不显示，由增强字幕按钮控制增强字幕
      els.push(
        sourceSelector.addTextTrack(
          {
            src: trackSrc,
            kind: "captions",
            srclang: lang,
            label,
            default: false,
          },
          true
        )
      );
    }

    captionTracks.current = { player, key, els, options: trackOptions };

    if (trackOptions.length === 0) {
      // 没有字幕时，重置字幕轨道为null
      setCurrentSubtitleTrack(null);
      setSubtitleTrackOptions?.([], null);
      return;
    }

    // pick the selected track: keep the user's exact track (language + type)
    // when the captions changed under the same scene, then the same language,
    // otherwise fall back to the browser language, then to the first caption.
    // src strings can't be compared across rebuilds (signed-URL params
    // rotate), so the previous selection is resolved against the previous
    // generation's options.
    const prevSelected =
      isSameScene && currentSubtitleTrack !== null
        ? applied?.options.find((o) => o.src === currentSubtitleTrack)
        : undefined;
    const keepLang =
      isSameScene && currentSubtitleTrack !== null ? subtitleLanguage : null;
    const languageCode = window.navigator.language.split(/[-_]/)[0];
    const selected =
      (prevSelected
        ? trackOptions.find(
            (o) => o.lang === prevSelected.lang && o.type === prevSelected.type
          )
        : undefined) ??
      (keepLang ? trackOptions.find((o) => o.lang === keepLang) : undefined) ??
      trackOptions.find((o) => o.lang === languageCode) ??
      trackOptions[0];

    setCurrentSubtitleTrack(selected.src);
    setSubtitleLanguage(selected.lang);
    // preserve an explicit "Off" menu selection across same-scene rebuilds
    setSubtitleTrackOptions?.(trackOptions, selected.src, isSameScene);
  }, [
    getPlayer,
    file,
    scene.id,
    scene.captions,
    scene.paths.caption,
    currentSubtitleTrack,
    subtitleLanguage,
    setCurrentSubtitleTrack,
    setSubtitleLanguage,
    setSubtitleTrackOptions,
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
  }, [getPlayer, scene, loadMarkers]);
}
