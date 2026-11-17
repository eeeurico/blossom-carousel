import type { SnapPosition } from "./types.js";
import {
  dispatchScrollSnapChangeEvent,
  dispatchScrollSnapChangingEvent,
} from "./events";
import type { CarouselState } from "./state";
import { FRICTION } from "./constants.js";
import { clamp, project } from "./utils.js";

export type SnapStore = {
  positions: SnapPosition[];
  activePosition: SnapPosition;
};

export function createSnapStore(): SnapStore {
  return {
    positions: [],
    activePosition: { target: null, x: 0, y: 0 },
  };
}

type PositionRestore = {
  el: HTMLElement;
  value: string;
  priority: string;
};

function restorePosition(restores: PositionRestore[]): void {
  for (const { el, value, priority } of restores) {
    if (value) {
      el.style.setProperty("position", value, priority);
    } else {
      el.style.removeProperty("position");
    }
  }
}

export function findSnapPositions(
  scroller: HTMLElement,
  state: CarouselState,
): void {
  let positions: { align: string; el: HTMLElement | Element }[] = [];
  const stickyRestores: PositionRestore[] = [];

  const walker = document.createTreeWalker(scroller, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();

  while (node) {
    const styles = window.getComputedStyle(node as Element);
    const scrollSnapAlign = styles.scrollSnapAlign;
    const el = node as HTMLElement;

    if (scrollSnapAlign !== "none") {
      positions.push({
        align: scrollSnapAlign,
        el,
      });
    }

    // Temporarily disable sticky positioning to get correct bounding rects
    if (styles.position === "sticky") {
      stickyRestores.push({
        el,
        value: el.style.getPropertyValue("position"),
        priority: el.style.getPropertyPriority("position"),
      });
      el.style.setProperty("position", "static", "important");
    }

    node = walker.nextNode();
  }

  let snapPositions: Array<SnapPosition | null>;

  try {
    const scrollerRect = scroller.getBoundingClientRect();
    snapPositions = positions.map(({ el, align }) => {
      const target = el as HTMLElement;
      const elementRect = target.getBoundingClientRect();
      const clientWidth = target.clientWidth;
      const left = elementRect.left - scrollerRect.left + scroller.scrollLeft;
      const styles = window.getComputedStyle(target);
      const marginStart = parseFloat(styles.scrollMarginInlineStart) || 0;
      const marginEnd = parseFloat(styles.scrollMarginInlineEnd) || 0;
      // physical edges: in RTL the inline start is the right-hand one
      const rtl = state.dir === -1;
      const snapAreaStart = left - (rtl ? marginEnd : marginStart);
      const snapAreaEnd = left + clientWidth + (rtl ? marginStart : marginEnd);
      const paddingLeft = rtl ? state.scrollPadding.end : state.scrollPadding.start;
      const paddingRight = rtl ? state.scrollPadding.start : state.scrollPadding.end;

      switch (rtl ? { start: "end", end: "start" }[align] || align : align) {
        case "start":
          return {
            target,
            x: snapAreaStart - paddingLeft,
            y: 0,
          };
        case "end":
          return {
            target,
            x: snapAreaEnd - state.scrollerWidth + paddingRight,
            y: 0,
          };
        case "center":
          return {
            target,
            x: (snapAreaStart + snapAreaEnd) / 2 - state.scrollerWidth / 2,
            y: 0,
          };
        default:
          return null;
      }
    });
  } finally {
    restorePosition(stickyRestores);
  }

  // Filter out duplicates (i.e. in case of multiple rows)
  const filteredSnapPositions = snapPositions
    .filter((snapPosition) => snapPosition !== null)
    .reduce((acc: SnapPosition[], curr: SnapPosition) => {
      if (acc.length === 0 || acc[acc.length - 1].x !== curr.x) {
        acc.push(curr);
      }
      return acc;
    }, []);

  state.snapPositions = filteredSnapPositions;
}

export function shouldSnap(
  target: number,
  velocity: number,
  friction: number,
  state: CarouselState,
): boolean {
  if (!state.hasSnap || !state.snapPositions.length) {
    return false;
  }

  if (state.snapMandatory) {
    return true;
  }

  const restingX = project(target, velocity, friction);
  const snapportWidth = Math.max(
    state.scrollerWidth - state.scrollPadding.start - state.scrollPadding.end,
    0,
  );
  const proximityThreshold = snapportWidth / 3;
  const nearest = snapSelect(target, velocity, friction, state);

  return Math.abs(nearest.x - restingX) <= proximityThreshold;
}

export function dragSnap(
  target: number,
  velocity: number,
  friction: number,
  state: CarouselState,
): number {
  const newSnapPosition = snapSelect(target, velocity, friction, state);
  if (hasChanged(newSnapPosition, state)) {
    dispatchScrollSnapChangingEvent(state.scroller, {
      snapTargetInline: (newSnapPosition || state.activeSnapPosition).target,
      snapTargetBlock: (newSnapPosition || state.activeSnapPosition).target,
    });
  }
  state.activeSnapPosition = newSnapPosition;
  // repeat: every position is in reach (see setRoom)
  const slideX = state.period
    ? newSnapPosition.x
    : clamp(
        newSnapPosition.x,
        Math.min((state.scrollerScrollWidth - state.scrollerWidth) * state.dir, 0),
        Math.max((state.scrollerScrollWidth - state.scrollerWidth) * state.dir, 0),
      );
  const distance = slideX - target;
  const force = distance * (1 - FRICTION) * (1 / FRICTION);
  return force;
}

export function snapSelect(
  target: number,
  velocity: number,
  friction: number,
  state: CarouselState,
): SnapPosition {
  const restingX = project(target, velocity, friction);
  if (!state.snapPositions.length) {
    return {
      target: null,
      x: clamp(restingX, Math.min(state.end, 0), Math.max(state.end, 0)),
      y: 0,
    };
  }

  // repeat: every position comes round again one loop on, take the occurrence
  // nearest to where the scroll comes to rest
  const { period } = state;
  const near = (x: number) =>
    period ? x - period * Math.round((x - restingX) / period) : x;

  let nearest = state.snapPositions[0];
  let nearestX = near(nearest.x);
  for (const position of state.snapPositions) {
    const x = near(position.x);
    if (Math.abs(x - restingX) < Math.abs(nearestX - restingX)) {
      nearest = position;
      nearestX = x;
    }
  }
  return period ? { ...nearest, x: nearestX } : nearest;
}

function hasChanged(position: SnapPosition, state: CarouselState): boolean {
  // repeat: the same target has a different x on every loop
  return state.period
    ? position.target !== state.activeSnapPosition.target
    : position.x !== state.activeSnapPosition.x;
}

export function onScrollSnapChange(state: CarouselState): void {
  dispatchScrollSnapChangeEvent(state.scroller, {
    snapTargetInline: state.activeSnapPosition.target,
    snapTargetBlock: state.activeSnapPosition.target,
  });
}

export function onSnapChanging(
  target: number,
  velocity: number,
  friction: number,
  state: CarouselState,
): void {
  const newSnapPosition = snapSelect(target, velocity, friction, state);
  if (hasChanged(newSnapPosition, state)) {
    state.activeSnapPosition = newSnapPosition;
    dispatchScrollSnapChangingEvent(state.scroller, {
      snapTargetInline: (newSnapPosition || state.activeSnapPosition).target,
      snapTargetBlock: (newSnapPosition || state.activeSnapPosition).target,
    });
  }
}
