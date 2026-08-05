import { debounce } from "lodash-es";
import videojs, { VideoJsPlayer } from "video.js";

export interface ISource extends videojs.Tech.SourceObject {
  offset?: boolean;
  duration?: number;
}

interface ICue extends TextTrackCue {
  _startTime?: number;
  _endTime?: number;
}

// delay before loading new source after setting currentTime
const loadDelay = 200;

// last-resort watchdog: if a reloaded transcode never reaches a terminal media
// event (canplay/loadeddata/error), reset the seeking gate anyway so play() can
// never be wedged forever. Generous because a cold transcode seek can be slow.
const seekWatchdogMs = 30000;

function offsetMiddleware(player: VideoJsPlayer) {
  // biome-ignore lint/suspicious/noExplicitAny: allow access to private tech methods
  let tech: any;
  let source: ISource;
  let offsetStart: number | undefined;
  let seeking = 0;
  // listeners/timer for the in-flight reload, so a superseded reload's handlers
  // can be torn down before arming the next one (avoids a stale handler
  // resetting `seeking` for the wrong request).
  let seekWatchdog: ReturnType<typeof setTimeout> | undefined;
  let detachSeekListeners: (() => void) | undefined;

  function clearSeekSettlers() {
    if (seekWatchdog !== undefined) {
      clearTimeout(seekWatchdog);
      seekWatchdog = undefined;
    }
    if (detachSeekListeners) {
      detachSeekListeners();
      detachSeekListeners = undefined;
    }
  }

  // Cancel any in-flight reload watchdog/listeners when the player is disposed,
  // so an orphaned 30s timer can't fire settle() on a torn-down player.
  player.on("dispose", clearSeekSettlers);

  function initCues(cues: TextTrackCueList) {
    const offset = offsetStart ?? 0;
    for (let j = 0; j < cues.length; j++) {
      const cue = cues[j] as ICue;
      cue._startTime = cue.startTime;
      cue.startTime = cue._startTime - offset;
      cue._endTime = cue.endTime;
      cue.endTime = cue._endTime - offset;
    }
  }

  function updateOffsetStart(offset: number | undefined) {
    offsetStart = offset;

    if (!tech) return;
    offset = offset ?? 0;

    const tracks = tech.remoteTextTracks();
    for (let i = 0; i < tracks.length; i++) {
      const { cues } = tracks[i];
      if (cues) {
        for (let j = 0; j < cues.length; j++) {
          const cue = cues[j] as ICue;
          if (cue._startTime === undefined || cue._endTime === undefined) {
            continue;
          }
          cue.startTime = cue._startTime - offset;
          cue.endTime = cue._endTime - offset;
        }
      }
    }
  }

  const loadSource = debounce(
    (seconds: number) => {
      // The player may have been disposed during the trailing debounce window;
      // touching tech/player below would then throw on nulled internals.
      if (player.isDisposed()) return;
      const srcUrl = new URL(source.src);
      srcUrl.searchParams.set("start", seconds.toString());
      source.src = srcUrl.toString();

      const poster = player.poster();
      const playbackRate = tech.playbackRate();
      seeking = tech.paused() ? 1 : 2;
      player.poster("");
      tech.setSource(source);
      tech.setPlaybackRate(playbackRate);

      // tear down any listeners/timer from a previous, now-superseded reload
      clearSeekSettlers();

      // Reset the `seeking` gate on ANY terminal outcome, not just `canplay`.
      // `seeking` blocks play() through callPlay()'s TERMINATOR; if the reloaded
      // /stream.mp4?start= transcode errors, 500s, or never emits `canplay`
      // (e.g. ffmpeg cannot seek to that offset / emits an unparseable initial
      // fragment), leaving `seeking` set would permanently freeze the player
      // after a seek. Settle on canplay/loadeddata/error and via a watchdog.
      const settle = () => {
        clearSeekSettlers();
        player.poster(poster);
        // Honour the paused-before-seek intent on EVERY settle path, not just
        // success. If a cold transcode seek takes longer than the watchdog, the
        // watchdog runs settle() and detaches the canplay listener; without
        // pausing here the pending tech.play() from the reload would resume a
        // scene the user had paused. Calling pause() also aborts that pending
        // play() so a late canplay can't auto-start it.
        if (seeking === 1 || tech.scrubbing()) {
          tech.pause();
        }
        seeking = 0;
      };
      detachSeekListeners = () => {
        tech.off("canplay", settle);
        tech.off("loadeddata", settle);
        tech.off("error", settle);
      };
      tech.one("canplay", settle);
      tech.one("loadeddata", settle); // some streams settle without a fresh canplay
      tech.one("error", settle); // transcode/HTTP failure must not wedge play()
      seekWatchdog = setTimeout(settle, seekWatchdogMs);

      tech.trigger("timeupdate");
      tech.trigger("pause");
      tech.trigger("seeking");
      tech.play();
    },
    loadDelay,
    // coalesce a burst of scrub seeks into ONE transcode restart at the final
    // target. With leading:true a burst spawned two competing ffmpeg processes
    // (the first immediately torn down), thrashing the CPU and slowing the seek.
    { leading: false, trailing: true }
  );

  // A trailing-debounced reload can still be pending when the player is
  // disposed; cancel it so it can't run setSource/play() on a torn-down tech.
  player.on("dispose", () => loadSource.cancel());

  return {
    setTech(newTech: videojs.Tech) {
      tech = newTech;

      const _addRemoteTextTrack = tech.addRemoteTextTrack.bind(tech);
      function addRemoteTextTrack(
        this: VideoJsPlayer,
        options: videojs.TextTrackOptions,
        manualCleanup: boolean
      ) {
        const textTrack = _addRemoteTextTrack(options, manualCleanup);
        textTrack.addEventListener("load", () => {
          const { cues } = textTrack.track;
          if (cues) {
            initCues(cues);
          }
        });

        return textTrack;
      }
      tech.addRemoteTextTrack = addRemoteTextTrack;

      const trackEls: HTMLTrackElement[] = tech.remoteTextTrackEls();
      for (let i = 0; i < trackEls.length; i++) {
        const trackEl = trackEls[i];
        const { track } = trackEl;
        if (track.cues) {
          initCues(track.cues);
        } else {
          trackEl.addEventListener("load", () => {
            if (track.cues) {
              initCues(track.cues);
            }
          });
        }
      }
    },
    setSource(
      srcObj: ISource,
      next: (err: unknown, src: videojs.Tech.SourceObject) => void
    ) {
      if (srcObj.offset && srcObj.duration) {
        updateOffsetStart(0);
      } else {
        updateOffsetStart(undefined);
      }
      source = srcObj;
      next(null, srcObj);
    },
    duration(seconds: number) {
      if (source.duration) {
        return source.duration;
      } else {
        return seconds;
      }
    },
    buffered(buffers: TimeRanges) {
      if (offsetStart === undefined) {
        return buffers;
      }

      const timeRanges: number[][] = [];
      for (let i = 0; i < buffers.length; i++) {
        const start = buffers.start(i) + offsetStart;
        const end = buffers.end(i) + offsetStart;

        timeRanges.push([start, end]);
      }

      // types for createTimeRanges are incorrect, should be number[][] not TimeRange[]
      // biome-ignore lint/suspicious/noExplicitAny: intentional
      return videojs.createTimeRanges(timeRanges as any);
    },
    currentTime(seconds: number) {
      return (offsetStart ?? 0) + seconds;
    },
    setCurrentTime(seconds: number) {
      if (offsetStart === undefined) {
        return seconds;
      }

      const offsetSeconds = seconds - offsetStart;
      const buffers = tech.buffered() as TimeRanges;
      for (let i = 0; i < buffers.length; i++) {
        const start = buffers.start(i);
        const end = buffers.end(i);
        // seek point is in buffer, just seek normally
        if (start <= offsetSeconds && offsetSeconds <= end) {
          return offsetSeconds;
        }
      }

      updateOffsetStart(seconds);

      loadSource(seconds);

      return 0;
    },
    callPlay() {
      if (seeking) {
        seeking = 2;
        return videojs.middleware.TERMINATOR;
      }
    },
  };
}

videojs.use("*", offsetMiddleware);
