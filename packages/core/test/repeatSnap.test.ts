import { describe, expect, it } from "vitest";
import { dragSnap, shouldSnap, snapSelect } from "../src/snap";
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

  it.each([1, -1] as const)(
    "leaves a rest exactly on a loop boundary alone (dir %i)",
    (dir) => {
      const state = loop(dir);
      // the slides' start and end snap positions lie on the boundary
      state.snapPositions.forEach((position, i) => (position.x = i * 100 * dir));

      expect(snapSelect(2 * dir, 0, FRICTION, state).x + 0).toBe(0);
      expect(snapSelect(402 * dir, 0, FRICTION, state).x).toBe(400 * dir);
      expect(snapSelect(-398 * dir, 0, FRICTION, state).x).toBe(-400 * dir);
      expect(snapSelect(-2 * dir, 0, FRICTION, state).x + 0).toBe(0);
    },
  );

  it("takes positions many loops out as they are", () => {
    const state = loop();

    const far = snapSelect(500000 + 140, 0, FRICTION, state);
    expect(far.target).toBe(state.snapPositions[1].target);
    expect(far.x).toBe(500000 + 150);
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

describe.each([1, -1] as const)("next and prev in the middle of the range (dir %i)", (dir) => {
  const HOME = 500000; // a whole number of periods
  function scrollTarget(state: ReturnType<typeof loop>, left: number) {
    let to: number | undefined;
    Object.defineProperty(state.scroller, "scrollLeft", { value: left * dir });
    state.scroller!.scrollTo = ((options: ScrollToOptions) => {
      to = options.left;
    }) as typeof state.scroller.scrollTo;
    return () => to;
  }

  it.each([
    // [at, next, prev]: positions at 50, 150, 250, 350 round every loop
    [150, 250, 50],
    [350, 450, 250], // the first slide again, a loop on
    [50, 150, -50], // the last slide, a loop back
    [60, 150, 50],
  ])("from HOME + %i go to HOME + %i and HOME + %i", (at, forward, back) => {
    const state = loop(dir);
    const to = scrollTarget(state, HOME + at);

    next(state);
    expect(to()).toBe((HOME + forward) * dir);
    prev(state);
    expect(to()).toBe((HOME + back) * dir);
  });
});

describe.each([1, -1] as const)("next and prev around the lead (dir %i)", (dir) => {
  // the ::before pushes the slides LEAD in: their natural snap positions are
  // there, and the scroll may be any number of loops either side of them
  const LEAD = 500000;
  function natural() {
    const state = loop(dir);
    state.snapPositions.forEach((position, i) => (position.x = (LEAD + 150 + i * 100) * dir));
    return state;
  }
  function scrollTarget(state: ReturnType<typeof loop>, left: number) {
    let to: number | undefined;
    Object.defineProperty(state.scroller, "scrollLeft", { value: left * dir });
    state.scroller!.scrollTo = ((options: ScrollToOptions) => {
      to = options.left;
    }) as typeof state.scroller.scrollTo;
    return () => to;
  }

  it.each([
    // [at, next, prev]: positions at 150, 250, 350, 450 round every loop
    [-200, -150, -250], // a loop before the slides
    [150, 250, 50], // on the first: the last one a loop back
    [150.5, 250, 50], // within a pixel of it
    [450, 550, 350], // on the last: the first one a loop on
    [1000, 1050, 950], // loops on
  ])("from LEAD + %d go to LEAD + %d and LEAD + %d", (at, forward, back) => {
    const state = natural();
    const to = scrollTarget(state, LEAD + at);

    next(state);
    expect(to()).toBe((LEAD + forward) * dir);
    prev(state);
    expect(to()).toBe((LEAD + back) * dir);
  });
});
