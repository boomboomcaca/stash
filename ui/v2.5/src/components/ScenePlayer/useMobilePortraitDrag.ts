import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const STORAGE_KEY = "stash-mobile-portrait-video-offset";

export const computeIsMobilePortrait = (
  width?: number,
  height?: number
): boolean => {
  if (typeof width === "number" && typeof height === "number") {
    return width < 1200 && height > width;
  }
  if (typeof window === "undefined") return false;
  return window.innerWidth < 1200 && window.innerHeight > window.innerWidth;
};

export const calculateMaxOffset = (
  viewportHeight: number,
  playerHeight: number = 280,
  baseTop: number = 0,
  bottomPadding: number = 12
): number => {
  const availableSpace =
    viewportHeight - bottomPadding - baseTop - playerHeight;
  return Math.max(0, Math.floor(availableSpace));
};

export const clampOffset = (
  offset: number,
  maxOffset: number,
  minOffset: number = 0,
  snapThreshold: number = 4
): number => {
  const clamped = Math.max(minOffset, Math.min(maxOffset, offset));
  if (clamped < snapThreshold) {
    return 0;
  }
  return clamped;
};

interface IUseMobilePortraitDragOptions {
  fullscreen: boolean;
}

export interface IUseMobilePortraitDragResult {
  containerRef: React.RefObject<HTMLDivElement>;
  isMobilePortrait: boolean;
  isDragging: boolean;
  topOffset: number;
  containerStyle: React.CSSProperties | undefined;
  handleProps: {
    onTouchStart: (e: React.TouchEvent) => void;
    onMouseDown: (e: React.MouseEvent) => void;
    onDoubleClick: (e: React.MouseEvent) => void;
  };
  resetOffset: () => void;
}

