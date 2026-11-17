import "./style.css";
import type { Point, HasOverflow, CarouselOptions } from "./types";
import StyleObserver, { ReturnFormat } from '@bramus/style-observer';
import { createState } from "./state";
import { damp, round, resolveCSSLength } from "./utils";
import { FRICTION, DAMPING } from "./constants";
import {
  dispatchOverscrollEvent,
  dispatchScrollEndEvent,
  dispatchScrollSnapChangingEvent,
} from "./events";
import {
  findSnapPositions,
  onScrollSnapChange,
  onSnapChanging,
  dragSnap,
  shouldSnap,
  snapSelect,
  restInLoop,
} from "./snap";
import { prev, next } from "./methods";


const scrollIntoViewInterceptors = new Map<HTMLElement, (target: Element) => void>();
let originalScrollIntoView: typeof Element.prototype.scrollIntoView | null = null;

function registerScrollIntoViewIntercept(
  scroller: HTMLElement,
  onExternalScroll: (target: Element) => void,
): () => void {
  if (scrollIntoViewInterceptors.size === 0) {
    originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (
      arg?: boolean | ScrollIntoViewOptions,
    ): void {
      for (const callback of scrollIntoViewInterceptors.values()) {
        callback(this);
      }
      return originalScrollIntoView!.call(this, arg);
    };
  }

  scrollIntoViewInterceptors.set(scroller, onExternalScroll);

  return () => {
    scrollIntoViewInterceptors.delete(scroller);
    if (scrollIntoViewInterceptors.size === 0 && originalScrollIntoView) {
      Element.prototype.scrollIntoView = originalScrollIntoView;
      originalScrollIntoView = null;
    }
  };
}

const isRTL = (el: HTMLElement): boolean =>
  window.getComputedStyle(el).direction === "rtl";

