import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ISubtitleCue } from "../types";

const AUTO_PAUSE_THRESHOLD = 0.1;

const getCueSignature = (cue: ISubtitleCue) =>
  `${cue.startTime}-${cue.endTime}-${cue.text}`;

interface IParsedSubtitle {
  cues: ISubtitleCue[];
}

interface IUseAutoPauseProps {
  currentTime: number;
  parsedSubtitles: IParsedSubtitle | null;
  autoPauseEnabled: boolean;
  onPausePlayer?: () => void;
  getPlayerPaused?: () => boolean;
  onCurrentCueChange?: (index: number) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onGetPlayer?: () => any;
}

interface IUseAutoPauseResult {
  currentCue: ISubtitleCue | null;
  isAutoPaused: boolean;
  setIsAutoPaused: (paused: boolean) => void;
  isPlayerPaused: boolean;
  userResumedPlaybackRef: React.MutableRefObject<boolean>;
}

export function useAutoPause({
  currentTime,
  parsedSubtitles,
  autoPauseEnabled,
  onPausePlayer,
  getPlayerPaused,
  onCurrentCueChange,
  onGetPlayer,
}: IUseAutoPauseProps): IUseAutoPauseResult {
  const [currentCue, setCurrentCue] = useState<ISubtitleCue | null>(null);
  const [isAutoPaused, setIsAutoPaused] = useState(false);
  const [isPlayerPaused, setIsPlayerPaused] = useState(false);

  const lastCueRef = useRef<ISubtitleCue | null>(null);
  const autoPauseTriggeredRef = useRef(false);
  const lastPausedStateRef = useRef<boolean | null>(null);
  const userResumedPlaybackRef = useRef(false);
  const lastCurrentTimeRef = useRef<number>(0);
  const autoPauseTimeoutRef = useRef<number | null>(null);
  const scheduledCueSignatureRef = useRef<string | null>(null);
  const currentCueRef = useRef<ISubtitleCue | null>(null);
  const autoPauseEnabledRef = useRef<boolean>(autoPauseEnabled);
  const getPlayerPausedRef = useRef<typeof getPlayerPaused>(getPlayerPaused);
  const onPausePlayerRef = useRef<typeof onPausePlayer>(onPausePlayer);
  const onGetPlayerRef = useRef<typeof onGetPlayer>(onGetPlayer);

  const clearAutoPauseTimeout = useCallback(() => {
    if (autoPauseTimeoutRef.current !== null) {
      clearTimeout(autoPauseTimeoutRef.current);
      autoPauseTimeoutRef.current = null;
    }
    scheduledCueSignatureRef.current = null;
  }, []);

  useEffect(() => {
    return () => clearAutoPauseTimeout();
  }, [clearAutoPauseTimeout]);

  useEffect(() => {
    autoPauseEnabledRef.current = autoPauseEnabled;
    if (!autoPauseEnabled) {
      clearAutoPauseTimeout();
    }
  }, [autoPauseEnabled, clearAutoPauseTimeout]);

  useEffect(() => {
    getPlayerPausedRef.current = getPlayerPaused;
  }, [getPlayerPaused]);

  useEffect(() => {
    onPausePlayerRef.current = onPausePlayer;
  }, [onPausePlayer]);

  useEffect(() => {
    onGetPlayerRef.current = onGetPlayer;
  }, [onGetPlayer]);

  useEffect(() => {
    currentCueRef.current = currentCue;
  }, [currentCue]);

  const attemptAutoPause = useCallback(() => {
    if (!autoPauseEnabledRef.current) return;

    const pausePlayer = onPausePlayerRef.current;
    const getPaused = getPlayerPausedRef.current;

    if (!pausePlayer || !getPaused) return;
    if (autoPauseTriggeredRef.current || userResumedPlaybackRef.current) return;
    if (getPaused()) return;

    pausePlayer();
    autoPauseTriggeredRef.current = true;
    setIsAutoPaused(true);
    clearAutoPauseTimeout();
  }, [clearAutoPauseTimeout]);

  const scheduleAutoPause = useCallback(
    (cue: ISubtitleCue, timeUntilEnd: number) => {
      let playbackRate = 1;
      const getPlayer = onGetPlayerRef.current;
      if (getPlayer) {
        try {
          const player = getPlayer();
          if (player && typeof player.playbackRate === "function") {
            playbackRate = player.playbackRate() || 1;
          }
        } catch (error) {
          // ignore
        }
      }

      const videoTimeDelay = Math.max(timeUntilEnd - AUTO_PAUSE_THRESHOLD, 0);
      const delayMs = (videoTimeDelay * 1000) / playbackRate;
      const cueSignature = getCueSignature(cue);

      if (
        scheduledCueSignatureRef.current === cueSignature &&
        autoPauseTimeoutRef.current !== null
      ) {
        return;
      }

      clearAutoPauseTimeout();
      scheduledCueSignatureRef.current = cueSignature;
      autoPauseTimeoutRef.current = setTimeout(() => {
        if (scheduledCueSignatureRef.current !== cueSignature) return;

        const activeCue = currentCueRef.current;
        const activeCueSignature = activeCue
          ? getCueSignature(activeCue)
          : null;

        if (activeCueSignature !== cueSignature) return;

        attemptAutoPause();
      }, delayMs);
    },
    [attemptAutoPause, clearAutoPauseTimeout]
  );

  const currentCueData = useMemo(() => {
    if (!parsedSubtitles) {
      return { cue: null, cueIndex: -1 };
    }

    const { cues } = parsedSubtitles;
    let cue: ISubtitleCue | null = null;
    let cueIndex = -1;

    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (currentTime >= c.startTime && currentTime <= c.endTime) {
        cue = c;
        cueIndex = i;
        break;
      }
      if (currentTime < c.startTime) {
        break;
      }
    }

    return { cue, cueIndex };
  }, [currentTime, parsedSubtitles]);

  useEffect(() => {
    if (getPlayerPaused) {
      const paused = getPlayerPaused();
      setIsPlayerPaused(paused);
    }
  }, [currentTime, getPlayerPaused]);

  useEffect(() => {
    if (!parsedSubtitles) {
      setCurrentCue(null);
      return;
    }

    const { cue, cueIndex } = currentCueData;

    if (autoPauseEnabled && onPausePlayer && getPlayerPaused) {
      const isPaused = getPlayerPaused();

      const isSameCue =
        cue &&
        lastCueRef.current &&
        cue.startTime === lastCueRef.current.startTime &&
        cue.endTime === lastCueRef.current.endTime &&
        cue.text === lastCueRef.current.text;

      if (cue && isSameCue && autoPauseTriggeredRef.current) {
        const timeDiff = currentTime - lastCurrentTimeRef.current;
        const isNearStart = Math.abs(currentTime - cue.startTime) < 0.5;

        if (timeDiff < -0.5 && isNearStart) {
          autoPauseTriggeredRef.current = false;
          userResumedPlaybackRef.current = false;
          setIsAutoPaused(false);
          clearAutoPauseTimeout();
        }
      }

      if (cue && !isSameCue) {
        autoPauseTriggeredRef.current = false;
        userResumedPlaybackRef.current = false;
        setIsAutoPaused(false);
        lastCueRef.current = cue;
        lastPausedStateRef.current = isPaused;
        clearAutoPauseTimeout();
      }

      if (lastPausedStateRef.current === false && isPaused === true) {
        if (!isAutoPaused) {
          userResumedPlaybackRef.current = false;
        }
      }

      if (lastPausedStateRef.current === true && isPaused === false) {
        if (autoPauseTriggeredRef.current && isAutoPaused) {
          userResumedPlaybackRef.current = true;
          setIsAutoPaused(false);
          lastPausedStateRef.current = isPaused;
          clearAutoPauseTimeout();
          return;
        } else if (autoPauseTriggeredRef.current && !isAutoPaused) {
          autoPauseTriggeredRef.current = false;
          userResumedPlaybackRef.current = false;
          clearAutoPauseTimeout();
        }
      }

      lastPausedStateRef.current = isPaused;

      if (
        cue &&
        !autoPauseTriggeredRef.current &&
        !userResumedPlaybackRef.current &&
        !isPaused
      ) {
        const timeUntilEnd = cue.endTime - currentTime;

        if (timeUntilEnd <= 0) {
          clearAutoPauseTimeout();
        } else if (timeUntilEnd <= AUTO_PAUSE_THRESHOLD) {
          attemptAutoPause();
        } else {
          scheduleAutoPause(cue, timeUntilEnd);
        }
      } else {
        clearAutoPauseTimeout();
      }

      if (!cue) {
        lastCueRef.current = null;
        autoPauseTriggeredRef.current = false;
        userResumedPlaybackRef.current = false;
        setIsAutoPaused(false);
        clearAutoPauseTimeout();
      }
    }

    const isSameCueContent =
      cue &&
      currentCue &&
      cue.startTime === currentCue.startTime &&
      cue.endTime === currentCue.endTime &&
      cue.text === currentCue.text;

    if (!isSameCueContent) {
      setCurrentCue(cue || null);

      if (onCurrentCueChange) {
        onCurrentCueChange(cueIndex);
      }
    }

    lastCurrentTimeRef.current = currentTime;
  }, [
    currentCueData,
    autoPauseEnabled,
    onPausePlayer,
    getPlayerPaused,
    onCurrentCueChange,
    currentCue,
    currentTime,
    attemptAutoPause,
    clearAutoPauseTimeout,
    isAutoPaused,
    parsedSubtitles,
    scheduleAutoPause,
  ]);

  return {
    currentCue,
    isAutoPaused,
    setIsAutoPaused,
    isPlayerPaused,
    userResumedPlaybackRef,
  };
}
