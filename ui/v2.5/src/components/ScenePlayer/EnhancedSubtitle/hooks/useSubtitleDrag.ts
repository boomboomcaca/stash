import { useState, useEffect, useCallback, useRef } from "react";
import { AutoPauseMode } from "./useSubtitleSettings";

interface IDragState {
  y: number;
  startY: number;
  x: number;
  startFontSize: number;
  hasDeterminedMode: boolean;
  initialX: number;
  initialY: number;
}

interface IUseDragProps {
  dragPosition: { y: number };
  setDragPosition: (pos: { y: number }) => void;
  fontSize: number;
  setFontSize: (size: number) => void;
  autoPauseMode: AutoPauseMode;
  setAutoPauseMode: (mode: AutoPauseMode) => void;
  setIsAutoPaused: (paused: boolean) => void;
  onAPDoubleClick?: () => void;
}

interface IUseDragResult {
  isDragging: boolean;
  dragMode: "position" | "size";
  handleAPMouseDown: (e: React.MouseEvent) => void;
  handleAPTouchStart: (e: React.TouchEvent) => void;
  handleAPClick: (e: React.MouseEvent) => void;
}

export function useSubtitleDrag({
  dragPosition,
  setDragPosition,
  fontSize,
  setFontSize,
  autoPauseMode,
  setAutoPauseMode,
  setIsAutoPaused,
  onAPDoubleClick,
}: IUseDragProps): IUseDragResult {
  const [isDragging, setIsDragging] = useState(false);
  const [dragMode, setDragMode] = useState<"position" | "size">("position");
  const [dragStartTime, setDragStartTime] = useState(0);

  const dragStartRef = useRef<IDragState>({
    y: 0,
    startY: 0,
    x: 0,
    startFontSize: 1.0,
    hasDeterminedMode: false,
    initialX: 0,
    initialY: 0,
  });

  const lastAPClickTimeRef = useRef<number>(0);
  const APDoubleClickTimeoutRef = useRef<number | null>(null);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;

      // Use the just-determined mode for this event; the dragMode state is
      // stale in this closure until the next render
      let mode = dragMode;
      if (!dragStartRef.current.hasDeterminedMode) {
        const threshold = 10;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        if (absX > threshold || absY > threshold) {
          mode = absX > absY ? "size" : "position";
          setDragMode(mode);
          dragStartRef.current.hasDeterminedMode = true;
        } else {
          return;
        }
      }

      if (mode === "position") {
        const newY = dragStartRef.current.startY + deltaY;
        const containerHeight = window.innerHeight;
        const containerWidth = window.innerWidth;
        const isPortraitMode = containerHeight > containerWidth;
        const minY = -containerHeight * 0.85;
        const maxY = isPortraitMode
          ? containerHeight * 0.8
          : containerHeight * 0.2;
        setDragPosition({ y: Math.max(minY, Math.min(maxY, newY)) });
      } else if (mode === "size") {
        const sensitivity = 0.003;
        const newSize =
          dragStartRef.current.startFontSize - deltaX * sensitivity;
        const minSize = 0.5;
        const maxSize = 3.0;
        setFontSize(Math.max(minSize, Math.min(maxSize, newSize)));
      }
    },
    [dragMode, setDragPosition, setFontSize]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current.hasDeterminedMode = false;
  }, []);

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      const touch = e.touches[0];
      const deltaX = touch.clientX - dragStartRef.current.x;
      const deltaY = touch.clientY - dragStartRef.current.y;

      // Use the just-determined mode for this event; the dragMode state is
      // stale in this closure until the next render
      let mode = dragMode;
      if (!dragStartRef.current.hasDeterminedMode) {
        const threshold = 1;
        const absX = Math.abs(deltaX);
        const absY = Math.abs(deltaY);

        if (absX > threshold || absY > threshold) {
          mode = absX > absY ? "size" : "position";
          setDragMode(mode);
          dragStartRef.current.hasDeterminedMode = true;
        } else {
          return;
        }
      }

      if (mode === "position") {
        const newY = dragStartRef.current.startY + deltaY;
        const containerHeight = window.innerHeight;
        const containerWidth = window.innerWidth;
        const isPortraitMode = containerHeight > containerWidth;
        const minY = -containerHeight * 0.85;
        const maxY = isPortraitMode
          ? containerHeight * 0.8
          : containerHeight * 0.2;
        setDragPosition({ y: Math.max(minY, Math.min(maxY, newY)) });
      } else if (mode === "size") {
        const sensitivity = 0.003;
        const newSize =
          dragStartRef.current.startFontSize - deltaX * sensitivity;
        const minSize = 0.5;
        const maxSize = 3.0;
        setFontSize(Math.max(minSize, Math.min(maxSize, newSize)));
      }
    },
    [dragMode, setDragPosition, setFontSize]
  );

  const handleTouchEnd = useCallback(() => {
    setIsDragging(false);
    dragStartRef.current.hasDeterminedMode = false;
  }, []);

  useEffect(() => {
    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.addEventListener("touchmove", handleTouchMove, {
        passive: true,
      });
      document.addEventListener("touchend", handleTouchEnd, { passive: true });
      document.body.classList.add("subtitle-dragging");

      return () => {
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
        document.removeEventListener("touchmove", handleTouchMove);
        document.removeEventListener("touchend", handleTouchEnd);
        document.body.classList.remove("subtitle-dragging");
      };
    }
  }, [
    isDragging,
    handleMouseMove,
    handleMouseUp,
    handleTouchMove,
    handleTouchEnd,
  ]);

  const handleAPMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      setDragStartTime(Date.now());
      setIsDragging(true);
      setDragMode("position");

      dragStartRef.current = {
        y: e.clientY,
        startY: dragPosition.y,
        x: e.clientX,
        startFontSize: fontSize,
        hasDeterminedMode: false,
        initialX: e.clientX,
        initialY: e.clientY,
      };

      e.preventDefault();
    },
    [dragPosition.y, fontSize]
  );

  const handleAPTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation();
      const touch = e.touches[0];
      setDragStartTime(Date.now());
      setIsDragging(true);
      setDragMode("position");

      dragStartRef.current = {
        y: touch.clientY,
        startY: dragPosition.y,
        x: touch.clientX,
        startFontSize: fontSize,
        hasDeterminedMode: false,
        initialX: touch.clientX,
        initialY: touch.clientY,
      };
    },
    [dragPosition.y, fontSize]
  );

  const handleAPClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();

      const dragDuration = Date.now() - dragStartTime;
      const deltaX = Math.abs(e.clientX - dragStartRef.current.initialX);
      const deltaY = Math.abs(e.clientY - dragStartRef.current.initialY);
      const totalMovement = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

      const wasClick =
        dragDuration < 200 &&
        totalMovement < 10 &&
        !dragStartRef.current.hasDeterminedMode;

      if (wasClick) {
        const now = Date.now();
        const timeSinceLastClick = now - lastAPClickTimeRef.current;

        if (timeSinceLastClick < 300 && timeSinceLastClick > 0) {
          if (onAPDoubleClick) {
            onAPDoubleClick();
          }

          if (APDoubleClickTimeoutRef.current) {
            clearTimeout(APDoubleClickTimeoutRef.current);
            APDoubleClickTimeoutRef.current = null;
          }
          lastAPClickTimeRef.current = 0;
          return;
        }

        lastAPClickTimeRef.current = now;

        if (APDoubleClickTimeoutRef.current) {
          clearTimeout(APDoubleClickTimeoutRef.current);
        }

        APDoubleClickTimeoutRef.current = window.setTimeout(() => {
          // Cycle: off → favorites → all → off
          const nextMode: AutoPauseMode =
            autoPauseMode === "off"
              ? "favorites"
              : autoPauseMode === "favorites"
                ? "all"
                : "off";
          setAutoPauseMode(nextMode);
          if (nextMode === "off") {
            setIsAutoPaused(false);
          }

          APDoubleClickTimeoutRef.current = null;
        }, 300);
      }
    },
    [
      autoPauseMode,
      dragStartTime,
      onAPDoubleClick,
      setAutoPauseMode,
      setIsAutoPaused,
    ]
  );

  return {
    isDragging,
    dragMode,
    handleAPMouseDown,
    handleAPTouchStart,
    handleAPClick,
  };
}
