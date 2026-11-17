import type { CarouselState } from "./state";
import type { AlignOption } from "./types";

const alignmentMap = {
  center: (l: number, w: number, state: CarouselState) =>
    l + w * 0.5 - state.scrollerWidth / 2,
  end: (l: number, w: number, state: CarouselState) =>
    l + w - state.scrollerWidth + state.scrollPadding.end,
  start: (l: number, w: number, state: CarouselState) =>
    l - state.scrollPadding.start,
  // RTL: the inline start is the right-hand edge. l is a slide position, the
  // left edge less the start padding
  rtl: {
    center: (l: number, w: number, state: CarouselState) =>
      l + state.scrollPadding.start + w * 0.5 - state.scrollerWidth / 2,
    end: (l: number, w: number, state: CarouselState) =>
      l + state.scrollPadding.start - state.scrollPadding.end,
    start: (l: number, w: number, state: CarouselState) =>
      l + w - state.scrollerWidth + state.scrollPadding.start * 2,
  },
} as const;

function alignedPosition(
  left: number,
  width: number,
  align: AlignOption | undefined,
  state: CarouselState,
): number {
  if (state.hasSnap) return left;
  const key = (align || "start") as "start" | "center" | "end";
  const alignFn = state.dir === -1 ? alignmentMap.rtl[key] : alignmentMap[key];
  return alignFn(left, width, state);
}

function findTargetPosition(
  dir: "prev" | "next",
  align: AlignOption | undefined,
  state: CarouselState,
): number | null {
  if (!state.scroller) return null;

  // logical positions: they grow towards the inline end, in RTL too
  const sign = state.dir;
  const left = state.scroller.scrollLeft * sign;
  const positions = state.snapPositions.length
    ? state.snapPositions
    : state.slidePositions;

  const aligned = positions.map(
    (position) => alignedPosition(position.x, position.width || 0, align, state) * sign,
  );
  const { period } = state;
  if (period) {
    // repeat: every position comes round again each loop, take the first
    // occurrence beyond where the scroll is
    let best: number | null = null;
    for (const x of aligned) {
      const posX =
        dir === "prev"
          ? x + period * Math.ceil((left - 1 - x) / period - 1)
          : x + period * Math.floor((left + 1 - x) / period + 1);
      if (best === null || (dir === "prev" ? posX > best : posX < best)) best = posX;
    }
    return best === null ? null : best * sign;
  }
  if (dir === "prev") {
    for (let i = aligned.length - 1; i >= 0; i--)
      if (aligned[i] < left - 1) return aligned[i] * sign;
  } else {
    for (const x of aligned) if (x > left + 1) return x * sign;
  }
  return null;
}

export function prev(
  state: CarouselState,
  { align }: { align?: AlignOption } = {},
): void {
  const targetPosition = findTargetPosition("prev", align, state);
  if (targetPosition === null) return;
  state.scroller!.scrollTo({ left: targetPosition, behavior: "smooth" });
}

export function next(
  state: CarouselState,
  { align }: { align?: AlignOption } = {},
): void {
  const targetPosition = findTargetPosition("next", align, state);
  if (targetPosition === null) return;
  state.scroller!.scrollTo({ left: targetPosition, behavior: "smooth" });
}
