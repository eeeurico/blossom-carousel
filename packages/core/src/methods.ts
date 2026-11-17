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

  // repeat: past the last position comes the first one again, one loop on
  const loops = state.period ? [0, state.period] : [0];

  for (const loop of loops) {
    if (dir === "prev") {
      for (let i = positions.length - 1; i >= 0; i--) {
        const posX =
          alignedPosition(positions[i].x, positions[i].width || 0, align, state) *
            sign -
          loop;
        if (posX < left - 1) return posX * sign;
      }
    } else {
      for (let i = 0; i < positions.length; i++) {
        const posX =
          alignedPosition(positions[i].x, positions[i].width || 0, align, state) *
            sign +
          loop;
        if (posX > left + 1) return posX * sign;
      }
    }
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
