import React, {
  CSSProperties,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { Button } from "react-bootstrap";
import * as GQL from "src/core/generated-graphql";
import TextUtils from "src/utils/text";
import { Icon } from "src/components/Shared/Icon";
import {
  faChevronRight,
  faChevronLeft,
} from "@fortawesome/free-solid-svg-icons";
import { useSpriteInfo } from "src/hooks/sprite";

interface IScenePlayerScrubberProps {
  file: GQL.VideoFileDataFragment;
  scene: GQL.SceneDataFragment;
  time: number;
  onSeek: (seconds: number, isDragging?: boolean) => void;
  onScroll: () => void;
}

interface ISceneSpriteItem {
  style: CSSProperties;
  time: string;
}

const scrubberViewportHeight = 120;
const scrubberTagsHeight = 30;
const scrubberSpriteHeight = scrubberViewportHeight - scrubberTagsHeight;

export const ScenePlayerScrubber: React.FC<IScenePlayerScrubberProps> = ({
  file,
  scene,
  time,
  onSeek,
  onScroll,
}) => {
  const contentEl = useRef<HTMLDivElement>(null);
  const indicatorEl = useRef<HTMLDivElement>(null);
  const sliderEl = useRef<HTMLDivElement>(null);
  const mouseDown = useRef(false);
  const lastMouseEvent = useRef<MouseEvent | null>(null);
  const startMouseEvent = useRef<MouseEvent | null>(null);
  const velocity = useRef(0);

  // Touch event handling
  const touchDown = useRef(false);
  const lastTouchEvent = useRef<TouchEvent | null>(null);
  const startTouchEvent = useRef<TouchEvent | null>(null);
  const isDragging = useRef(false);
  const dragThreshold = 5; // Minimum pixels to consider as drag
  const lastUpdateTime = useRef(0);
  const UPDATE_THROTTLE = 16; // 约60fps的更新频率

  const prevTime = useRef(NaN);
  const _width = useRef(0);
  const [width, setWidth] = useState(0);
  const [scrubWidth, setScrubWidth] = useState(0);
  const position = useRef(0);
  const setPosition = useCallback(
    (value: number, seek: boolean, isDraggingArg?: boolean) => {
      if (!scrubWidth) return;

      const slider = sliderEl.current!;
      const indicator = indicatorEl.current!;

      const midpointOffset = slider.clientWidth / 2;

      let newPosition: number;
      let percentage: number;
      if (value >= midpointOffset) {
        percentage = 0;
        newPosition = midpointOffset;
      } else if (value <= midpointOffset - scrubWidth) {
        percentage = 1;
        newPosition = midpointOffset - scrubWidth;
      } else {
        percentage = (midpointOffset - value) / scrubWidth;
        newPosition = value;
      }

      slider.style.transform = `translateX(${newPosition}px)`;
      indicator.style.transform = `translateX(${percentage * 100}%)`;

      position.current = newPosition;

      if (seek) {
        onSeek(percentage * (file.duration || 0), isDraggingArg);
      }
    },
    [onSeek, file.duration, scrubWidth]
  );

  const spriteInfo = useSpriteInfo(scene.paths.vtt ?? undefined);
  const [spriteItems, setSpriteItems] = useState<ISceneSpriteItem[]>();

  useEffect(() => {
    if (!spriteInfo || spriteInfo.length === 0) return;
    let totalWidth = 0;

    // calculate total width/height of scrubber image so we can scale it
    const maxX = Math.max(...spriteInfo.map((sprite) => sprite.x + sprite.w));
    const maxY = Math.max(...spriteInfo.map((sprite) => sprite.y + sprite.h));
    const spriteWidth = spriteInfo[0].w;
    const spriteHeight = spriteInfo[0].h;
    const scale = scrubberSpriteHeight / spriteHeight;

    const w = spriteWidth * scale;
    const h = scrubberSpriteHeight;

    const sizeX = maxX * scale;
    const sizeY = maxY * scale;

    // scale sprite dimensions to fit scrubber height, and calculate background position for each sprite
    const newSprites = spriteInfo?.map((sprite, index) => {
      totalWidth += w;
      const left = w * index;

      const spriteX = sprite.x * scale;
      const spriteY = sprite.y * scale;

      const style = {
        width: `${w}px`,
        height: `${h}px`,
        backgroundPosition: `${-spriteX}px ${-spriteY}px`,
        backgroundImage: `url(${sprite.url})`,
        backgroundSize: `${sizeX}px ${sizeY}px`,
        left: `${left}px`,
      };
      const start = TextUtils.secondsToTimestamp(sprite.start);
      const end = TextUtils.secondsToTimestamp(sprite.end);
      return {
        style,
        time: `${start} - ${end}`,
      };
    });
    setScrubWidth(totalWidth);
    setSpriteItems(newSprites);
  }, [spriteInfo]);

  useEffect(() => {
    const onResize = (entries: ResizeObserverEntry[]) => {
      const newWidth = entries[0].target.clientWidth;
      if (_width.current !== newWidth) {
        // set prevTime to NaN to not use a transition when updating the slider position
        prevTime.current = NaN;
        _width.current = newWidth;
        setWidth(newWidth);
      }
    };

    const content = contentEl.current!;
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(content);

    return () => {
      resizeObserver.unobserve(content);
    };
  }, []);

  const setEaseOutTransition = useCallback(() => {
    const slider = sliderEl.current!;
    slider.style.transition = "333ms ease-out";
  }, []);

  const clearTransition = useCallback(() => {
    const slider = sliderEl.current!;
    slider.style.transition = "";
  }, []);

  // Update slider position when player time changes
  useEffect(() => {
    function setLinearTransition() {
      const slider = sliderEl.current!;
      slider.style.transition = "500ms linear";
    }

    if (!scrubWidth || !width) return;

    const duration = Number(file.duration);
    const percentage = time / duration;
    const newPosition = width / 2 - percentage * scrubWidth;

    // Ignore position changes of < 1px
    if (Math.abs(newPosition - position.current) < 1) return;

    const delta = Math.abs(time - prevTime.current);
    if (Number.isNaN(delta)) {
      // Don't use a transition on initial time change or after resize
      clearTransition();
    } else if (delta <= 1) {
      // If time changed by < 1s, use linear transition instead of ease-out
      setLinearTransition();
    } else {
      setEaseOutTransition();
    }
    prevTime.current = time;

    setPosition(newPosition, false);
  }, [
    file.duration,
    setPosition,
    time,
    width,
    scrubWidth,
    clearTransition,
    setEaseOutTransition,
  ]);

  const onMouseUp = useCallback(
    (event: MouseEvent) => {
      if (!mouseDown.current) return;
      const slider = sliderEl.current!;

      mouseDown.current = false;
      isDragging.current = false;

      contentEl.current!.classList.remove("dragging");

      let newPosition = position.current;
      const midpointOffset = slider.clientWidth / 2;
      const delta = Math.abs(event.clientX - startMouseEvent.current!.clientX);
      if (delta < dragThreshold && event.target instanceof HTMLDivElement) {
        const { target } = event;

        if (target.hasAttribute("data-sprite-item-id")) {
          newPosition = midpointOffset - (target.offsetLeft + event.offsetX);
        }

        if (target.hasAttribute("data-marker-id")) {
          newPosition = midpointOffset - target.offsetLeft;
        }
      }
      if (Math.abs(velocity.current) > 25) {
        newPosition = position.current + velocity.current * 10;
        velocity.current = 0;
      }

      setEaseOutTransition();
      setPosition(newPosition, true, false); // 拖拽结束时，非拖拽模式
    },
    [setPosition, setEaseOutTransition]
  );

  const onMouseDown = useCallback((event: MouseEvent) => {
    // Only if left mouse button pressed
    if (event.button !== 0) return;

    event.preventDefault();

    mouseDown.current = true;
    lastMouseEvent.current = event;
    startMouseEvent.current = event;
    velocity.current = 0;
  }, []);

  const onMouseMove = useCallback(
    (event: MouseEvent) => {
      if (!mouseDown.current) return;

      // negative dragging right (past), positive left (future)
      const delta = event.clientX - lastMouseEvent.current!.clientX;

      if (lastMouseEvent.current === startMouseEvent.current) {
        // this is the first mousemove event after mousedown

        // #4295: a mousemove with delta 0 can be sent when just clicking
        // ignore such an event to prevent pausing the player
        if (delta === 0) return;

        // Check if this qualifies as a drag
        const totalDelta = Math.abs(
          event.clientX - startMouseEvent.current!.clientX
        );
        if (totalDelta >= dragThreshold) {
          isDragging.current = true;
          onScroll();
        }
      }

      if (isDragging.current) {
        contentEl.current!.classList.add("dragging");

        const movement = event.movementX;
        velocity.current = movement;

        clearTransition();

        // 使用节流减少频繁更新
        const now = performance.now();
        if (now - lastUpdateTime.current >= UPDATE_THROTTLE) {
          const newPosition = position.current + delta;
          setPosition(newPosition, true, true); // 在拖拽时实时更新视频帧
          lastUpdateTime.current = now;
        } else {
          // 只更新位置，不触发视频seek
          const newPosition = position.current + delta;
          setPosition(newPosition, false);
        }
      }

      lastMouseEvent.current = event;
    },
    [onScroll, setPosition, clearTransition]
  );

  // Touch event handlers
  const onTouchStart = useCallback((event: TouchEvent) => {
    if (event.touches.length !== 1) return;

    event.preventDefault();

    touchDown.current = true;
    lastTouchEvent.current = event;
    startTouchEvent.current = event;
    velocity.current = 0;
    isDragging.current = false;
  }, []);

  const onTouchMove = useCallback(
    (event: TouchEvent) => {
      if (!touchDown.current || event.touches.length !== 1) return;

      const touch = event.touches[0];
      const lastTouch = lastTouchEvent.current!.touches[0];

      // negative dragging right (past), positive left (future)
      const delta = touch.clientX - lastTouch.clientX;

      if (lastTouchEvent.current === startTouchEvent.current) {
        // this is the first touchmove event after touchstart
        const totalDelta = Math.abs(
          touch.clientX - startTouchEvent.current!.touches[0].clientX
        );
        if (totalDelta >= dragThreshold) {
          isDragging.current = true;
          onScroll();
          event.preventDefault(); // Prevent scrolling and other touch behaviors
        }
      }

      if (isDragging.current) {
        event.preventDefault();
        contentEl.current!.classList.add("dragging");

        const movement = touch.clientX - lastTouch.clientX;
        velocity.current = movement;

        clearTransition();

        // 降低拖拽灵敏度（0.1倍）
        const sensitivity = 0.1;
        const adjustedDelta = delta * sensitivity;

        // 使用节流减少频繁更新
        const now = performance.now();
        if (now - lastUpdateTime.current >= UPDATE_THROTTLE) {
          const newPosition = position.current + adjustedDelta;
          setPosition(newPosition, true, true); // 在触摸拖拽时实时更新视频帧
          lastUpdateTime.current = now;
        } else {
          // 只更新位置，不触发视频seek
          const newPosition = position.current + adjustedDelta;
          setPosition(newPosition, false);
        }
      }

      lastTouchEvent.current = event;
    },
    [onScroll, setPosition, clearTransition]
  );

  const onTouchEnd = useCallback(
    (event: TouchEvent) => {
      if (!touchDown.current) return;

      const slider = sliderEl.current!;

      touchDown.current = false;
      const wasDragging = isDragging.current;
      isDragging.current = false;

      contentEl.current!.classList.remove("dragging");

      // If it was a drag, handle the end position
      if (wasDragging) {
        let newPosition = position.current;

        if (Math.abs(velocity.current) > 25) {
          newPosition = position.current + velocity.current * 10;
          velocity.current = 0;
        }

        setEaseOutTransition();
        setPosition(newPosition, true, false); // 触摸拖拽结束时，非拖拽模式
      } else {
        // Handle tap (click equivalent)
        const touch = event.changedTouches[0];
        const startTouch = startTouchEvent.current!.touches[0];
        const delta = Math.abs(touch.clientX - startTouch.clientX);

        if (delta < dragThreshold) {
          // This was a tap, handle as click
          const target = event.target as HTMLDivElement;
          if (
            target &&
            (target.hasAttribute("data-sprite-item-id") ||
              target.hasAttribute("data-marker-id"))
          ) {
            const midpointOffset = slider.clientWidth / 2;
            let newPosition = position.current;

            if (target.hasAttribute("data-sprite-item-id")) {
              const rect = target.getBoundingClientRect();
              const touchX = touch.clientX - rect.left;
              newPosition = midpointOffset - (target.offsetLeft + touchX);
            }

            if (target.hasAttribute("data-marker-id")) {
              newPosition = midpointOffset - target.offsetLeft;
            }

            setEaseOutTransition();
            setPosition(newPosition, true, false); // 点击时，非拖拽模式
          }
        }
      }
    },
    [setPosition, setEaseOutTransition]
  );

  useEffect(() => {
    const content = contentEl.current!;

    // Mouse events
    content.addEventListener("mousedown", onMouseDown, false);
    content.addEventListener("mousemove", onMouseMove, false);
    window.addEventListener("mouseup", onMouseUp, false);

    // Touch events
    content.addEventListener("touchstart", onTouchStart, { passive: false });
    content.addEventListener("touchmove", onTouchMove, { passive: false });
    content.addEventListener("touchend", onTouchEnd, { passive: false });

    return () => {
      // Mouse events
      content.removeEventListener("mousedown", onMouseDown);
      content.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);

      // Touch events
      content.removeEventListener("touchstart", onTouchStart);
      content.removeEventListener("touchmove", onTouchMove);
      content.removeEventListener("touchend", onTouchEnd);
    };
  }, [
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onTouchStart,
    onTouchMove,
    onTouchEnd,
  ]);

  function goBack() {
    const slider = sliderEl.current!;
    const newPosition = position.current + slider.clientWidth;
    setEaseOutTransition();
    setPosition(newPosition, true, false); // 导航按钮点击，非拖拽模式
  }

  function goForward() {
    const slider = sliderEl.current!;
    const newPosition = position.current - slider.clientWidth;
    setEaseOutTransition();
    setPosition(newPosition, true, false); // 导航按钮点击，非拖拽模式
  }

  function renderTags() {
    if (!spriteItems) return;

    return scene.scene_markers.map((marker, index) => {
      const { duration } = file;
      const left = (scrubWidth * marker.seconds) / duration;
      const style = { left: `${left}px` };

      return (
        <div
          key={index}
          className="scrubber-tag"
          style={style}
          data-marker-id={index}
        >
          {marker.title || marker.primary_tag.name}
        </div>
      );
    });
  }

  function renderSprites() {
    if (!scene.paths.vtt) return;

    return spriteItems?.map((sprite, index) => {
      return (
        <div
          key={index}
          className="scrubber-item"
          style={sprite.style}
          data-sprite-item-id={index}
        >
          <span className="scrubber-item-time">{sprite.time}</span>
        </div>
      );
    });
  }

  return (
    <div className="scrubber-wrapper">
      <Button
        className="scrubber-button"
        id="scrubber-back"
        onClick={() => goBack()}
      >
        <Icon className="fa-fw" icon={faChevronLeft} />
      </Button>
      <div ref={contentEl} className="scrubber-content">
        <div className="scrubber-tags-background" />
        <div
          className="scrubber-heatmap"
          style={{
            backgroundImage:
              scene.interactive_speed && scene.paths.interactive_heatmap
                ? `url(${scene.paths.interactive_heatmap})`
                : undefined,
          }}
        />
        <div ref={indicatorEl} id="scrubber-position-indicator" />
        <div id="scrubber-current-position" />
        <div className="scrubber-viewport">
          <div ref={sliderEl} className="scrubber-slider">
            <div className="scrubber-tags">{renderTags()}</div>
            {renderSprites()}
          </div>
        </div>
      </div>
      <Button
        className="scrubber-button"
        id="scrubber-forward"
        onClick={() => goForward()}
      >
        <Icon className="fa-fw" icon={faChevronRight} />
      </Button>
    </div>
  );
};
