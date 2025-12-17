import { useState, useEffect, useCallback, useRef } from "react";
import { ISubtitleCue } from "../types";

interface IParsedSubtitle {
  cues: ISubtitleCue[];
}

interface IUseSubtitleParserProps {
  subtitleTrack: string | null;
  onSubtitlesLoaded?: (cues: ISubtitleCue[]) => void;
}

interface IUseSubtitleParserResult {
  parsedSubtitles: IParsedSubtitle | null;
}

export function useSubtitleParser({
  subtitleTrack,
  onSubtitlesLoaded,
}: IUseSubtitleParserProps): IUseSubtitleParserResult {
  const [parsedSubtitles, setParsedSubtitles] =
    useState<IParsedSubtitle | null>(null);
  const subtitleCacheRef = useRef<Map<string, ISubtitleCue[]>>(new Map());

  // Parse VTT timestamp to seconds
  const parseVTTTime = (timeStr: string): number => {
    const [hours, minutes, seconds] = timeStr.split(":");
    return (
      parseInt(hours) * 3600 + parseInt(minutes) * 60 + parseFloat(seconds)
    );
  };

  // Parse VTT subtitles
  const parseVTT = useCallback((vttContent: string): ISubtitleCue[] => {
    const cues: ISubtitleCue[] = [];
    const lines = vttContent.split("\n");

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();

      if (line === "WEBVTT" || line === "" || line.startsWith("NOTE")) {
        i++;
        continue;
      }

      const timeMatch = line.match(
        /^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})/
      );
      if (timeMatch) {
        const startTime = parseVTTTime(timeMatch[1]);
        const endTime = parseVTTTime(timeMatch[2]);

        i++;
        let text = "";

        while (
          i < lines.length &&
          lines[i].trim() !== "" &&
          !lines[i].match(/^\d{2}:\d{2}:\d{2}\.\d{3} -->/)
        ) {
          if (text) text += "\n";
          text += lines[i].trim().replace(/<[^>]*>/g, "");
          i++;
        }

        if (text) {
          cues.push({ startTime, endTime, text });
        }
      } else {
        i++;
      }
    }

    return cues;
  }, []);

  // Load and parse subtitle file
  useEffect(() => {
    if (!subtitleTrack) {
      setParsedSubtitles(null);
      return;
    }

    const abortController = new AbortController();
    let cancelled = false;

    const loadSubtitles = async () => {
      try {
        const cachedCues = subtitleCacheRef.current.get(subtitleTrack);
        if (cachedCues) {
          if (cancelled) return;
          setParsedSubtitles({ cues: cachedCues });
          if (onSubtitlesLoaded) {
            onSubtitlesLoaded(cachedCues);
          }
          return;
        }

        const response = await fetch(subtitleTrack, {
          signal: abortController.signal,
        });

        if (cancelled) return;

        if (response.ok) {
          const content = await response.text();

          if (cancelled) return;

          const cues = parseVTT(content);
          subtitleCacheRef.current.set(subtitleTrack, cues);

          setParsedSubtitles({ cues });
          if (onSubtitlesLoaded) {
            onSubtitlesLoaded(cues);
          }
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }
        console.error("Failed to load subtitles:", error);
        if (!cancelled) {
          setParsedSubtitles(null);
        }
      }
    };

    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        loadSubtitles();
      }
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [subtitleTrack, parseVTT, onSubtitlesLoaded]);

  return {
    parsedSubtitles,
  };
}
