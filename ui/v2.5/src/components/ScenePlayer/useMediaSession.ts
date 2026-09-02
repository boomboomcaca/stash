import { useEffect } from "react";
import videojs from "video.js";
import { objectTitle } from "src/core/files";
import * as GQL from "src/core/generated-graphql";

interface IUseMediaSessionProps {
  getPlayer: () => videojs.Player | null | undefined;
  scene: GQL.SceneDataFragment;
  onNext?: () => void;
  onPrevious?: () => void;
}

export function useMediaSession({
  getPlayer,
  scene,
  onNext,
  onPrevious,
}: IUseMediaSessionProps) {
  // Update Metadata
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const title = objectTitle(scene);
    const artist = scene.studio?.name || "";
    const album = scene.code || "";

    // Construct artwork array
    const artwork = [];
    if (scene.paths.screenshot) {
      artwork.push({
        src: scene.paths.screenshot,
        sizes: "1920x1080", // Approximate
        type: "image/jpeg",
      });
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title,
      artist,
      album,
      artwork,
    });
  }, [scene]);

  // Setup Action Handlers
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;

    const actionHandlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      [
        "play",
        () => {
          getPlayer()?.play();
        },
      ],
      [
        "pause",
        () => {
          getPlayer()?.pause();
        },
      ],
      [
        "seekbackward",
        (details) => {
          const p = getPlayer();
          if (p) {
            const skipTime = details.seekOffset || 10;
            p.currentTime(Math.max(p.currentTime() - skipTime, 0));
          }
        },
      ],
      [
        "seekforward",
        (details) => {
          const p = getPlayer();
          if (p) {
            const skipTime = details.seekOffset || 10;
            p.currentTime(Math.min(p.currentTime() + skipTime, p.duration()));
          }
        },
      ],
      [
        "seekto",
        (details) => {
          const p = getPlayer();
          if (
            p &&
            details.seekTime !== undefined &&
            details.seekTime !== null
          ) {
            p.currentTime(details.seekTime);
          }
        },
      ],
    ];

    if (onPrevious) {
      actionHandlers.push([
        "previoustrack",
        () => {
          onPrevious();
        },
      ]);
    }

    if (onNext) {
      actionHandlers.push([
        "nexttrack",
        () => {
          onNext();
        },
      ]);
    }

    actionHandlers.forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // ignore unsupported actions
      }
    });

    return () => {
      // Cleanup handlers is not strictly necessary as they are replaced,
      // but good practice if we were unmounting completely.
      // However, removing them might clear them for other players if multiple exist,
      // so we rely on the next effect setup to overwrite them.
    };
  }, [getPlayer, onNext, onPrevious]);

  // Update Playback State
  useEffect(() => {
    const player = getPlayer();
    if (!player || !("mediaSession" in navigator)) return;

    const updateState = () => {
      if (player.paused()) {
        navigator.mediaSession.playbackState = "paused";
      } else {
        navigator.mediaSession.playbackState = "playing";
      }
    };

    player.on("play", updateState);
    player.on("pause", updateState);
    player.on("ended", () => {
      navigator.mediaSession.playbackState = "none";
    });

    return () => {
      player.off("play", updateState);
      player.off("pause", updateState);
      player.off("ended", updateState);
    };
  }, [getPlayer]);
}
