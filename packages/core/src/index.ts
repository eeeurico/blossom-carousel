import "./style.css";
import type { Point, HasOverflow, CarouselOptions } from "./types";
import StyleObserver, { ReturnFormat } from '@bramus/style-observer';
import { createState } from "./state";
import { damp, round, clamp, resolveCSSLength } from "./utils";
import { FRICTION, DAMPING } from "./constants";
import {
  dispatchOverscrollEvent,
  dispatchScrollEndEvent,
  dispatchScrollSnapChangeEvent,
  dispatchScrollSnapChangingEvent,
} from "./events";
import {
  findSnapPositions,
  onScrollSnapChange,
  onSnapChanging,
  dragSnap,
  shouldSnap,
  snapSelect,
} from "./snap";
import { prev, next } from "./methods";


/** may return what to do once the browser has scrolled the target into view */
type ScrollIntoViewInterceptor = (
  target: Element,
  arg?: boolean | ScrollIntoViewOptions,
) => (() => void) | void;
const scrollIntoViewInterceptors = new Map<HTMLElement, ScrollIntoViewInterceptor>();
let originalScrollIntoView: typeof Element.prototype.scrollIntoView | null = null;

function registerScrollIntoViewIntercept(
  scroller: HTMLElement,
  onExternalScroll: ScrollIntoViewInterceptor,
): () => void {
  if (scrollIntoViewInterceptors.size === 0) {
    originalScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (
      arg?: boolean | ScrollIntoViewOptions,
    ): void {
      const after: Array<() => void> = [];
      for (const callback of scrollIntoViewInterceptors.values()) {
        const then = callback(this, arg);
        if (then) after.push(then);
      }
      originalScrollIntoView!.call(this, arg);
      for (const then of after) then();
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
  let roomObserver: MutationObserver | null = null;
  /** the scroller's own scrollLeft property, if it had one before repeat's */
  let ownScrollLeft: PropertyDescriptor | undefined;
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
      for (const type of NATIVE_REST_EVENTS)
        scroller.addEventListener(type, onNativeRestEvent, true);
    }
    scroller.scrollTo = scrollToOverride;
    scroller.scrollBy = scrollByOverride;
    if (options?.repeat) {
      scroller.scroll = scrollToOverride;
      // scrollLeft = x is a scroll like scrollTo: round the loop
      ownScrollLeft = Object.getOwnPropertyDescriptor(scroller, "scrollLeft");
      let owner: object | null = scroller;
      let found = ownScrollLeft;
      while (!found && (owner = Object.getPrototypeOf(owner)))
        found = Object.getOwnPropertyDescriptor(owner, "scrollLeft");
      const { get, set } = found || {};
      if (get && set && ownScrollLeft?.configurable !== false) {
        Object.defineProperty(scroller, "scrollLeft", {
          configurable: true,
          get: () => get.call(scroller),
          set: (left: number) => {
            if (!state.period) return set.call(scroller, left);
            scroller.scrollTo({ left });
          },
        });
      }
      // a framework may write the style attribute over the room and the
      // slides' places: put them back before the browser lays out
      roomObserver = new MutationObserver((records) => {
        if (!state.period) return;
        const { style } = scroller;
        if (
          records.some(({ target }) => target === scroller) &&
          !style.getPropertyValue("--blossom-repeat-lead")
        ) {
          const period = state.period;
          const kept = lead;
          lead = 0;
          positioned = false;
          setRoom(period, kept - ROOM);
        }
        if (records.some(({ target }) => target.parentNode === scroller))
          onRepeat(null, null);
      });
      roomObserver.observe(scroller, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
    }

    resizeObserver = new ResizeObserver((entries = []) =>
      onResize(
        true,
        entries.length > 0 && entries.every(({ target }) => target !== scroller),
      ),
    );
    // repeat pads the scroller 50% on both sides, which leaves a zero-width
    // content box: only the border box reports width changes.
    resizeObserver.observe(
      scroller,
      options?.repeat ? { box: "border-box" } : undefined,
    );
    // slides can change size without a dom mutation (an image loading, a
    // class or style change): watch them too
    if (options?.repeat) {
      for (const slide of Array.from(scroller.children)) {
        resizeObserver.observe(slide, { box: "border-box" });
      }
    }

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
    scroller.setAttribute("has-repeat", "false");
    if (options?.repeat && canLoop()) setLooping(true);

    restoreScrollMethods = registerScrollIntoViewIntercept(scroller, (target, arg) => {
      if (target !== scroller && !scroller.contains(target)) return;
      isTicking.value = false;
      return repeatScrollIntoView(target, arg);
    });

    // repeat: on the first slide from the first frame on
    if (looping) onResize();
  }

  function destroy() {
    // repeat: how far past the first slide's start the scroll is, in the loop
    const into = state.period
      ? ((((scroller.scrollLeft * state.dir - loopStart) % state.period) +
          state.period) %
          state.period)
      : null;
    scroller.removeAttribute("blossom-carousel");
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    styleObserver?.unobserve(scroller);
    if (raf) cancelAnimationFrame(raf);
    cancelAnimationFrame(switchFrame);
    switchFrame = 0;

    window.removeEventListener("keydown", onKeydown);
    scroller.removeEventListener("scroll", onScroll);
    scroller.removeEventListener("touchstart", onTouchStart);
    scroller.removeEventListener("touchend", onTouchEnd);
    scroller.removeEventListener("touchcancel", onTouchEnd);
    for (const type of NATIVE_REST_EVENTS)
      scroller.removeEventListener(type, onNativeRestEvent, true);
    window.clearTimeout(settleTimer);
    settleTimer = 0;
    isTicking.value = false;
    // removes the pointerdown and wheel listeners
    hasOverflow.x = hasOverflow.y = false;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    state.isDragging = false;

    if (options?.repeat) {
      // leave nothing of the loop behind: the attribute switches native
      // snapping off and tells navigation to loop
      const { dir } = state;
      scroller.removeAttribute("has-repeat");
      roomObserver?.disconnect();
      delete (scroller as any).scroll;
      if (ownScrollLeft) Object.defineProperty(scroller, "scrollLeft", ownScrollLeft);
      else delete (scroller as any).scrollLeft;
      ownScrollLeft = undefined;
      setRoom(0);
      // out of the long scroll range, to the same slides
      if (into !== null) {
        const pad =
          parseFloat(window.getComputedStyle(scroller).paddingInlineStart) || 0;
        scrollTo({ left: (into + pad) * dir, behavior: "instant" as ScrollBehavior });
      }
      setSeamGap(false);
      for (const slide of Array.from(scroller.children) as HTMLElement[]) {
        slide.style.translate = "";
      }
      state.period = 0;
      looping = unfit = quiet = false;
      unloopable = "";
      ranUnlooped = false;
      loopSlides = [];
      lastAnchor = restoredLeft = snappedTo = restedAt = null;
      restLeft = 0;
      stirred = scrolled = stepping = false;
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

  function onResize(observed = false, slidesOnly = false): void {
    if (!scroller) return;

    hasTouch = "ontouchmove" in window;
    // the anchor of the last scroll event: a browser may already have clamped
    // scrollLeft to what a DOM change left of the scroll range
    const anchor = state.period
      ? (lastAnchor ?? repeatAnchor())
      : options?.repeat
        ? repeatAnchor()
        : null;
    const wasLooping = looping;
    const oldPeriod = state.period;
    if (options?.repeat) {
      // slides moved to the other side by onRepeat inflate scrollWidth:
      // measure with every slide back in its natural position.
      for (const slide of Array.from(scroller.children) as HTMLElement[]) {
        slide.style.translate = "";
      }
      setSeamGap(false);
      if (canLoop() !== looping) {
        // switching changes the padding, which other resize observers of the
        // scroller would only hear of in a loop error: switch next frame
        if (observed) {
          cancelAnimationFrame(switchFrame);
          switchFrame = requestAnimationFrame(() => {
            switchFrame = 0;
            onResize();
          });
        } else {
          setLooping(!looping);
          // the browser's events for the switch are not a scroll's
          quiet = true;
          requestAnimationFrame(() => requestAnimationFrame(() => (quiet = false)));
          isTicking.value = false;
          window.clearTimeout(settleTimer);
          settleTimer = 0;
          scroller.style.transform = "";
          rubberBandOffset = 0;
        }
      }
      setSeamGap(looping);
      setRoom(looping ? loopLength() : 0);
    }
    measure();
    if (looping) {
      if (!hasStartPosition && state.period > 0) {
        hasStartPosition = true;
        // a carousel that couldn't loop at first keeps where it was taken to
        if (ranUnlooped && anchor && anchor.left) restoreRepeatAnchor(anchor, 0, true);
        else scrollToRepeatStart();
        // like native snapping, the start is snapped to without any event
        if (state.hasSnap && state.snapPositions.length) {
          state.activeSnapPosition = snapSelect(scroller.scrollLeft, 0, FRICTION, state);
          snappedTo = state.activeSnapPosition.target;
        }
      } else if (anchor) {
        // what was aligned stays where it is: the scroll is left alone (a
        // touch scroll doesn't survive being moved), the slides are moved
        // under it by the room before them
        // (under a scroll a slide that changes size, the active one growing,
        // say, isn't held on to: the content at the start edge is)
        const shift = restoreRepeatAnchor(
          anchor,
          oldPeriod,
          false,
          slidesOnly && scrolling(),
        );
        if (Math.abs(shift) > 0.01) {
          setRoom(state.period, shift);
          measure();
        }
      }
      if (isTicking.value && !state.isDragging && state.snapPositions.length) {
        // the snap position a glide was heading for moved with the slides
        if (animating) {
          destination = snapSelect(destination, 0, FRICTION, state).x;
          velocity.x = ((destination - target.x) * (1 - FRICTION)) / FRICTION;
        } else if (shouldSnap(target.x, velocity.x, FRICTION, state)) {
          velocity.x = dragSnap(target.x, velocity.x, FRICTION, state);
        }
      }
      onRepeat(null, null);
      lastAnchor = state.period ? repeatAnchor() : null;
      // a resize or a dom change is no scroll of its own
      if (!scrolling()) restLeft = scroller.scrollLeft;
      settleSoon(true);
    } else {
      ranUnlooped = true;
      if (wasLooping && anchor) {
        lastAnchor = null;
        restoreRepeatAnchor(anchor, oldPeriod);
      }
    }
  }

  function measure(): void {
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
    state.period = looping ? loopLength() : 0;

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
    if (looping) measureLoop();
  }

  // The loop joins the last slide to the first, but a flex or grid gap only
  // sits between slides: lend it to the last slide's end margin so the scroll
  // range, and so the period, holds one gap per slide.
  let seamSlide: HTMLElement | null = null;
  let seamMargin = "";
  let seamLent = "";
  function setSeamGap(on = true): void {
    // unless it was changed since
    if (seamSlide?.style.marginInlineEnd === seamLent)
      seamSlide.style.marginInlineEnd = seamMargin;
    seamSlide = null;
    const last = scroller.lastElementChild as HTMLElement | null;
    if (!on || !last) return;

    const { display, columnGap } = window.getComputedStyle(scroller);
    // a percentage gap resolves against the zero-width content box
    if (!/flex|grid/.test(display) || columnGap.includes("%")) return;
    const gap = resolveCSSLength(scroller, columnGap);
    if (!gap) return;

    seamSlide = last;
    seamMargin = last.style.marginInlineEnd;
    const margin = parseFloat(window.getComputedStyle(last).marginInlineEnd) || 0;
    const length = loopLength();
    const width = last.getBoundingClientRect().width;
    last.style.marginInlineEnd = `${margin + gap}px`;
    seamLent = last.style.marginInlineEnd;
    // a fixed grid track squeezes the slide, a last child out of the flow
    // doesn't count
    if (
      loopLength() - length < gap - 0.5 ||
      Math.abs(last.getBoundingClientRect().width - width) > 0.5
    )
      setSeamGap(false);
  }

  /** repeat: whether the slides are looped right now (see canLoop) */
  let looping = false;
  let switchFrame = 0;
  /** the carousel has been unable to loop since init: it may have been scrolled */
  let ranUnlooped = false;
  /** a scroll is under way, or only just over (see settleSoon) */
  const scrolling = () =>
    state.isDragging ||
    isTicking.value ||
    touching ||
    (settleTimer !== 0 && !settleResized);

  // every slide exists once, so a viewport onto the loop must never reach two
  // copies of one, or it shows a hole where the second copy belongs: the
  // slides have to be at least a viewport plus the widest slide long.
  // without that much room the carousel doesn't loop at all
  function canLoop(): boolean {
    if (looping) return fits();
    // not while a scroll that core runs would be cut off by the switch
    if (state.isDragging || isTicking.value || touching) return false;
    return !unfit && unloopable !== loopKey() && fits();
  }
  function setLooping(on: boolean): void {
    const tried = loopKey();
    const widths = slideWidths();
    const left = scroller.scrollLeft;
    looping = on;
    scroller.setAttribute("has-repeat", on ? "true" : "false");
    if (!on) return;
    // the padding can widen the scroller, and leaves percentage-wide slides
    // nothing to be wide in: then it doesn't loop after all
    unfit = slideWidths().some((width, i) => width < widths[i] - 0.5);
    setRoom(loopLength());
    // nor without the room before the slides, which a grid with a template of
    // its own doesn't give
    if (!unfit && fits() && firstStart() >= lead / 2) return;
    looping = false;
    unloopable = tried;
    setRoom(0);
    scroller.setAttribute("has-repeat", "false");
    if (scroller.scrollLeft === left) return;
    __scrollingInternally = true;
    scroller.scrollTo({ left, behavior: "instant" as ScrollBehavior });
  }
  /** percentage-wide slides: they vanish when looped (until the slides change) */
  let unfit = false;
  /** the sizes at which looping was tried and didn't fit after all */
  let unloopable = "";
  /** the browser's events are swallowed: a switch has just been made */
  let quiet = false;
  const loopKey = () =>
    `${scroller.clientWidth}/${scroller.scrollWidth}/${scroller.children.length}`;
  const slideWidths = () =>
    Array.from(scroller.children, (slide) => slide.getBoundingClientRect().width);
  function fits(): boolean {
    return loopLength() - scroller.clientWidth >= Math.max(0, ...slideWidths()) - 0.5;
  }
  /** the length of one loop: the slides from end to end, margins and all,
   *  measured with every slide in its natural position */
  function loopLength(): number {
    let start = Infinity;
    let end = -Infinity;
    for (const slide of Array.from(scroller.children)) {
      const { left, right, width } = slide.getBoundingClientRect();
      if (!width && !slide.getClientRects().length) continue;
      const styles = window.getComputedStyle(slide);
      start = Math.min(start, left - (parseFloat(styles.marginLeft) || 0));
      end = Math.max(end, right + (parseFloat(styles.marginRight) || 0));
    }
    return end > start ? end - start : 0;
  }

  // The scroll range is many loops long, with the slides in the middle of it:
  // there is room before them (::before, in the flow) and beyond them (::after
  // marks the end, see style.css). So a scroll never has to be moved while it
  // is under way, which touch scrolling doesn't survive: a loop on, the slides
  // are shown there (onRepeat), and only at rest is the scroll put back among
  // the slides' own positions.
  const ROOM = 500000;
  let lead = 0;
  function setRoom(period: number, shift = 0): void {
    const { style } = scroller;
    if (!period) {
      lead = 0;
      style.removeProperty("--blossom-repeat-lead");
      style.removeProperty("--blossom-repeat-reach");
      if (positioned) style.removeProperty("position");
      positioned = false;
      return;
    }
    lead = (lead || ROOM) + shift;
    // a whole loop more or less shows the same: keep it about where it was
    if (Math.abs(lead - ROOM) > ROOM / 2)
      lead -= period * Math.round((lead - ROOM) / period);
    style.setProperty("--blossom-repeat-lead", `${lead}px`);
    style.setProperty(
      "--blossom-repeat-reach",
      `${lead + period + ROOM + scroller.clientWidth}px`,
    );
    // ::after needs the scroller for its containing block
    if (!positioned && window.getComputedStyle(scroller).position === "static") {
      positioned = true;
      style.setProperty("position", "relative");
    }
  }
  /** position: relative was set here, over a rule that made it static */
  let positioned = false;
  /** the first slide's natural start, logical */
  function firstStart(): number {
    const rtl = isRTL(scroller);
    const rect = scroller.getBoundingClientRect();
    let start = Infinity;
    for (const slide of Array.from(scroller.children)) {
      const { left, right, width } = slide.getBoundingClientRect();
      // one without a box
      if (!width && !slide.getClientRects().length) continue;
      start = Math.min(start, rtl ? rect.right - right : left - rect.left);
    }
    return start - scroller.clientLeft + scroller.scrollLeft * (rtl ? -1 : 1);
  }
  /** where the slides start, in their natural positions */
  let loopStart = 0;
  /** how many loops on from the slides' natural positions x (logical) is */
  const loopOf = (x: number) =>
    Math.floor((x + state.scrollerWidth / 2 - loopStart) / state.period);
  /** x brought back among the slides' natural positions */
  const homed = (x: number) => x - state.period * loopOf(x);
  /** the scroll has come too near an end of the scroll range */
  const astray = (x: number) => x < state.period || x > lead + ROOM;
  /** repeat: each slide's natural logical extent, in scroll coordinates */
  let loopSlides: Array<{ start: number; end: number; shift?: number; css?: string }> = [];
  function measureLoop(): void {
    const scrollerRect = scroller.getBoundingClientRect();
    const border =
      parseFloat(window.getComputedStyle(scroller).borderInlineStartWidth) || 0;
    loopSlides = (Array.from(scroller.children) as HTMLElement[]).map((el) => {
      const rect = el.getBoundingClientRect();
      const start =
        (state.dir === -1
          ? scrollerRect.right - rect.right
          : rect.left - scrollerRect.left) -
        border +
        scroller.scrollLeft * state.dir;
      return { start, end: start + rect.width };
    });
    loopStart = Math.min(
      ...loopSlides.filter(({ start, end }) => end > start).map(({ start }) => start),
      Infinity,
    );
    if (!Number.isFinite(loopStart)) loopStart = 0;
  }

  // The padding of a repeating scroller follows its width, so a resize moves
  // everything by half the change. Hold on to what was aligned: the nearest
  // snap target, or without snapping the content at the start edge.
  type RepeatAnchor = {
    target: HTMLElement | null;
    offset: number;
    left: number;
    /** how far into the loop the scroll is, from where the slides start */
    into: number;
  };
  let lastAnchor: RepeatAnchor | null = null;
  // where restoreRepeatAnchor meant to scroll to: scrollLeft rounds a
  // fractional position (odd widths halve into the padding), and anchoring
  // on the rounded value drifts a little further on every resize
  let restoredLeft: number | null = null;
  function repeatAnchor(): RepeatAnchor {
    let left = scroller.scrollLeft;
    if (restoredLeft !== null && Math.abs(left - restoredLeft) < 1)
      left = restoredLeft;
    else restoredLeft = null;
    // whichever loop of the scroll range it is
    const { period } = state;
    const into = period
      ? ((((left * state.dir - loopStart) % period) + period) % period) * state.dir
      : left - state.padding.start * state.dir;
    if (state.hasSnap && state.snapPositions.length) {
      const nearest = snapSelect(left, 0, FRICTION, state);
      return { target: nearest.target, offset: left - nearest.x, left, into };
    }
    return { target: null, offset: into, left, into };
  }

  /** Returns how far the slides have to be moved to bring the anchor back
   *  under the scroll; with jump (or when no longer looping) scrolls to it. */
  function restoreRepeatAnchor(
    anchor: RepeatAnchor,
    oldPeriod: number,
    jump = false,
    loose = false,
  ): number {
    if (loose) anchor = { ...anchor, target: null, offset: anchor.into };
    const base = anchor.target
      ? state.snapPositions.find(({ target }) => target === anchor.target)?.x
      : (state.period ? loopStart : state.padding.start) * state.dir;
    if (base === undefined) return 0;

    if (!state.period) {
      // no longer looping: the same content at the start edge, within range
      let offset = anchor.offset * state.dir;
      if (!anchor.target && oldPeriod)
        offset = ((offset % oldPeriod) + oldPeriod) % oldPeriod;
      const max = Math.max(state.scrollerScrollWidth - state.scrollerWidth, 0);
      const left = clamp(base * state.dir + offset, 0, max) * state.dir;
      if (Math.abs(left - scroller.scrollLeft) < 0.5) return 0;
      __scrollingInternally = true;
      scroller.scrollTo({ left, behavior: "instant" as ScrollBehavior });
      return 0;
    }

    let pos = (base + anchor.offset) * state.dir;
    if (jump) {
      restoredLeft = pos * state.dir;
      __scrollingInternally = true;
      scroller.scrollTo({ left: restoredLeft, behavior: "instant" as ScrollBehavior });
      return 0;
    }
    // the copy of it nearest to where it was
    const now = anchor.left * state.dir;
    pos += state.period * Math.round((now - pos) / state.period);
    return now - pos;
  }

  // A repeating scroller is padded by half its width on both sides, so
  // scrollLeft 0 shows the first slide in the middle. Start where a carousel
  // without repeat starts: on the first slide, at its own snap alignment.
  let hasStartPosition = false;
  /** the start position, from where the slides start */
  let startOffset = 0;
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

    startOffset = x - loopStart;
    __scrollingInternally = true;
    scroller.scrollTo({
      left: x * state.dir,
      behavior: "instant" as ScrollBehavior,
    });
  }

  function onMutation(records: MutationRecord[]): void {
    for (const { target, addedNodes, removedNodes } of records) {
      if (target !== scroller || !options?.repeat) continue;
      unfit = false;
      removedNodes.forEach((node) => {
        if (node instanceof Element) resizeObserver?.unobserve(node);
      });
      addedNodes.forEach((node) => {
        if (node instanceof Element)
          resizeObserver?.observe(node, { box: "border-box" });
      });
    }
    onResize();
  }

  function onScroll() {
    if (state.period) {
      // the scroll that put a resize's anchor back is none of the user's
      const anchored =
        restoredLeft !== null && Math.abs(scroller.scrollLeft - restoredLeft) < 1;
      if (!anchored) scrolled = true;
      onRepeat(null, null);
      if (state.period) lastAnchor = repeatAnchor();
      settleSoon(anchored);
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
    stirred = true;
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
    stirred = true;
    stepping = false;
    if (animating) isTicking.value = false;
  }

  function onTouchEnd(e: TouchEvent): void {
    touching = e.touches.length > 0;
    settleSoon();
  }

  // repeat switches native snapping off (see style.css),
  // so a scroll that core didn't run itself (wheel, keys, touch, an instant
  // or interrupted programmatic scroll) is snapped here once it has come to rest
  let settleTimer = 0;
  /** the wheel or an arrow key scrolled last: these step on, like native snapping */
  let stepping = false;
  /** where the scroll last rested on a snap position */
  let restedAt: number | null = null;
  /** the settle timer was set by a resize, not a scroll */
  let settleResized = false;
  function settleSoon(resized = false): void {
    settleResized = resized && (settleTimer === 0 || settleResized);
    window.clearTimeout(settleTimer);
    settleTimer = state.period ? window.setTimeout(settle, 100) : 0;
  }

  function settle(): void {
    settleTimer = 0;
    if (!scroller || !state.period) return;
    if (state.isDragging || touching || isTicking.value) return;

    const left = scroller.scrollLeft;
    if (!shouldSnap(left, 0, FRICTION, state)) return rest(false);

    let { x } = snapSelect(left, 0, FRICTION, state);
    // (the move back to the slides' own positions rounds anew)
    if (Math.abs(x - left) < (settleResized ? 2 : 1)) {
      restedAt = left;
      stepping = false;
      return rest(true);
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

  // the browser's scrollend is no use under repeat: it fires for every ticker
  // frame and before core has snapped. swallow it and announce
  // the rest once, like native snapping: snap events first, then scrollend
  /** where the last announced rest was */
  let restLeft = 0;
  /** a drag, a touch or a programmatic scroll began: it may end back at restLeft */
  let stirred = false;
  /** the scroll position changed since the last rest */
  let scrolled = false;
  /** the target the last scrollsnapchange announced */
  let snappedTo: HTMLElement | null = null;
  const NATIVE_REST_EVENTS = ["scrollend", "scrollsnapchange", "scrollsnapchanging"];
  function onNativeRestEvent(e: Event): void {
    // not those of a scroll container inside a slide
    if (e.isTrusted && (looping || switchFrame || quiet) && e.target === scroller)
      e.stopImmediatePropagation();
  }

  function rest(snapped: boolean): void {
    // loops on from the slides' own positions: back among them, unseen
    const pos = scroller.scrollLeft * state.dir;
    if (loopOf(pos)) {
      const shift = (homed(pos) - pos) * state.dir;
      restLeft += shift;
      if (restedAt !== null) restedAt += shift;
      restoredLeft = scroller.scrollLeft + shift;
      onRepeat(null, restoredLeft);
      __scrollingInternally = true;
      scroller.scrollTo({ left: restoredLeft, behavior: "instant" as ScrollBehavior });
    }
    const left = scroller.scrollLeft;
    const d = left - restLeft;
    const back = Math.abs(d - state.period * Math.round(d / state.period)) < 0.5;
    const moved = !back || (stirred && scrolled);
    stirred = scrolled = false;
    if (!moved) return;
    restLeft = left;

    const position = snapped ? snapSelect(left, 0, FRICTION, state) : null;
    const at = position?.target;
    if (position && at) {
      const detail = { snapTargetInline: at, snapTargetBlock: at };
      // a scroll core didn't run (wheel, instant) hasn't announced it yet
      if (at !== state.activeSnapPosition.target) {
        state.activeSnapPosition = position;
        dispatchScrollSnapChangingEvent(scroller, detail);
      }
      if (at !== snappedTo) {
        snappedTo = at;
        dispatchScrollSnapChangeEvent(scroller, detail);
      }
    }
    dispatchScrollEndEvent(scroller);
  }

  /*********************
   ******* REPEAT ******
   *********************/

  function onRepeat(_: null | undefined, x: number | null): void {
    if (!scroller || !state.period) return;

    const scrollStart = x ?? scroller.scrollLeft;
    let pos = scrollStart * state.dir; // logical (always >= 0)
    const { period, scrollerWidth } = state;

    // out of room: back to the middle. the ticker does so on its own
    // (a carousel put back in the document starts again, at scroll position 0)
    const wrapped =
      !state.isDragging && !isTicking.value && astray(pos)
        ? pos < 1
          ? loopStart + startOffset
          : homed(pos)
        : null;
    // the slides are placed for where the scroll is about to be
    if (wrapped !== null) pos = wrapped;
    const slides = Array.from(scroller.children) as HTMLElement[];

    // every slide is shown in the loop nearest the middle of the viewport: in
    // its own position while the scroll is among them
    slides.forEach((slide, i) => {
      const extent = loopSlides[i];
      if (!extent) return;
      const shift =
        period *
        Math.round((pos + scrollerWidth / 2 - (extent.start + extent.end) / 2) / period);
      // written again when something else wrote the style over it
      if (shift === extent.shift && slide.style.translate === extent.css) return;
      slide.style.translate = `${shift * state.dir}px 0`;
      extent.shift = shift;
      extent.css = slide.style.translate;
    });

    if (wrapped === null) return;
    restoredLeft = wrapped * state.dir;
    __scrollingInternally = true;
    scroller.scrollTo({
      left: wrapped * state.dir,
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

    if (state.period) {
      // out of room (see setRoom): back to the middle by whole loops, shifting
      // target too so it keeps its lead and the scroll carries on at speed
      const pos = virtualScroll.x * state.dir;
      const shift = astray(pos) ? (homed(pos) - pos) * state.dir : 0;
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
      // repeat: settle() announces the rest
      if (!state.period) {
        dispatchScrollEndEvent(scroller);
        if (state.hasSnap) {
          onScrollSnapChange(state);
        }
      }
      // momentum only approaches the snap position: land on it
      settleSoon();
    }

    if (!state.period) {
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
   * repeat: a programmatic scroll is taken the short way round the loop: any
   * number of whole loops ends in the same place. A smooth one is run by the
   * ticker, so that it lands on its destination and can be snapped; an instant
   * one jumps. Returns false to leave the scroll to the browser: one without
   * an inline position, or before there is anything to loop.
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

    // any number of whole loops ends in the same place: once round at most.
    // a position from outside the scroll range's middle (0, say, or a slide's
    // offsetLeft loops away) is taken the short way
    const from = scroller.scrollLeft * state.dir;
    let delta = (base + opts.left) * state.dir - from;
    if (Math.abs(delta) > ROOM / 4)
      delta -= state.period * Math.round(delta / state.period);
    else if (Math.abs(delta) > state.period) delta %= state.period;
    const to = (from + delta) * state.dir;

    stirred = true;
    const behavior = opts.behavior ?? "auto";
    const smooth =
      behavior === "smooth" ||
      (behavior === "auto" &&
        window.getComputedStyle(scroller).scrollBehavior === "smooth");

    if (!smooth) {
      isTicking.value = false;
      __scrollingInternally = true;
      scroller.scrollTo({
        left: to,
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
    destination = to;

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

  /**
   * repeat: a native scrollIntoView goes to where the target is laid out,
   * though it may be shown nearer, a loop on.
   * The browser still scrolls everything else (the page, containers inside a
   * slide); the carousel's own inline scroll is put back and run like scrollTo,
   * to the nearest copy of the target. Returns what to do after the native call.
   */
  function repeatScrollIntoView(
    target: Element,
    arg?: boolean | ScrollIntoViewOptions,
  ): (() => void) | void {
    if (target === scroller || !state.period || !target.getClientRects().length)
      return;
    // a scroll container in between moves the target under a smooth scroll
    for (let el = target.parentElement; el && el !== scroller; el = el.parentElement) {
      const { overflowX, overflowY } = window.getComputedStyle(el);
      if (/auto|scroll|hidden/.test(overflowX + overflowY)) return;
    }
    const opts: ScrollIntoViewOptions =
      typeof arg === "object" && arg !== null ? arg : {};
    const inline = opts.inline ?? "nearest";

    // logical (start to end) edges of the target in the scrollport
    const { left } = scroller.getBoundingClientRect();
    const edge =
      left + scroller.clientLeft + (state.dir === 1 ? 0 : scroller.clientWidth);
    const rect = target.getBoundingClientRect();
    const styles = window.getComputedStyle(target);
    const a = (rect.left - edge) * state.dir;
    const b = (rect.right - edge) * state.dir;
    const start = Math.min(a, b) - (parseFloat(styles.scrollMarginInlineStart) || 0);
    const end = Math.max(a, b) + (parseFloat(styles.scrollMarginInlineEnd) || 0);
    const viewStart = state.scrollPadding.start;
    const viewEnd = scroller.clientWidth - state.scrollPadding.end;

    const alignStart = start - viewStart;
    const alignEnd = end - viewEnd;
    const fits = end - start <= viewEnd - viewStart;
    let delta =
      inline === "start"
        ? alignStart
        : inline === "end"
          ? alignEnd
          : inline === "center"
            ? (alignStart + alignEnd) / 2
            : // nearest: nothing when it is in view or covers it
              alignStart < 0 === alignEnd > 0
              ? 0
              : alignStart < 0 === fits
                ? alignStart
                : alignEnd;
    // the nearest copy: the target is in the loop once
    delta -= state.period * Math.round(delta / state.period);

    const from = scroller.scrollLeft;
    return () => {
      // undo what the browser did, or began to do, inline
      __scrollingInternally = true;
      scroller.scrollTo({ left: from, behavior: "instant" as ScrollBehavior });
      if (Math.abs(delta) >= 0.5)
        scroller.scrollBy({ left: delta * state.dir, behavior: opts.behavior });
    };
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
