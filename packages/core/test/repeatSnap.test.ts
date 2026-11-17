import { describe, expect, it } from "vitest";
import { dragSnap, restInLoop, shouldSnap, snapSelect } from "../src/snap";
import { next, prev } from "../src/methods";
import { createState } from "../src/state";
import { FRICTION } from "../src/constants";

// 4 slides of 100px in a loop of 400px; snap positions at 50, 150, 250, 350
function loop(dir: 1 | -1 = 1) {
  const state = createState();
  const scroller = document.createElement("div");
  state.scroller = scroller;
  state.hasSnap = true;
  state.snapMandatory = true;
  state.dir = dir;
  state.period = 400;
  state.end = 396 * dir;
  state.scrollerWidth = 200;
  state.scrollerScrollWidth = 600;
  state.snapPositions = [50, 150, 250, 350].map((x) => ({
    target: document.createElement("div"),
    x: x * dir,
    y: 0,
  }));
  return state;
}

describe("snapping with repeat", () => {
  it("picks the nearest position round the loop", () => {
    const state = loop();

    // 10 is 40 from the first position, and 60 from the last one a loop back
    expect(snapSelect(10, 0, FRICTION, state).target).toBe(
      state.snapPositions[0].target,
    );
    // -20 is 30 from the last position a loop back
    const last = snapSelect(-20, 0, FRICTION, state);
    expect(last.target).toBe(state.snapPositions[3].target);
    expect(last.x).toBe(-50);
    // 420 is 30 from the first position a loop on
    const first = snapSelect(420, 0, FRICTION, state);
    expect(first.target).toBe(state.snapPositions[0].target);
    expect(first.x).toBe(450);
  });

  it("picks the nearest position round the loop in RTL", () => {
    const state = loop(-1);

    const last = snapSelect(20, 0, FRICTION, state);
    expect(last.target).toBe(state.snapPositions[3].target);
    expect(last.x).toBe(50);
  });

  it("keeps positions linear without repeat", () => {
    const state = loop();
    state.period = 0;

    expect(snapSelect(-20, 0, FRICTION, state)).toBe(state.snapPositions[0]);
  });

  it("drags snap beyond the seam instead of springing back", () => {
    const state = loop();
    state.activeSnapPosition = state.snapPositions[0];

    // released at -20: heads on to -50 (the last slide), not back to 50
    expect(dragSnap(-20, 0, FRICTION, state)).toBeLessThan(0);
    expect(state.activeSnapPosition.target).toBe(state.snapPositions[3].target);
  });

  it("measures proximity round the loop", () => {
    const state = loop();
    state.snapMandatory = false;
    state.snapPositions = [state.snapPositions[3]]; // only 350

    expect(shouldSnap(-40, 0, FRICTION, state)).toBe(true); // 10 away
    expect(shouldSnap(150, 0, FRICTION, state)).toBe(false); // 200 away
  });

  it("keeps a rest out of the band around the seam", () => {
    const state = loop();

    expect(restInLoop(150, state)).toBe(150);
    expect(restInLoop(2, state)).toBe(4);
    expect(restInLoop(399, state)).toBe(396);
    expect(restInLoop(802, state)).toBe(804);
    expect(restInLoop(-150, loop(-1))).toBe(-150);
    expect(restInLoop(-2, loop(-1))).toBe(-4);
  });
});

describe("next and prev in RTL", () => {
  function scrollTarget(state: ReturnType<typeof loop>, left: number) {
    let to: number | undefined;
    Object.defineProperty(state.scroller, "scrollLeft", { value: left });
    state.scroller!.scrollTo = ((options: ScrollToOptions) => {
      to = options.left;
    }) as typeof state.scroller.scrollTo;
    return () => to;
  }

  it("go to the neighbouring positions", () => {
    const state = loop(-1);
    state.period = 0;
    const to = scrollTarget(state, -150);

    next(state);
    expect(to()).toBe(-250);
    prev(state);
    expect(to()).toBe(-50);
  });

  it("go round the loop with repeat", () => {
    const state = loop(-1);
    const to = scrollTarget(state, -350);

    next(state);
    expect(to()).toBe(-450);
  });
});
