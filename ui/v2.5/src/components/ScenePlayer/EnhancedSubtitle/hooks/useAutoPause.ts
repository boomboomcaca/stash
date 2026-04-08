import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { ISubtitleCue } from "../types";

const AUTO_PAUSE_THRESHOLD = 0.02;

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
  // Ref to check if in word navigation mode (for auto-pause when subtitle ends)
  isInWordNavigationModeRef?: React.MutableRefObject<boolean>;
}

interface IUseAutoPauseResult {
  currentCue: ISubtitleCue | null;
  isAutoPaused: boolean;
  setIsAutoPaused: (paused: boolean) => void;
  isPlayerPaused: boolean;
  userResumedPlaybackRef: React.MutableRefObject<boolean>;
  autoPauseTriggeredRef: React.MutableRefObject<boolean>;
  clearAutoPauseTimeout: () => void;
}

export function useAutoPause({
  currentTime,
  parsedSubtitles,
  autoPauseEnabled,
  onPausePlayer,
  getPlayerPaused,
  onCurrentCueChange,
  onGetPlayer,
  isInWordNavigationModeRef,
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

  const rafIdRef = useRef<number | null>(null);

  const clearAutoPauseTimeout = useCallback(() => {
    if (autoPauseTimeoutRef.current !== null) {
      clearTimeout(autoPauseTimeoutRef.current);
      autoPauseTimeoutRef.current = null;
    }
    scheduledCueSignatureRef.current = null;
  }, []);

  const attemptAutoPause = useCallback(() => {
    const isInWordMode = isInWordNavigationModeRef?.current ?? false;
    const shouldAutoPause = autoPauseEnabledRef.current || isInWordMode;
    if (!shouldAutoPause) return;

    const pausePlayer = onPausePlayerRef.current;
    const getPlayer = onGetPlayerRef.current;
    if (!pausePlayer || !getPlayer) return;

    const player = getPlayer();
    if (!player) return;

    const isPaused =
      typeof player.paused === "function" ? player.paused() : player.paused;
    if (
      autoPauseTriggeredRef.current ||
      userResumedPlaybackRef.current ||
      isPaused
    )
      return;

    pausePlayer();
    autoPauseTriggeredRef.current = true;
    setIsAutoPaused(true);
    clearAutoPauseTimeout();
  }, [clearAutoPauseTimeout, isInWordNavigationModeRef]);

  // High-precision monitoring loop
  useEffect(() => {
    const monitor = () => {
      const getPlayer = onGetPlayerRef.current;
      if (!getPlayer) {
        rafIdRef.current = requestAnimationFrame(monitor);
        return;
      }

      const player = getPlayer();
      if (!player) {
        rafIdRef.current = requestAnimationFrame(monitor);
        return;
      }

      const pCurrentTime = player.currentTime();
      const isPaused =
        typeof player.paused === "function" ? player.paused() : player.paused;

      // Sync player paused state to React
      if (lastPausedStateRef.current !== isPaused) {
        setIsPlayerPaused(isPaused);

        // Handle state transitions
        if (lastPausedStateRef.current === false && isPaused === true) {
          if (!isAutoPaused) {
            userResumedPlaybackRef.current = false;
          }
        }

        if (lastPausedStateRef.current === true && isPaused === false) {
          if (autoPauseTriggeredRef.current && isAutoPaused) {
            userResumedPlaybackRef.current = true;
            setIsAutoPaused(false);
            clearAutoPauseTimeout();
          } else if (autoPauseTriggeredRef.current && !isAutoPaused) {
            autoPauseTriggeredRef.current = false;
            userResumedPlaybackRef.current = false;
            clearAutoPauseTimeout();
          }
        }
        lastPausedStateRef.current = isPaused;
      }

      // Detect time jump (seek) within the same cue or any seek that doesn't trigger cue change
      if (lastCurrentTimeRef.current > 0) {
        const timeDiff = pCurrentTime - lastCurrentTimeRef.current;
        // If time goes backwards by > 100ms, or jumps forward by > 500ms, it's a seek
        if (timeDiff < -0.1 || timeDiff > 0.5) {
          autoPauseTriggeredRef.current = false;
          userResumedPlaybackRef.current = false;
          if (isAutoPaused) setIsAutoPaused(false);
          clearAutoPauseTimeout();
        }
      }

      // Auto-pause logic
      const isInWordMode = isInWordNavigationModeRef?.current ?? false;
      const shouldRunAutoPause =
        (autoPauseEnabledRef.current || isInWordMode) && !isPaused;

      if (shouldRunAutoPause && currentCueRef.current) {
        const cue = currentCueRef.current;
        const timeUntilEnd = cue.endTime - pCurrentTime;

        if (timeUntilEnd <= 0) {
          // Defensive: attempt pause even if slightly past endTime.
          // This covers the race condition where a frame gap skips the
          // (0, AUTO_PAUSE_THRESHOLD] window entirely.
          if (
            !autoPauseTriggeredRef.current &&
            !userResumedPlaybackRef.current
          ) {
            attemptAutoPause();
          }
          clearAutoPauseTimeout();
        } else if (timeUntilEnd <= AUTO_PAUSE_THRESHOLD) {
          if (
            !autoPauseTriggeredRef.current &&
            !userResumedPlaybackRef.current
          ) {
            attemptAutoPause();
          }
        }
      }

      lastCurrentTimeRef.current = pCurrentTime;
      rafIdRef.current = requestAnimationFrame(monitor);
    };

    rafIdRef.current = requestAnimationFrame(monitor);
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [
    attemptAutoPause,
    clearAutoPauseTimeout,
    isAutoPaused,
    isInWordNavigationModeRef,
    setIsAutoPaused,
  ]);

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
        autoPauseTimeoutRef.current = null;
        if (scheduledCueSignatureRef.current !== cueSignature) return;
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
    if (!parsedSubtitles) {
      setCurrentCue(null);
      return;
    }

    const { cue, cueIndex } = currentCueData;

    if (cue) {
      const isSameCue =
        lastCueRef.current &&
        cue.startTime === lastCueRef.current.startTime &&
        cue.endTime === lastCueRef.current.endTime;

      if (!isSameCue) {
        autoPauseTriggeredRef.current = false;
        userResumedPlaybackRef.current = false;
        setIsAutoPaused(false);
        lastCueRef.current = cue;
        clearAutoPauseTimeout();
      }

      const isPaused = getPlayerPausedRef.current
        ? getPlayerPausedRef.current()
        : true;
      if (
        !autoPauseTriggeredRef.current &&
        !userResumedPlaybackRef.current &&
        !isPaused
      ) {
        const timeUntilEnd = cue.endTime - currentTime;
        if (timeUntilEnd > AUTO_PAUSE_THRESHOLD) {
          scheduleAutoPause(cue, timeUntilEnd);
        }
      }
    } else {
      lastCueRef.current = null;
      autoPauseTriggeredRef.current = false;
      userResumedPlaybackRef.current = false;
      setIsAutoPaused(false);
      clearAutoPauseTimeout();
    }

    if (cue !== currentCue) {
      setCurrentCue(cue || null);
      if (onCurrentCueChange) {
        onCurrentCueChange(cueIndex);
      }
    }
  }, [
    currentCueData,
    autoPauseEnabled,
    onCurrentCueChange,
    currentCue,
    currentTime,
    clearAutoPauseTimeout,
    parsedSubtitles,
    scheduleAutoPause,
  ]);
  useEffect(() => {
    currentCueRef.current = currentCue;
  }, [currentCue]);

  useEffect(() => {
    autoPauseEnabledRef.current = autoPauseEnabled;
  }, [autoPauseEnabled]);

  useEffect(() => {
    onPausePlayerRef.current = onPausePlayer;
  }, [onPausePlayer]);

  useEffect(() => {
    onGetPlayerRef.current = onGetPlayer;
  }, [onGetPlayer]);

  return {
    currentCue,
    isAutoPaused,
    setIsAutoPaused,
    isPlayerPaused,
    userResumedPlaybackRef,
    autoPauseTriggeredRef,
    clearAutoPauseTimeout,
  };
}
