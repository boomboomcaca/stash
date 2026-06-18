import React from "react";
import * as GQL from "src/core/generated-graphql";
import { BooleanSetting, ModalSetting, SelectSetting } from "../Inputs";
import {
  VideoPreviewInput,
  VideoPreviewSettingsInput,
} from "../GeneratePreviewOptions";

// Languages supported by the parakeet ASR service. The "en" model also
// auto-handles ~25 European languages; Japanese and Vietnamese use dedicated
// models. Chinese is not supported by parakeet, so it is intentionally absent.
const SUBTITLE_LANGUAGES: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "ja", label: "日本語 (Japanese)" },
  { code: "vi", label: "Tiếng Việt (Vietnamese)" },
  { code: "es", label: "Español (Spanish)" },
  { code: "fr", label: "Français (French)" },
  { code: "de", label: "Deutsch (German)" },
  { code: "it", label: "Italiano (Italian)" },
  { code: "pt", label: "Português (Portuguese)" },
  { code: "ru", label: "Русский (Russian)" },
];

interface IGenerateOptions {
  type?: "scene" | "image" | "gallery";
  selection?: boolean;
  options: GQL.GenerateMetadataInput;
  setOptions: (s: GQL.GenerateMetadataInput) => void;
}

export const GenerateOptions: React.FC<IGenerateOptions> = ({
  type,
  selection,
  options,
  setOptions: setOptionsState,
}) => {
  const previewOptions: GQL.GeneratePreviewOptionsInput =
    options.previewOptions ?? {};

  function setOptions(input: Partial<GQL.GenerateMetadataInput>) {
    setOptionsState({ ...options, ...input });
  }

  const showSceneOptions = !type || type === "scene";
  const showImageOptions = !type || type === "image" || type === "gallery";

  return (
    <>
      {showSceneOptions && (
        <>
          <BooleanSetting
            id="covers-task"
            headingID="dialogs.scene_gen.covers"
            checked={options.covers ?? false}
            onChange={(v) => setOptions({ covers: v })}
          />
          <BooleanSetting
            id="preview-task"
            checked={options.previews ?? false}
            headingID="dialogs.scene_gen.video_previews"
            tooltipID="dialogs.scene_gen.video_previews_tooltip"
            onChange={(v) => setOptions({ previews: v })}
          />
          <BooleanSetting
            advanced
            className="sub-setting"
            id="image-preview-task"
            checked={options.imagePreviews ?? false}
            disabled={!options.previews}
            headingID="dialogs.scene_gen.image_previews"
            tooltipID="dialogs.scene_gen.image_previews_tooltip"
            onChange={(v) => setOptions({ imagePreviews: v })}
          />

          {/* #2251 - only allow preview generation options to be overridden when generating from a selection */}
          {selection ? (
            <ModalSetting<VideoPreviewSettingsInput>
              id="video-preview-settings"
              className="sub-setting"
              disabled={!options.previews}
              headingID="dialogs.scene_gen.override_preview_generation_options"
              tooltipID="dialogs.scene_gen.override_preview_generation_options_desc"
              value={{
                previewExcludeEnd: previewOptions.previewExcludeEnd,
                previewExcludeStart: previewOptions.previewExcludeStart,
                previewSegmentDuration: previewOptions.previewSegmentDuration,
                previewSegments: previewOptions.previewSegments,
              }}
              onChange={(v) => setOptions({ previewOptions: v })}
              renderField={(value, setValue) => (
                <VideoPreviewInput value={value ?? {}} setValue={setValue} />
              )}
              renderValue={() => {
                return <></>;
              }}
            />
          ) : undefined}

          <BooleanSetting
            id="sprite-task"
            checked={options.sprites ?? false}
            headingID="dialogs.scene_gen.sprites"
            tooltipID="dialogs.scene_gen.sprites_tooltip"
            onChange={(v) => setOptions({ sprites: v })}
          />
          <BooleanSetting
            id="marker-task"
            checked={options.markers ?? false}
            headingID="dialogs.scene_gen.markers"
            tooltipID="dialogs.scene_gen.markers_tooltip"
            onChange={(v) => setOptions({ markers: v })}
          />
          <BooleanSetting
            advanced
            id="marker-image-preview-task"
            className="sub-setting"
            checked={options.markerImagePreviews ?? false}
            headingID="dialogs.scene_gen.marker_image_previews"
            tooltipID="dialogs.scene_gen.marker_image_previews_tooltip"
            onChange={(v) =>
              setOptions({
                markerImagePreviews: v,
              })
            }
          />
          <BooleanSetting
            id="marker-screenshot-task"
            checked={options.markerScreenshots ?? false}
            headingID="dialogs.scene_gen.marker_screenshots"
            tooltipID="dialogs.scene_gen.marker_screenshots_tooltip"
            onChange={(v) => setOptions({ markerScreenshots: v })}
          />

          <BooleanSetting
            advanced
            id="transcode-task"
            checked={options.transcodes ?? false}
            headingID="dialogs.scene_gen.transcodes"
            tooltipID="dialogs.scene_gen.transcodes_tooltip"
            onChange={(v) => setOptions({ transcodes: v })}
          />
          {selection ? (
            <BooleanSetting
              advanced
              id="force-transcode"
              className="sub-setting"
              checked={options.forceTranscodes ?? false}
              disabled={!options.transcodes}
              headingID="dialogs.scene_gen.force_transcodes"
              tooltipID="dialogs.scene_gen.force_transcodes_tooltip"
              onChange={(v) => setOptions({ forceTranscodes: v })}
            />
          ) : undefined}

          <BooleanSetting
            id="phash-task"
            checked={options.phashes ?? false}
            headingID="dialogs.scene_gen.phash"
            tooltipID="dialogs.scene_gen.phash_tooltip"
            onChange={(v) => setOptions({ phashes: v })}
          />

          <BooleanSetting
            id="interactive-heatmap-speed-task"
            checked={options.interactiveHeatmapsSpeeds ?? false}
            headingID="dialogs.scene_gen.interactive_heatmap_speed"
            onChange={(v) => setOptions({ interactiveHeatmapsSpeeds: v })}
          />

          <BooleanSetting
            id="subtitles-task"
            checked={options.subtitles ?? false}
            headingID="dialogs.scene_gen.subtitles"
            tooltipID="dialogs.scene_gen.subtitles_tooltip"
            onChange={(v) => setOptions({ subtitles: v })}
          />
          <SelectSetting
            id="subtitle-language"
            className="sub-setting"
            disabled={!options.subtitles}
            headingID="dialogs.scene_gen.subtitle_language"
            subHeadingID="dialogs.scene_gen.subtitle_language_desc"
            value={options.subtitleLanguage ?? "en"}
            onChange={(v) => setOptions({ subtitleLanguage: v })}
          >
            {SUBTITLE_LANGUAGES.map((l) => (
              <option value={l.code} key={l.code}>
                {l.label}
              </option>
            ))}
          </SelectSetting>
          <BooleanSetting
            id="translate-task"
            className="sub-setting"
            disabled={!options.subtitles}
            checked={options.translate ?? true}
            headingID="dialogs.scene_gen.translate"
            tooltipID="dialogs.scene_gen.translate_tooltip"
            onChange={(v) => setOptions({ translate: v })}
          />
          <BooleanSetting
            id="dubbing-task"
            checked={options.dubbing ?? false}
            headingID="dialogs.scene_gen.dubbing"
            tooltipID="dialogs.scene_gen.dubbing_tooltip"
            onChange={(v) => setOptions({ dubbing: v })}
          />
        </>
      )}
      {showImageOptions && (
        <>
          <BooleanSetting
            id="clip-previews"
            checked={options.clipPreviews ?? false}
            headingID="dialogs.scene_gen.clip_previews"
            onChange={(v) => setOptions({ clipPreviews: v })}
          />
          <BooleanSetting
            id="image-thumbnails"
            checked={options.imageThumbnails ?? false}
            headingID="dialogs.scene_gen.image_thumbnails"
            onChange={(v) => setOptions({ imageThumbnails: v })}
          />
          <BooleanSetting
            id="image-phash-task"
            checked={options.imagePhashes ?? false}
            headingID="dialogs.scene_gen.image_phash"
            tooltipID="dialogs.scene_gen.image_phash_tooltip"
            onChange={(v) => setOptions({ imagePhashes: v })}
          />
        </>
      )}
      <BooleanSetting
        id="overwrite"
        checked={options.overwrite ?? false}
        headingID="dialogs.scene_gen.overwrite"
        onChange={(v) => setOptions({ overwrite: v })}
      />
    </>
  );
};
