import { useEffect, useRef } from "react";
import { VideoJsPlayer } from "video.js";
import * as GQL from "src/core/generated-graphql";
// import { ConnectionState } from "src/hooks/Interactive/context";
import { isPseudoFullscreen } from "./util";

interface IUsePlayerEventsProps {
  getPlayer: () => VideoJsPlayer | null;
  scene: GQL.SceneDataFragment;
  file: GQL.VideoFileDataFragment | undefined;
  sceneId: React.MutableRefObject<string | undefined>;
  interactiveClient: { play: (time: number) => void; pause: () => void };
  interactiveReady: React.MutableRefObject<boolean>;
  started: React.MutableRefObject<boolean>;
  setReady: (value: boolean) => void;
  setTime: (value: number) => void;
  setFullscreen: (value: boolean) => void;
  onComplete: () => void;
}

export function usePlayerEvents({
  getPlayer,
  scene,
  // file,
  // sceneId,
  interactiveClient,
  interactiveReady,
  started,
  setReady,
  setTime,
  setFullscreen,
  onComplete,
}: IUsePlayerEventsProps) {
  // Player event handlers
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    function canplay(this: VideoJsPlayer) {
      // if we're seeking before starting, don't set the initial timestamp
      // when starting from the beginning, there is a small delay before the event
      // is triggered, so we can't just check if the time is 0
      if (this.currentTime() >= 0.1) {
        return;
      }
    }

    function playing(this: VideoJsPlayer) {
      // This still runs even if autoplay failed on Safari,
      // only set flag if actually playing
      if (!started.current && !this.paused()) {
        started.current = true;
      }
    }

    function loadstart(this: VideoJsPlayer) {
      setReady(true);
    }

    function fullscreenchange(this: VideoJsPlayer) {
      setFullscreen(isPseudoFullscreen());
    }

    player.on("canplay", canplay);
    player.on("playing", playing);
    player.on("loadstart", loadstart);
    player.on("fullscreenchange", fullscreenchange);

    return () => {
      player.off("canplay", canplay);
      player.off("playing", playing);
      player.off("loadstart", loadstart);
      player.off("fullscreenchange", fullscreenchange);
    };
  }, [getPlayer, started, setReady, setFullscreen]);

  // delay before second play event after a play event to adjust for video player issues
  const DELAY_FOR_SECOND_PLAY_MS = 1000;
  const playingTimer = useRef<number>();

  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    function playing(this: VideoJsPlayer) {
      if (scene.interactive && interactiveReady.current) {
        interactiveClient.play(this.currentTime());
        // trigger a second script play event to adjust for video player issues
        clearTimeout(playingTimer.current);
        playingTimer.current = setTimeout(() => {
          if (this.paused()) return;
          interactiveClient.play(this.currentTime());
        }, DELAY_FOR_SECOND_PLAY_MS);
      }
    }

    function pause(this: VideoJsPlayer) {
      interactiveClient.pause();
    }

    function timeupdate(this: VideoJsPlayer) {
      // Always update time, even when paused, to handle seek operations
      setTime(this.currentTime());
    }

    player.on("playing", playing);
    player.on("pause", pause);
    player.on("timeupdate", timeupdate);

    return () => {
      player.off("playing", playing);
      player.off("pause", pause);
      player.off("timeupdate", timeupdate);
      clearTimeout(playingTimer.current);
    };
  }, [getPlayer, interactiveClient, scene, interactiveReady, setTime]);

  // Attach handler for onComplete event
  useEffect(() => {
    const player = getPlayer();
    if (!player) return;

    player.on("ended", onComplete);

    return () => player.off("ended");
  }, [getPlayer, onComplete]);

  useEffect(() => {
    return () => {
      // stop the interactive client on unmount
      interactiveClient.pause();
    };
  }, [interactiveClient]);
}
