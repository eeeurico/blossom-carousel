import { describe, expect, it, vi } from "vitest";
import { next, prev } from "../src/methods";
import { createState } from "../src/state";

function createFakeScroller(scrollLeft: number) {
  return {
    scrollLeft,
    scrollTo: vi.fn(),
  } as unknown as HTMLElement;
}

describe("next", () => {
  it("scrolls to the next slide position", () => {
    const state = createState();
    const scroller = createFakeScroller(100);
    state.scroller = scroller;
    state.slidePositions = [
      { x: 20, y: 0, target: null, width: 100, height: 40 },
      { x: 120, y: 0, target: null, width: 100, height: 40 },
      { x: 240, y: 0, target: null, width: 100, height: 40 },
    ];

    next(state);

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      left: 120,
      behavior: "smooth",
    });
  });

  it("prefers snap positions when they are available", () => {
    const state = createState();
    state.hasSnap = true;
    const scroller = createFakeScroller(10);
    state.scroller = scroller;
    state.slidePositions = [
      { x: 200, y: 0, target: null, width: 100, height: 40 },
      { x: 320, y: 0, target: null, width: 100, height: 40 },
    ];

    state.snapPositions = [
      { target: null, x: 0, y: 0 },
      { target: null, x: 80, y: 0 },
      { target: null, x: 160, y: 0 },
    ];

    next(state);

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      left: 80,
      behavior: "smooth",
    });
  });

  it("does nothing when there is no next slide", () => {
    const state = createState();
    const scroller = createFakeScroller(240);
    state.scroller = scroller;
    state.slidePositions = [
      { x: 20, y: 0, target: null, width: 100, height: 40 },
      { x: 120, y: 0, target: null, width: 100, height: 40 },
      { x: 240, y: 0, target: null, width: 100, height: 40 },
    ];

    next(state);

    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});

describe("prev", () => {
  it("scrolls to the previous slide position", () => {
    const state = createState();
    const scroller = createFakeScroller(240);
    state.scroller = scroller;
    state.slidePositions = [
      { x: 20, y: 0, target: null, width: 100, height: 40 },
      { x: 120, y: 0, target: null, width: 100, height: 40 },
      { x: 240, y: 0, target: null, width: 100, height: 40 },
    ];

    prev(state);

    expect(scroller.scrollTo).toHaveBeenCalledWith({
      left: 120,
      behavior: "smooth",
    });
  });

  it("does nothing when there is no previous slide", () => {
    const state = createState();
    const scroller = createFakeScroller(20);
    state.scroller = scroller;
    state.slidePositions = [
      { x: 20, y: 0, target: null, width: 100, height: 40 },
      { x: 120, y: 0, target: null, width: 100, height: 40 },
      { x: 240, y: 0, target: null, width: 100, height: 40 },
    ];

    prev(state);

    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});

describe("with repeat (state.period)", () => {
  function loopState(scrollLeft: number) {
    const state = createState();
    state.scroller = createFakeScroller(scrollLeft);
    state.period = 400;
    state.slidePositions = [
      { x: 92, y: 0, target: null, width: 100, height: 40 },
      { x: 192, y: 0, target: null, width: 100, height: 40 },
      { x: 292, y: 0, target: null, width: 100, height: 40 },
      { x: 392, y: 0, target: null, width: 100, height: 40 },
    ];
    return state;
  }

  it("next past the last slide goes on to the first, one loop on", () => {
    const state = loopState(392);
    next(state);
    expect(state.scroller!.scrollTo).toHaveBeenCalledWith({
      left: 492,
      behavior: "smooth",
    });
  });

  it("prev before the first slide goes back to the last, one loop back", () => {
    const state = loopState(92);
    prev(state);
    expect(state.scroller!.scrollTo).toHaveBeenCalledWith({
      left: -8,
      behavior: "smooth",
    });
  });

  it("still prefers a slide within the loop", () => {
    const state = loopState(192);
    next(state);
    prev(state);
    expect(
      (state.scroller!.scrollTo as ReturnType<typeof vi.fn>).mock.calls,
    ).toEqual([
      [{ left: 292, behavior: "smooth" }],
      [{ left: 92, behavior: "smooth" }],
    ]);
  });

  it("loops snap positions too", () => {
    const state = loopState(392);
    state.hasSnap = true;
    state.snapPositions = state.slidePositions.map(({ x }) => ({
      target: null,
      x,
      y: 0,
    }));
    next(state);
    expect(state.scroller!.scrollTo).toHaveBeenCalledWith({
      left: 492,
      behavior: "smooth",
    });
  });
});
