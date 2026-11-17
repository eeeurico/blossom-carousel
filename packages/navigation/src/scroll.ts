import {
  getSnapPositions,
  isRepeat,
  isRtl,
  logicalScrollLeft,
  repeatPeriod,
  wrap,
  type SnapPoint,
} from "./snap";
import { getSnapCache } from "./cache";
import type { Direction } from "./types";

/** ::scroll-button() pages ~85% of the scrollport. */
const PAGE_RATIO = 0.85;
const EPSILON = 1;

/**
 * Mirrors `::scroll-button():disabled`: a direction is scrollable only when the
 * scroller hasn't reached the corresponding edge. `scrollLeft` is normalized via
 * `Math.abs` so this also holds in RTL where it is negative.
 */
export function canScroll(scroller: HTMLElement, dir: Direction): boolean {
  // A repeat scroller loops, so there is always more in both directions.
  if (isRepeat(scroller)) return true;
  const max = Math.max(scroller.scrollWidth - scroller.clientWidth, 0);
  const position = Math.abs(scroller.scrollLeft);
  return dir === "prev"
    ? position > EPSILON
    : position < max - EPSILON;
}

function adjacentSnap(
  points: SnapPoint[],
  current: number,
  dir: Direction,
): SnapPoint | null {
  // Skip cached points whose element was detached (a slide removed before the
  // cache refresh runs), mirroring the staleness guard in the goto command —
  // `scrollIntoView` on a detached element would silently no-op.
  if (dir === "next") {
    for (let i = 0; i < points.length; i++) {
      if (points[i].x > current + EPSILON && points[i].el.isConnected)
        return points[i];
    }
  } else {
    for (let i = points.length - 1; i >= 0; i--) {
      if (points[i].x < current - EPSILON && points[i].el.isConnected)
        return points[i];
    }
  }
  return null;
}

/**
 * Mirrors `::scroll-button()` activation: advance to the next/previous snap
 * point when scroll-snap is in use (brought into view with its own inline
 * alignment), otherwise page by ~85% of the scrollport.
 */
export function pageScroll(
  scroller: HTMLElement,
  dir: Direction,
  behavior: ScrollBehavior = "smooth",
): void {
  // Prefer the host-maintained cache; fall back to a live read for plain usage.
  const cache = getSnapCache(scroller);
  const points = cache?.pages ?? getSnapPositions(scroller);
  const rtl = cache?.rtl ?? isRtl(scroller);
  const period = cache?.period ?? repeatPeriod(scroller);

  if (period) {
    const sign = dir === "next" ? 1 : -1;
    repeatScroll(scroller, period, rtl, behavior, (origin) => {
      if (!points.length) return sign * scroller.clientWidth * PAGE_RATIO;
      // The nearest point more than EPSILON ahead in the direction of travel;
      // the one we are on is a full loop away.
      let step = Infinity;
      for (const point of points) {
        if (!point.el.isConnected) continue;
        const ahead = wrap(sign * (point.x - origin) - EPSILON, period) + EPSILON;
        step = Math.min(step, ahead > EPSILON ? ahead : ahead + period);
      }
      return Number.isFinite(step) ? sign * step : 0;
    });
    return;
  }

  if (points.length) {
    const target = adjacentSnap(points, logicalScrollLeft(scroller, rtl), dir);
    if (!target) return;
    target.el.scrollIntoView({
      block: "nearest",
      inline: target.align,
      behavior,
    });
    return;
  }

  const delta = scroller.clientWidth * PAGE_RATIO * (dir === "next" ? 1 : -1);
  // `scrollBy` takes a physical delta; flip it so "next" advances towards the
  // inline-end in RTL too.
  scroller.scrollBy({ left: rtl ? -delta : delta, behavior });
}

/** How long a smooth repeat scroll may go without a scroll event and still count as in flight. */
const IN_FLIGHT_MS = 150;

interface Heading {
  /** Logical loop position (in `[0, period)`) the scroll is heading to. */
  x: number;
  /** Direction of travel: 1 towards the inline-end, -1 towards the start. */
  sign: number;
  /** Time of the request or of the last scroll event since. */
  at: number;
}

const headings = new WeakMap<HTMLElement, Heading>();
const tracked = new WeakSet<HTMLElement>();

/** Keeps a scroller's heading alive while it scrolls; user input drops it. */
function trackHeading(scroller: HTMLElement): void {
  if (tracked.has(scroller)) return;
  tracked.add(scroller);
  scroller.addEventListener(
    "scroll",
    () => {
      const heading = headings.get(scroller);
      if (heading) heading.at = performance.now();
    },
    { passive: true },
  );
  const drop = () => headings.delete(scroller);
  for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) {
    scroller.addEventListener(type, drop, { passive: true });
  }
}

/**
 * Scrolls a `repeat` scroller by `step(origin)` logical px, measured from
 * `origin`: where a smooth navigation still in flight is heading, so quick
 * repeated clicks each add a step instead of re-targeting the point the
 * scroller is moving towards; otherwise the current position. The destination
 * may lie beyond the seam: core animates there through it (and an instant
 * scroll lands on the same spot inside the scroll range).
 */
export function repeatScroll(
  scroller: HTMLElement,
  period: number,
  rtl: boolean,
  behavior: ScrollBehavior,
  step: (origin: number) => number,
): void {
  const current = logicalScrollLeft(scroller, rtl);
  const heading = headings.get(scroller);
  let origin = wrap(current, period);
  // Distance still to travel to the heading, in its direction of travel.
  let ahead = 0;
  if (heading && performance.now() - heading.at < IN_FLIGHT_MS) {
    origin = heading.x;
    ahead = heading.sign * wrap(heading.sign * (heading.x - current), period);
    // Arrived, give or take rounding.
    if (Math.abs(ahead) > period - EPSILON) ahead = 0;
  }

  const delta = ahead + step(origin);
  headings.delete(scroller);
  if (Math.abs(delta) < EPSILON / 2) return;

  scroller.scrollTo({
    left: scroller.scrollLeft + (rtl ? -delta : delta),
    behavior,
  });

  const smooth =
    behavior === "smooth" ||
    (behavior === "auto" && getComputedStyle(scroller).scrollBehavior === "smooth");
  if (smooth) {
    trackHeading(scroller);
    headings.set(scroller, {
      x: wrap(origin + delta - ahead, period),
      sign: Math.sign(delta),
      at: performance.now(),
    });
  }
}

/**
 * Scrolls a `repeat` scroller to logical loop position `x` the shortest way
 * round (from where an in-flight navigation is heading, see repeatScroll).
 */
export function repeatScrollTo(
  scroller: HTMLElement,
  x: number,
  behavior: ScrollBehavior,
  period: number = repeatPeriod(scroller),
  rtl: boolean = isRtl(scroller),
): void {
  repeatScroll(scroller, period, rtl, behavior, (origin) => {
    const forward = wrap(x - origin, period);
    return forward > period / 2 ? forward - period : forward;
  });
}