export const Blossom = (scroller: HTMLElement, options: CarouselOptions = {}) => {
  const state = createState();
  state.scroller = scroller;
  let snap = <boolean>true;
  const pointerStart: Point = { x: 0, y: 0 };
  const target: Point = { x: 0, y: 0 };
  const velocity: Point = { x: 0, y: 0 };
  const distanceMovedSincePointerDown: Point = new Proxy(
    { x: 0, y: 0 },
    {
      set(target, prop: keyof Point, value) {
        const old = target[prop];
        if (old === value) return true;

        target[prop] = value;

        if (target.x >= 10 || target.y >= 10) {
          isTicking.value = true;
        }

        return true;
      },
    },
  );
  const hasOverflow: HasOverflow = new Proxy(
    { x: false, y: false },
    {
      set(target, prop: keyof HasOverflow, value) {
        const old = target[prop];
        if (old === value) return true;

        target[prop] = value;

        if (target.x || target.y) {
          scroller.setAttribute("has-overflow", "true");
          scroller.addEventListener("pointerdown", onPointerDown);
          scroller.addEventListener("wheel", onWheel, { passive: true });
        } else {
          scroller.removeAttribute("has-overflow");
          scroller.removeEventListener("pointerdown", onPointerDown);
          scroller.removeEventListener("wheel", onWheel);
        }

        return true;
      },
    },
  );
  let raf: number | null = null;
  let links: NodeListOf<HTMLAnchorElement> | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let restoreScrollMethods: () => void;
  let styleObserver: StyleObserver | null = null;
  let hasTouch = false;

  function init() {
    scroller?.setAttribute("blossom-carousel", "true");
    links = scroller?.querySelectorAll("a[href]") || null;
    links?.forEach((el) => {
      el.addEventListener("click", onLinkClick);
    });
    window.addEventListener("keydown", onKeydown);
    scroller.addEventListener("scroll", onScroll);
    if (options?.repeat) {
      scroller.addEventListener("touchstart", onTouchStart, { passive: true });
      scroller.addEventListener("touchend", onTouchEnd);
      scroller.addEventListener("touchcancel", onTouchEnd);
    }
    scroller.scrollTo = scrollToOverride;
    scroller.scrollBy = scrollByOverride;

    resizeObserver = new ResizeObserver(onResize);
    // repeat pads the scroller 50% on both sides, which leaves a zero-width
    // content box: only the border box reports width changes.
    resizeObserver.observe(
      scroller,
      options?.repeat ? { box: "border-box" } : undefined,
    );

    mutationObserver = new MutationObserver(onMutation);
    mutationObserver.observe(scroller, {
      attributes: false,
      childList: true,
      subtree: true,
    });

    styleObserver = new StyleObserver(
      (values) => {
        hasOverflow.x =
        !hasTouch &&
        state.scrollerScrollWidth > state.scrollerWidth &&
        ["auto", "scroll"].includes((typeof values["overflow-x"] === "string" ? values["overflow-x"] : values["overflow-x"].value));
        hasOverflow.y =
        !hasTouch &&
        state.scrollerScrollHeight > state.scrollerHeight &&
        ["auto", "scroll"].includes((typeof values["overflow-y"] === "string" ? values["overflow-y"] : values["overflow-y"].value));
      },                                                 
      {
        properties: ['overflow-x', 'overflow-y'],
        returnFormat: ReturnFormat.OBJECT,
      }
    );
    styleObserver.observe(scroller);

    const hasMouse = window.matchMedia(
      "(hover: hover) and (pointer: fine)",
    ).matches;

    state.dir = isRTL(scroller) ? -1 : 1;

    const { scrollSnapType } = window.getComputedStyle(scroller);
    state.hasSnap = scrollSnapType !== "none";
    state.snapMandatory = scrollSnapType.includes("mandatory");
    scroller.style.setProperty("--snap-type", scrollSnapType);
    if (hasMouse) {
      scroller.style.setProperty("scroll-snap-type", "none");
    }

    scroller.setAttribute("has-snap", snap ? "true" : "false");
    scroller.setAttribute("has-repeat", options?.repeat ? "true" : "false");

    restoreScrollMethods = registerScrollIntoViewIntercept(scroller, (target) => {
      if (target === scroller || scroller.contains(target))
        isTicking.value = false;
    });
  }

  function destroy() {
    scroller.removeAttribute("blossom-carousel");
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    styleObserver?.unobserve(scroller);
    if (raf) cancelAnimationFrame(raf);

    window.removeEventListener("keydown", onKeydown);
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("touchstart", onTouchStart);
    scroller.removeEventListener("touchend", onTouchEnd);
    scroller.removeEventListener("touchcancel", onTouchEnd);
    window.clearTimeout(settleTimer);
    isTicking.value = false;
    // removes the pointerdown and wheel listeners
    hasOverflow.x = hasOverflow.y = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    state.isDragging = false;

    if (options?.repeat) {
      // leave nothing of the loop behind: the attribute switches native
      // snapping off and tells navigation to loop
      scroller.removeAttribute("has-repeat");
      for (const slide of Array.from(scroller.children) as HTMLElement[]) {
        slide.style.translate = "";
      }
      state.period = 0;
      hasStartPosition = false;
    }

    links?.forEach((el) => {
      el.removeEventListener("click", onLinkClick);
    });

    restoreScrollMethods?.();
    scroller.scrollTo = originalScrollTo;
    scroller.scrollBy = originalScrollBy;
  }

  function onLinkClick(e: MouseEvent): void {
    if (distanceMovedSincePointerDown.x > 10) {
      e.preventDefault();
    }
  }

  function onResize(): void {
    if (!scroller) return;

    hasTouch = "ontouchmove" in window;
    // the anchor of the last scroll event: a browser may already have clamped
    // scrollLeft to what a DOM change left of the scroll range
    const anchor = state.period ? (lastAnchor ?? repeatAnchor()) : null;
    if (options?.repeat) {
      // slides moved to the other side by onRepeat inflate scrollWidth:
      // measure with every slide back in its natural position.
      for (const slide of Array.from(scroller.children) as HTMLElement[]) {
        slide.style.translate = "";
      }
    }
    state.scrollerScrollWidth = scroller.scrollWidth;
    state.scrollerWidth = scroller.clientWidth;
    state.scrollerScrollHeight = scroller.scrollHeight;
    state.scrollerHeight = scroller.clientHeight;

    const styles = window.getComputedStyle(scroller);
    hasOverflow.x =
      !hasTouch &&
      state.scrollerScrollWidth > state.scrollerWidth &&
      ["auto", "scroll"].includes(styles.getPropertyValue("overflow-x"));
    hasOverflow.y =
      !hasTouch &&
      state.scrollerScrollHeight > state.scrollerHeight &&
      ["auto", "scroll"].includes(styles.getPropertyValue("overflow-y"));
    state.padding.end = resolveCSSLength(scroller, styles.paddingInlineEnd);
    state.padding.start = resolveCSSLength(scroller, styles.paddingInlineStart);
    state.scrollPadding.start = resolveCSSLength(scroller, styles.scrollPaddingInlineStart);
    state.scrollPadding.end = resolveCSSLength(scroller, styles.scrollPaddingInlineEnd);
    state.dir = isRTL(scroller) ? -1 : 1;
    state.end =
      (state.scrollerScrollWidth - state.scrollerWidth - 4) * state.dir;
    state.period = options?.repeat
      ? state.scrollerScrollWidth - state.scrollerWidth
      : 0;

    if (state.hasSnap) {
      findSnapPositions(scroller, state);
    } else {
      state.slidePositions = Array.from(scroller.children).map((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const left = rect.left - scrollerRect.left + scroller.scrollLeft;
        return {
          target: el as HTMLElement,
          x: left - state.scrollPadding.start,
          y: 0,
          width: rect.width,
          height: rect.height,
        };
      });
    }
    if (options?.repeat) {
      if (!hasStartPosition && state.period > 0) {
        hasStartPosition = true;
        scrollToRepeatStart();
      } else if (anchor) {
        restoreRepeatAnchor(anchor);
      }
      onRepeat(null, null);
      lastAnchor = state.period ? repeatAnchor() : null;
      settleSoon();
    }
  }

  // The padding of a repeating scroller follows its width, so a resize moves
  // everything by half the change. Hold on to what was aligned: the nearest
  // snap target, or without snapping the content at the start edge.
  type RepeatAnchor = { target: HTMLElement | null; offset: number; left: number };
  let lastAnchor: RepeatAnchor | null = null;
  function repeatAnchor(): RepeatAnchor {
    const left = scroller.scrollLeft;
    if (state.hasSnap && state.snapPositions.length) {
      const nearest = snapSelect(left, 0, FRICTION, state);
      return { target: nearest.target, offset: left - nearest.x, left };
    }
    return { target: null, offset: left - state.padding.start * state.dir, left };
  }

  function restoreRepeatAnchor(anchor: RepeatAnchor): void {
    if (!state.period) return;
    const base = anchor.target
      ? state.snapPositions.find(({ target }) => target === anchor.target)?.x
      : state.padding.start * state.dir;
    if (base === undefined) return;

    const pos =
      ((((base + anchor.offset) * state.dir) % state.period) + state.period) %
      state.period;
    const left = restInLoop(pos * state.dir, state);
    // the ticker's own position moves along
    const shift = left - anchor.left;
    virtualScroll.x += shift;
    target.x += shift;
    destination += shift;

    if (Math.abs(left - scroller.scrollLeft) < 0.5) return;
    __scrollingInternally = true;
    scroller.scrollTo({ left, behavior: "instant" as ScrollBehavior });
  }

  // A repeating scroller is padded by half its width on both sides, so
  // scrollLeft 0 shows the first slide in the middle. Start where a carousel
  // without repeat starts: on the first slide, at its own snap alignment.
  let hasStartPosition = false;
  function scrollToRepeatStart(): void {
    const first = scroller.firstElementChild as HTMLElement | null;
    if (!first) return;

    const rect = first.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const start =
      (state.dir === -1
        ? scrollerRect.right - rect.right
        : rect.left - scrollerRect.left) +
      scroller.scrollLeft * state.dir;
    const align = state.hasSnap
      ? window.getComputedStyle(first).scrollSnapAlign.trim().split(/\s+/).pop()
      : "start";

    let x = start - state.scrollPadding.start;
    if (align === "center") x = start + rect.width / 2 - state.scrollerWidth / 2;
    if (align === "end")
      x = start + rect.width - state.scrollerWidth + state.scrollPadding.end;

    x = ((x % state.period) + state.period) % state.period;
    __scrollingInternally = true;
    scroller.scrollTo({
      left: Math.min(Math.max(x, 4), state.end * state.dir) * state.dir,
      behavior: "instant" as ScrollBehavior,
    });
  }

  function onMutation(): void {
    onResize();
  }

  function onScroll() {
    if (options?.repeat) {
      onRepeat(null, null);
      if (state.period) lastAnchor = repeatAnchor();
      settleSoon();
      return;
    }

    if (state.isDragging || !scroller) return;

    const scrollStart = scroller.scrollLeft;

    if (scrollStart < 0) {
      dispatchOverscrollEvent(scroller, { left: scrollStart * -1 });
    } else if (scrollStart > state.scrollerScrollWidth - state.scrollerWidth) {
      dispatchOverscrollEvent(scroller, {
        left:
          scrollStart * -1 + state.scrollerScrollWidth - state.scrollerWidth,
      });
    }
  }

  /*********************
   **** Drag events ****
   *********************/

  const virtualScroll: Point = {
    x: 0,
    y: 0,
  };

  function onPointerDown(e: PointerEvent): void {
    if (!scroller) return;

    if (hasOverflow.x) {
      virtualScroll.x = scroller.scrollLeft;
      target.x = scroller.scrollLeft;
      pointerStart.x = e.clientX;
      velocity.x = 0;
    }

    if (hasOverflow.y) {
      virtualScroll.y = scroller.scrollTop;
      target.y = scroller.scrollTop;
      pointerStart.y = e.clientY;
      velocity.y = 0;
    }

    distanceMovedSincePointerDown.x = 0;
    state.isDragging = true;
    // the pointer takes over from a programmatic repeat scroll
    animating = false;
    stepping = false;

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  function onPointerMove(e: PointerEvent): void {
    e.preventDefault();

    if (hasOverflow.x) {
      const deltaX = pointerStart.x - e.clientX;
      target.x += deltaX;
      velocity.x += deltaX;
      pointerStart.x = e.clientX;
      distanceMovedSincePointerDown.x += Math.abs(deltaX);
    }

    if (hasOverflow.y) {
      const deltaY = pointerStart.y - e.clientY;
      target.y += deltaY;
      velocity.y += deltaY;
      pointerStart.y = e.clientY;
      distanceMovedSincePointerDown.y += Math.abs(deltaY);
    }
  }

  function onPointerUp(): void {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);

    state.isDragging = false;

    if (distanceMovedSincePointerDown.x <= 10) {
      settleSoon();
      return;
    }
    if (hasOverflow.x) velocity.x *= 2;
    if (hasOverflow.y) velocity.y *= 2;

    if (shouldSnap(target.x, velocity.x, FRICTION, state) || target.x * state.dir < 0 || target.x * state.dir > state.end * state.dir) {
      velocity.x = dragSnap(target.x, velocity.x, FRICTION, state);
    }
    preventGlobalClick();
  }

  function onWheel(e: WheelEvent): void {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      isTicking.value = false;
      stepping = true;
      settleSoon(); // not while the wheel is still turning
      if (state.isDragging || !scroller) return;
      if (hasOverflow.x) virtualScroll.x = scroller.scrollLeft;
      if (hasOverflow.y) virtualScroll.y = scroller.scrollTop;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key))
      return;

    // repeat switches native snapping off, and with it the step that an arrow
    // key takes to the next snap position (all WebKit does with one): step here
    const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
    if (
      horizontal &&
      state.period &&
      state.hasSnap &&
      !e.defaultPrevented &&
      !(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) &&
      e.target instanceof Node &&
      scroller.contains(e.target) &&
      !(e.target as HTMLElement).isContentEditable &&
      !["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement).tagName)
    ) {
      e.preventDefault();
      const forward = (e.key === "ArrowRight") === (state.dir === 1);
      (forward ? next : prev)(state);
      return;
    }

    isTicking.value = false;
    stepping = true;
  }

  // touch devices have no drag handling: a touch takes over from a
  // programmatic repeat scroll here
  let touching = false;
  function onTouchStart(): void {
    touching = true;
    stepping = false;
    if (animating) isTicking.value = false;
  }

  function onTouchEnd(e: TouchEvent): void {
    touching = e.touches.length > 0;
    settleSoon();
  }

  // repeat switches native snapping off (it fights the wrap, see style.css),
  // so a scroll that core didn't run itself (wheel, keys, touch, an instant
  // or interrupted programmatic scroll) is snapped here once it has come to rest
  let settleTimer = 0;
  /** the wheel or an arrow key scrolled last: these step on, like native snapping */
  let stepping = false;
  /** where the scroll last rested on a snap position */
  let restedAt: number | null = null;
  function settleSoon(): void {
    window.clearTimeout(settleTimer);
    if (state.hasSnap && state.period)
      settleTimer = window.setTimeout(settle, 100);
  }

  function settle(): void {
    if (!scroller || state.isDragging || touching || isTicking.value) return;

    const left = scroller.scrollLeft;
    if (!shouldSnap(left, 0, FRICTION, state)) return;

    let { x } = snapSelect(left, 0, FRICTION, state);
    if (Math.abs(restInLoop(x, state) - left) < 1) {
      restedAt = left;
      stepping = false;
      return;
    }

    // a wheel notch or a key press doesn't get halfway to the next position:
    // rather than falling back, go on to the next one in its direction
    if (stepping && restedAt !== null) {
      const { period } = state;
      const wrap = (d: number) => d - period * Math.round(d / period);
      const moved = wrap(left - restedAt);
      if (Math.abs(moved) > 10 && Math.abs(wrap(x - restedAt)) < 1) {
        const sign = Math.sign(moved);
        let step = period;
        for (const position of state.snapPositions) {
          const d = ((((position.x - restedAt) * sign) % period) + period) % period;
          if (d > 1 && d < step) step = d;
        }
        x = restedAt + step * sign;
      }
    }
    stepping = false;
    scroller.scrollTo({ left: x, behavior: "smooth" });
  }

  /*********************
   ******* REPEAT ******
   *********************/

  function onRepeat(_: null | undefined, x: number | null): void {
    if (!scroller) return;

    const scrollStart = x ?? scroller.scrollLeft;
    const pos = scrollStart * state.dir; // logical (always >= 0)
    const distanceToStartEdge = state.padding.start - pos;
    const distanceToEndEdge =
      pos -
      (state.scrollerScrollWidth - state.scrollerWidth - state.padding.end);
    const slides = Array.from(scroller.children) as HTMLElement[];

    const offsetSlides = (
      startIdx: number,
      endIdx: number,
      threshold: number,
      isEnd: boolean,
    ) => {
      let offset = 0;
      const step = isEnd ? -1 : 1;
      const baseOffset = (isEnd ? -state.period : state.period) * state.dir;

      for (let i = startIdx; isEnd ? i >= endIdx : i < endIdx; i += step) {
        const thresholdCheck = isEnd ? offset > threshold : offset > threshold;
        slides[i].style.translate = `${thresholdCheck ? 0 : baseOffset}px 0`;
        offset += slides[i].clientWidth;
      }
    };

    offsetSlides(
      slides.length - 1,
      slides.length / 2,
      distanceToStartEdge,
      true,
    );
    offsetSlides(0, slides.length / 2, distanceToEndEdge, false);

    // the ticker wraps on its own, and exactly
    if (state.isDragging || isTicking.value) return;

    const left =
      pos > state.end * state.dir ? 4 * state.dir : pos < 4 ? state.end : null;
    if (!left) return;
    __scrollingInternally = true;
    scroller.scrollTo({
      left,
      behavior: "instant" as ScrollBehavior,
    });
  }

  /******************
   ***** Ticker *****
   ******************/

  function onScrollEnd(e: Event) {
    if (isTicking.value) {
      e.stopPropagation();
    }
  }

  type TickingState = { value: boolean };
  const isTicking: TickingState = new Proxy(
    { value: false },
    {
      set(ticking: TickingState, prop: keyof TickingState, value: boolean) {
        snap = !value;
        const old = ticking[prop];
        if (old === value) return true;

        if (!scroller) return false;

        scroller.setAttribute("has-snap", snap ? "true" : "false");

        // start ticker
        if (value && !isTicking.value) {
          lastTick = performance.now();
          if (hasOverflow.x) target.x = scroller.scrollLeft;
          if (hasOverflow.y) target.y = scroller.scrollTop;

          scroller.addEventListener("scrollend", onScrollEnd, {
            capture: true,
            passive: false,
          });

          if (!raf) {
            raf = requestAnimationFrame(tick);
          }
        }
        // stop ticker
        else if (!value) {
          if (raf) cancelAnimationFrame(raf);
          raf = null;
          animating = false;
          scroller.removeEventListener("scrollend", onScrollEnd);
        }

        ticking[prop] = value;

        return true;
      },
    },
  );

  let frameDelta = 0;
  let lastTick = 0;
  /** A programmatic repeat scroll is being animated by the ticker, to destination. */
  let animating = false;
  let destination = 0;
  function tick(t: number): void {
    raf = requestAnimationFrame(tick);
    frameDelta = t - lastTick;

    if (!scroller) return;

    // a programmatic repeat scroll runs on touch devices too, where hasOverflow
    // is kept false so the native touch scrolling stays in charge
    if (hasOverflow.x || animating) {
      velocity.x *= FRICTION;
      if (!state.isDragging) {
        target.x += velocity.x;
        virtualScroll.x = damp(virtualScroll.x, target.x, DAMPING, frameDelta);
      } else {
        virtualScroll.x = damp(virtualScroll.x, target.x, FRICTION, frameDelta);
      }
    }

    if (hasOverflow.y) {
      velocity.y *= FRICTION;
      if (!state.isDragging) {
        target.y += velocity.y;
        virtualScroll.y = damp(virtualScroll.y, target.y, DAMPING, frameDelta);
      } else {
        virtualScroll.y = damp(virtualScroll.y, target.y, FRICTION, frameDelta);
      }
    }

    if (options?.repeat) {
      // wrap into [0, period) by exactly one loop, shifting target too so it
      // keeps its lead: momentum and programmatic scrolls carry on through the
      // seam at the same speed (onRepeat leaves the wrapping to the ticker)
      const pos = virtualScroll.x * state.dir;
      const shift =
        pos >= state.period
          ? -state.period * state.dir
          : pos < 0
            ? state.period * state.dir
            : 0;
      virtualScroll.x += shift;
      target.x += shift;
      destination += shift;

      // a programmatic scroll only approaches its destination: land on it
      if (
        animating &&
        Math.abs(destination - virtualScroll.x) < 0.5 &&
        Math.abs(velocity.x) < 0.5
      ) {
        virtualScroll.x = target.x = destination;
        velocity.x = 0;
        animating = false;
      }
    }

    __scrollingInternally = true;
    scroller.scrollTo({
      left: virtualScroll.x,
      top: virtualScroll.y,
      behavior: "instant" as ScrollBehavior,
    });

    if (state.isDragging && state.hasSnap) {
      onSnapChanging(target.x, velocity.x, FRICTION, state);
    }

    if (!state.isDragging && !animating && round(velocity.x, 12) === 0) {
      isTicking.value = false;
      dispatchScrollEndEvent(scroller);
      if (state.hasSnap) {
        onScrollSnapChange(state);
      }
      // momentum only approaches the snap position: land on it
      settleSoon();
    }

    if (!options?.repeat) {
      applyRubberBanding(round(virtualScroll.x, 2));
    } else {
      onRepeat(null, virtualScroll.x);
    }

    lastTick = t;
  }

  let rubberBandOffset = 0;
  function applyRubberBanding(left: number): void {
    if (!scroller) return;

    //TODO: add support for vertical rubber banding
    const edge = state.end;

    let targetOffset = 0;
    if (left * state.dir <= 0) {
      targetOffset = state.isDragging ? left * -0.2 : 0;
    } else if (left * state.dir > edge * state.dir) {
      targetOffset = state.isDragging ? (left - edge) * -0.2 : 0;
    }
    rubberBandOffset = damp(
      rubberBandOffset,
      targetOffset,
      state.isDragging ? 0.8 : DAMPING,
      frameDelta,
    );

    if (Math.abs(rubberBandOffset) > 0.01) {
      const evt = dispatchOverscrollEvent(scroller, { left: rubberBandOffset });
      if (evt.defaultPrevented) return;
      scroller.style.transform = `translateX(${round(rubberBandOffset, 3)}px)`;
      return;
    }

    scroller.style.transform = "";
    rubberBandOffset = 0;
  }

  /******************************
   ********* METHODS **************
   ******************************/

  let __scrollingInternally = false;

  const originalScrollTo = scroller.scrollTo;
  const originalScrollBy = scroller.scrollBy;

  const scrollTo = scroller.scrollTo.bind(scroller);
  const scrollToOverride = function (...args: any[]) {
    const internal = __scrollingInternally === true;
    __scrollingInternally = false;
    if (!internal && options?.repeat && repeatScroll(args, 0)) return;
    if (!internal) isTicking.value = false;
    scrollTo(...args);
  };

  const scrollBy = scroller.scrollBy.bind(scroller);
  const scrollByOverride = function (...args: any[]) {
    const internal = __scrollingInternally === true;
    __scrollingInternally = false;
    if (!internal && options?.repeat && repeatScroll(args, scroller.scrollLeft))
      return;
    if (!internal) isTicking.value = false;
    scrollBy(...args);
  };
  scroller.scrollTo = scrollToOverride;
  scroller.scrollBy = scrollByOverride;

  /**
   * repeat: the browser can't animate a programmatic scroll across the seam
   * (the wrap in onRepeat cancels it halfway), so a smooth one is run by the
   * ticker instead, which wraps as it goes and may head beyond the seam; an
   * instant one jumps to the same spot inside the scroll range. Returns false
   * to leave the scroll to the browser: one without an inline position, or
   * before there is anything to loop.
   */
  function repeatScroll(args: any[], base: number): boolean {
    const opts: ScrollToOptions =
      typeof args[0] === "object" && args[0] !== null
        ? args[0]
        : { left: args[0], top: args[1] };
    if (
      !state.period ||
      typeof opts.left !== "number" ||
      !Number.isFinite(opts.left)
    )
      return false;

    const left = (base + opts.left) * state.dir; // logical, may be out of range
    const pos = ((left % state.period) + state.period) % state.period;
    // a rest within 4px of the seam would be wrapped 4px off afterwards
    // (onRepeat): stop at the edge of that band instead
    const rest = Math.min(Math.max(pos, 4), state.end * state.dir);

    const behavior = opts.behavior ?? "auto";
    const smooth =
      behavior === "smooth" ||
      (behavior === "auto" &&
        window.getComputedStyle(scroller).scrollBehavior === "smooth");

    if (!smooth) {
      isTicking.value = false;
      __scrollingInternally = true;
      scroller.scrollTo({
        left: rest * state.dir,
        behavior: "instant" as ScrollBehavior,
      });
      return true;
    }

    if (!isTicking.value) {
      virtualScroll.x = target.x = scroller.scrollLeft;
      isTicking.value = true;
      // the next frame's rAF timestamp can predate performance.now() here
      // (Firefox): a negative first frameDelta would step backwards
      const now = document.timeline?.currentTime;
      if (typeof now === "number") lastTick = now;
    }
    animating = true;
    destination = (left + rest - pos) * state.dir;
    // any number of whole loops ends in the same place: go round once at most
    if (Math.abs(destination - target.x) > state.period)
      destination = target.x + ((destination - target.x) % state.period);

    // like native snapping, announce the snap target being headed for
    if (state.hasSnap && state.snapPositions.length) {
      const distance = (x: number) => {
        const d = x - destination;
        return Math.abs(d - state.period * Math.round(d / state.period));
      };
      const next = state.snapPositions.reduce((a, b) =>
        distance(b.x) < distance(a.x) ? b : a,
      );
      if (next.target !== state.activeSnapPosition.target) {
        state.activeSnapPosition = next;
        dispatchScrollSnapChangingEvent(scroller, {
          snapTargetInline: next.target,
          snapTargetBlock: next.target,
        });
      }
    }
    // the velocity whose friction-decayed sum carries target there
    velocity.x = ((destination - target.x) * (1 - FRICTION)) / FRICTION;
    return true;
  }

  /******************************
   ********* UTILS **************
   ******************************/

  function preventGlobalClick(): void {
    const clickPreventHandler = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener("click", clickPreventHandler, true);
    };
    // Use capture phase to catch the event before it reaches the element
    window.addEventListener("click", clickPreventHandler, true);
  }

  return {
    snap,
    hasOverflow,
    init,
    destroy,
    prev: (opts?: { align?: any }) => prev(state, opts),
    next: (opts?: { align?: any }) => next(state, opts),
  };
};