export function useMobilePortraitDrag({
  fullscreen,
}: IUseMobilePortraitDragOptions): IUseMobilePortraitDragResult {
  const containerRef = useRef<HTMLDivElement>(null);

  const [isMobilePortrait, setIsMobilePortrait] = useState<boolean>(
    computeIsMobilePortrait()
  );

  const [topOffset, setTopOffset] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = parseFloat(saved);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      }
    } catch {
      // Ignore localStorage errors
    }
    return 0;
  });

  const [isDragging, setIsDragging] = useState(false);

  const currentOffsetRef = useRef(topOffset);
  currentOffsetRef.current = topOffset;

  const dragStartRef = useRef<{
    startY: number;
    startOffset: number;
    hasMoved: boolean;
  }>({
    startY: 0,
    startOffset: 0,
    hasMoved: false,
  });

  const boundsRef = useRef<{ minOffset: number; maxOffset: number }>({
    minOffset: 0,
    maxOffset: 0,
  });

  const lastTapTimeRef = useRef(0);

  const saveOffset = useCallback((offset: number) => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Math.round(offset)));
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const getBounds = useCallback(() => {
    if (typeof window === "undefined") {
      return { minOffset: 0, maxOffset: 0 };
    }
    const viewportHeight = window.innerHeight;
    let playerHeight = 280;
    let baseTop = 0;

    const container = containerRef.current;
    if (container) {
      const rect = container.getBoundingClientRect();
      playerHeight = rect.height;
      baseTop = Math.max(0, rect.top - currentOffsetRef.current);
    }

    // 保留 12px 的底部安全距离，确保下方手柄完全处于屏幕内且不遮挡
    const bottomPadding = 12;
    const maxOffset = calculateMaxOffset(
      viewportHeight,
      playerHeight,
      baseTop,
      bottomPadding
    );

    return {
      minOffset: 0,
      maxOffset,
    };
  }, []);

  // 监听屏幕尺寸和方向变化
  useEffect(() => {
    const handleResize = () => {
      const current = computeIsMobilePortrait();
      setIsMobilePortrait(current);

      if (current && typeof window !== "undefined") {
        const { minOffset, maxOffset } = getBounds();
        setTopOffset((prev) => {
          const clamped = clampOffset(prev, maxOffset, minOffset);
          if (clamped !== prev) {
            saveOffset(clamped);
          }
          return clamped;
        });
      }
    };

    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
    };
  }, [getBounds, saveOffset]);

  // 监听播放器容器尺寸变化（如视频加载、折叠展开等），确保已保存偏移不超出屏幕底部
  useEffect(() => {
    if (!isMobilePortrait || typeof window === "undefined") return;
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => {
      if (isDragging) return;
      const { minOffset, maxOffset } = getBounds();
      setTopOffset((prev) => {
        const clamped = clampOffset(prev, maxOffset, minOffset);
        if (clamped !== prev) {
          saveOffset(clamped);
        }
        return clamped;
      });
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, [isMobilePortrait, isDragging, getBounds, saveOffset]);

  const resetOffset = useCallback(() => {
    setTopOffset(0);
    saveOffset(0);
  }, [saveOffset]);

  // Touch 事件处理
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      boundsRef.current = getBounds();
      dragStartRef.current = {
        startY: touch.clientY,
        startOffset: currentOffsetRef.current,
        hasMoved: false,
      };
      setIsDragging(true);
    },
    [getBounds]
  );

  // 触摸拖动全局监听
  useEffect(() => {
    if (!isDragging) return;

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const deltaY = touch.clientY - dragStartRef.current.startY;
      if (Math.abs(deltaY) > 3) {
        dragStartRef.current.hasMoved = true;
      }

      if (e.cancelable) {
        e.preventDefault();
      }

      const { minOffset, maxOffset } = boundsRef.current;
      const newOffset = clampOffset(
        dragStartRef.current.startOffset + deltaY,
        maxOffset,
        minOffset
      );
      setTopOffset(newOffset);
    };

    const handleTouchEnd = () => {
      setIsDragging(false);

      const now = Date.now();
      // 双击检测（没有发生明显移动且两次点击间隔小于 300ms）
      if (
        !dragStartRef.current.hasMoved &&
        now - lastTapTimeRef.current < 300
      ) {
        setTopOffset(0);
        saveOffset(0);
        lastTapTimeRef.current = 0;
        return;
      }
      lastTapTimeRef.current = now;

      saveOffset(currentOffsetRef.current);
    };

    window.addEventListener("touchmove", handleTouchMove, { passive: false });
    window.addEventListener("touchend", handleTouchEnd);
    window.addEventListener("touchcancel", handleTouchEnd);

    return () => {
      window.removeEventListener("touchmove", handleTouchMove);
      window.removeEventListener("touchend", handleTouchEnd);
      window.removeEventListener("touchcancel", handleTouchEnd);
    };
  }, [isDragging, saveOffset]);

  // 鼠标事件处理（支持在桌面端模拟器或鼠标调试模式下拖拽）
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      boundsRef.current = getBounds();
      dragStartRef.current = {
        startY: e.clientY,
        startOffset: currentOffsetRef.current,
        hasMoved: false,
      };
      setIsDragging(true);
      e.preventDefault();
    },
    [getBounds]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaY = e.clientY - dragStartRef.current.startY;
      if (Math.abs(deltaY) > 3) {
        dragStartRef.current.hasMoved = true;
      }

      const { minOffset, maxOffset } = boundsRef.current;
      const newOffset = clampOffset(
        dragStartRef.current.startOffset + deltaY,
        maxOffset,
        minOffset
      );
      setTopOffset(newOffset);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      saveOffset(currentOffsetRef.current);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, saveOffset]);

  const handleDoubleClick = useCallback(() => {
    resetOffset();
  }, [resetOffset]);

  const containerStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!isMobilePortrait || fullscreen) {
      return undefined;
    }
    return {
      marginTop: `${topOffset}px`,
      transition: isDragging
        ? "none"
        : "margin-top 0.25s cubic-bezier(0.25, 1, 0.5, 1)",
    };
  }, [isMobilePortrait, fullscreen, topOffset, isDragging]);

  const handleProps = useMemo(
    () => ({
      onTouchStart: handleTouchStart,
      onMouseDown: handleMouseDown,
      onDoubleClick: handleDoubleClick,
    }),
    [handleTouchStart, handleMouseDown, handleDoubleClick]
  );

  return {
    containerRef,
    isMobilePortrait,
    isDragging,
    topOffset,
    containerStyle,
    handleProps,
    resetOffset,
  };
}
