import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@bramus/style-observer", () => ({
  default: class {
    observe() {}
    unobserve() {}
  },
  ReturnFormat: { OBJECT: "object" },
}));

import { Blossom } from "../src/index";

// jsdom has no layout: 4 slides of 100px in a 200px wide scroller, padded
// 92px / 108px the way `has-repeat` pads it calc(50% - 8px) / calc(50% + 8px).
const SLIDE = 100;
const COUNT = 4;
const CLIENT = 200;
const PAD_START = CLIENT / 2 - 8; // 92
const PAD_END = CLIENT / 2 + 8; // 108
const SCROLL = PAD_START + SLIDE * COUNT + PAD_END; // 600
const PERIOD = SCROLL - CLIENT; // 400
const END = PERIOD - 4; // 396

interface Options {
  dir?: "ltr" | "rtl";
  repeat?: boolean;
  /** computed scroll-snap-type of the scroller */
  snapType?: string;
  /** computed scroll-snap-align of the slides */
  align?: string;
  scrollBehavior?: string;
  /** "mouse" runs core's drag ticker (hasOverflow), "touch" leaves it off */
  pointer?: "mouse" | "touch";
}

/** Hides `ontouchmove` from window (jsdom has it) until afterEach. */
let restoreTouch: (() => void) | undefined;
function hideTouch() {
  let owner: object | null = window;
  while (owner && !Object.prototype.hasOwnProperty.call(owner, "ontouchmove"))
    owner = Object.getPrototypeOf(owner);
  if (!owner) return;
  const descriptor = Object.getOwnPropertyDescriptor(owner, "ontouchmove")!;
  delete (owner as Record<string, unknown>).ontouchmove;
  restoreTouch = () => Object.defineProperty(owner, "ontouchmove", descriptor);
}

function setup({
  dir = "ltr",
  repeat = true,
  snapType = "none",
  align = "none",
  scrollBehavior = "auto",
  pointer = "touch",
}: Options = {}) {
  if (pointer === "mouse") hideTouch();
  const rtl = dir === "rtl";
  let resize: () => void = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: true }));

  // a manual frame clock: nothing runs until frame() is called
  let now = 1000;
  let frames: FrameRequestCallback[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  const frame = () => {
    now += 1000 / 60;
    const queued = frames;
    frames = [];
    for (const cb of queued) cb(now);
  };
  /** Runs frames until the ticker stops (or gives up). */
  const settle = (max = 2000) => {
    let n = 0;
    while (frames.length && n++ < max) frame();
    return n;
  };

  const scroller = document.createElement("div");
  const slides = Array.from({ length: COUNT }, () => {
    const slide = document.createElement("div");
    Object.defineProperty(slide, "clientWidth", { value: SLIDE });
    scroller.append(slide);
    return slide;
  });
  document.body.append(scroller);

  let scrollLeft = 0;
  Object.defineProperty(scroller, "scrollLeft", {
    get: () => scrollLeft,
    set: (value: number) => (scrollLeft = value),
  });
  Object.defineProperty(scroller, "clientWidth", { value: CLIENT });
  Object.defineProperty(scroller, "scrollWidth", { value: SCROLL });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, CLIENT, 100);
  slides.forEach((slide, i) => {
    slide.getBoundingClientRect = () => {
      const start = PAD_START + i * SLIDE; // logical, natural
      const logical = rtl ? -scrollLeft : scrollLeft;
      const tx = parseFloat(slide.style.translate) || 0;
      const x = rtl
        ? CLIENT - (start - logical) - SLIDE + tx
        : start - logical + tx;
      return new DOMRect(x, 0, SLIDE, 100);
    };
  });

  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (el: Element) =>
      (el === scroller
        ? {
            direction: dir,
            scrollSnapType: snapType,
            scrollSnapAlign: "none",
            scrollBehavior,
            paddingInlineStart: `${PAD_START}px`,
            paddingInlineEnd: `${PAD_END}px`,
            scrollPaddingInlineStart: "0px",
            scrollPaddingInlineEnd: "0px",
            getPropertyValue: () => "auto",
          }
        : {
            direction: dir,
            scrollSnapAlign: align,
            scrollMarginInlineStart: "0px",
            scrollMarginInlineEnd: "0px",
            position: "static",
          }) as unknown as CSSStyleDeclaration,
  );

  // the browser's own scrollTo/scrollBy: an instant jump, any other
  // behavior is only recorded
  const native = vi.fn((options: ScrollToOptions) => {
    if (options.behavior === "instant" && typeof options.left === "number")
      scrollLeft = options.left;
  });
  scroller.scrollTo = ((...args: unknown[]) =>
    native(
      typeof args[0] === "object"
        ? (args[0] as ScrollToOptions)
        : { left: args[0] as number, top: args[1] as number },
    )) as typeof scroller.scrollTo;
  const nativeBy = vi.fn();
  scroller.scrollBy = nativeBy as unknown as typeof scroller.scrollBy;

  const blossom = Blossom(scroller, { repeat });
  blossom.init();
  resize();
  const start = native.mock.calls.map(([o]) => o);
  native.mockClear();

  const scrollToPosition = (left: number) => {
    scrollLeft = left;
    scroller.dispatchEvent(new Event("scroll"));
  };
  /** left of every instant jump the browser was asked for since the last clear */
  const jumps = () =>
    native.mock.calls
      .map(([o]) => o)
      .filter((o) => o.behavior === "instant")
      .map((o) => o.left as number);

  return {
    blossom,
    scroller,
    slides,
    native,
    nativeBy,
    start,
    frame,
    settle,
    pending: () => frames.length,
    resize,
    scrollToPosition,
    jumps,
    getScrollLeft: () => scrollLeft,
  };
}

/**
 * Records capture listeners, to hand them a browser event: dispatchEvent only
 * ever delivers untrusted ones.
 */
function captureListeners() {
  const spy = vi.spyOn(EventTarget.prototype, "addEventListener");
  return (target: EventTarget, type: string) =>
    spy.mock.calls
      .filter(
        ([t, , options], i) =>
          spy.mock.contexts[i] === target &&
          t === type &&
          (options === true || (typeof options === "object" && !!options.capture)),
      )
      .map(([, listener]) => listener as EventListener);
}
const browserEvent = (type: string, target: EventTarget) =>
  ({ type, target, isTrusted: true, stopImmediatePropagation: vi.fn() }) as unknown as Event;

/** Undoes the ticker's one-loop wraps so the path can be checked for monotony. */
function unwrap(lefts: number[], period: number): number[] {
  let offset = 0;
  return lefts.map((left, i) => {
    if (i > 0) {
      const jump = left + offset - (lefts[i - 1] + offset);
      if (jump < -period / 2) offset += period;
      if (jump > period / 2) offset -= period;
    }
    return left + offset;
  });
}

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
  restoreTouch?.();
  restoreTouch = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe.each([
  ["ltr", "touch"],
  ["rtl", "touch"],
  ["ltr", "mouse"],
  ["rtl", "mouse"],
] as const)("repeat: smooth programmatic scroll (%s, %s)", (dir, pointer) => {
  const s = dir === "rtl" ? -1 : 1; // physical sign

  it("runs with the drag ticker on a mouse, without it on touch", () => {
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    expect(t.blossom.hasOverflow.x).toBe(pointer === "mouse");
  });

  it("scrollTo beyond the seam is animated by the ticker and lands one loop back", () => {
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition(350 * s);
    t.native.mockClear();

    t.scroller.scrollTo({ left: 450 * s, behavior: "smooth" });

    // nothing is handed to the browser, which would stop at the edge
    expect(t.native).not.toHaveBeenCalled();
    expect(t.pending()).toBe(1);

    t.settle();
    expect(t.pending()).toBe(0); // the ticker stopped
    const path = t.jumps().map((x) => x * s); // logical
    expect(path.length).toBeGreaterThan(5); // animated, not a jump
    for (const x of path) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(PERIOD);
    }
    // wrapped once, by exactly one period, and kept moving the same way
    const unwrapped = unwrap(path, PERIOD);
    expect(unwrapped.filter((x, i) => i && x !== path[i]).length).toBeGreaterThan(0);
    for (let i = 1; i < unwrapped.length; i++)
      expect(unwrapped[i]).toBeGreaterThanOrEqual(unwrapped[i - 1] - 1e-9);
    expect(unwrapped.at(-1)).toBe(450);
    expect(t.getScrollLeft()).toBe(50 * s);
  });

  it("scrollBy beyond the seam lands exactly where it was sent", () => {
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition(350 * s);
    t.native.mockClear();

    t.scroller.scrollBy({ left: 100 * s, behavior: "smooth" });

    expect(t.nativeBy).not.toHaveBeenCalled();
    t.settle();
    expect(t.getScrollLeft()).toBe(50 * s);
  });

  it("goes back across the seam too", () => {
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition(50 * s);
    t.native.mockClear();

    t.scroller.scrollBy({ left: -100 * s, behavior: "smooth" });
    t.settle();

    const unwrapped = unwrap(t.jumps().map((x) => x * s), PERIOD);
    for (let i = 1; i < unwrapped.length; i++)
      expect(unwrapped[i]).toBeLessThanOrEqual(unwrapped[i - 1] + 1e-9);
    expect(t.getScrollLeft()).toBe(350 * s);
  });

  it("follows the computed scroll-behavior for behavior: auto", () => {
    const t = setup({ dir, pointer, scrollBehavior: "smooth" });
    destroy = t.blossom.destroy;
    t.scrollToPosition(350 * s);
    t.native.mockClear();

    t.scroller.scrollTo({ left: 450 * s });
    expect(t.native).not.toHaveBeenCalled();
    t.settle();
    expect(t.getScrollLeft()).toBe(50 * s);
  });

  it("dispatches scrollend once it has landed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition(350 * s);
    vi.advanceTimersByTime(100);
    const ends = vi.fn();
    t.scroller.addEventListener("scrollend", ends);

    t.scroller.scrollTo({ left: 450 * s, behavior: "smooth" });
    t.frame();
    expect(ends).not.toHaveBeenCalled();
    t.settle();
    // like native snapping, once the scroll has rested a while
    expect(ends).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(ends).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(ends).toHaveBeenCalledTimes(1);
  });

  it("swallows the browser's own scrollend, not its own", () => {
    const listeners = captureListeners();
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    const ends = vi.fn();
    t.scroller.addEventListener("scrollend", ends);

    const event = browserEvent("scrollend", t.scroller);
    expect(listeners(t.scroller, "scrollend")).toHaveLength(1);
    for (const listener of listeners(t.scroller, "scrollend")) listener(event);
    expect(event.stopImmediatePropagation).toHaveBeenCalled();

    // a scroll container inside a slide keeps its own
    const inner = browserEvent("scrollend", t.scroller.firstElementChild!);
    for (const listener of listeners(t.scroller, "scrollend")) listener(inner);
    expect(inner.stopImmediatePropagation).not.toHaveBeenCalled();

    t.scroller.dispatchEvent(new Event("scrollend"));
    expect(ends).toHaveBeenCalledTimes(1);
  });
});

describe.each(["ltr", "rtl"] as const)("repeat: instant programmatic scroll (%s)", (dir) => {
  const s = dir === "rtl" ? -1 : 1;

  it.each([
    [450, 50],
    [-30, 370],
    [850, 50], // two loops on
    [200, 200], // in range: unchanged
    [401, 4], // within 4px of the seam: the edge of that band
    [399, END],
  ])("scrollTo(%d) jumps to %d inside the range", (left, expected) => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.scrollToPosition(200 * s);
    t.native.mockClear();

    t.scroller.scrollTo({ left: left * s, behavior: "instant" });

    expect(t.native).toHaveBeenCalledTimes(1);
    expect(t.native).toHaveBeenLastCalledWith({
      left: expected * s,
      behavior: "instant",
    });
    expect(t.pending()).toBe(0);
  });

  it("wraps the legacy (x, y) signature and scrollBy too", () => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.scrollToPosition(350 * s);
    t.native.mockClear();

    t.scroller.scrollTo(450 * s, 0);
    expect(t.native).toHaveBeenLastCalledWith({ left: 50 * s, behavior: "instant" });

    t.scrollToPosition(350 * s);
    t.scroller.scrollBy({ left: 100 * s, behavior: "instant" });
    expect(t.nativeBy).not.toHaveBeenCalled();
    expect(t.native).toHaveBeenLastCalledWith({ left: 50 * s, behavior: "instant" });
  });

  it("leaves a scroll without an inline position to the browser", () => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.native.mockClear();

    t.scroller.scrollTo({ top: 10, behavior: "smooth" });

    expect(t.native).toHaveBeenCalledWith({ top: 10, behavior: "smooth" });
    expect(t.pending()).toBe(0);
  });
});

describe("without repeat", () => {
  it("hands scrollTo to the browser untouched", () => {
    const t = setup({ repeat: false });
    destroy = t.blossom.destroy;
    t.native.mockClear();

    t.scroller.scrollTo({ left: 450, behavior: "smooth" });
    t.scroller.scrollTo({ left: -30, behavior: "instant" });

    expect(t.native.mock.calls.map(([o]) => o)).toEqual([
      { left: 450, behavior: "smooth" },
      { left: -30, behavior: "instant" },
    ]);
    expect(t.pending()).toBe(0);
  });

  it("hands scrollBy to the browser untouched", () => {
    const t = setup({ repeat: false });
    destroy = t.blossom.destroy;

    t.scroller.scrollBy({ left: 100, behavior: "smooth" });

    expect(t.nativeBy).toHaveBeenCalledWith({ left: 100, behavior: "smooth" });
    expect(t.pending()).toBe(0);
  });

  it("does not move the scroller on first measure", () => {
    const t = setup({ repeat: false });
    destroy = t.blossom.destroy;
    expect(t.start).toEqual([]);
  });
});

describe.each(["ltr", "rtl"] as const)("repeat: start position (%s)", (dir) => {
  const s = dir === "rtl" ? -1 : 1;

  it.each([
    // [scroll-snap-type, scroll-snap-align, logical start]
    ["none", "none", PAD_START], // first slide at the start edge
    ["x mandatory", "start", PAD_START],
    ["x mandatory", "center", PAD_START + SLIDE / 2 - CLIENT / 2], // 42
    // the end alignment lies before the start (-8): one loop on
    ["x mandatory", "end", PAD_START + SLIDE - CLIENT + PERIOD], // 392
  ])("snap %s / align %s starts at %d", (snapType, align, expected) => {
    const t = setup({ dir, snapType, align });
    destroy = t.blossom.destroy;

    expect(t.start).toEqual([{ left: expected * s, behavior: "instant" }]);
  });

  it("is placed once, not again on a later resize", () => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.scrollToPosition(200 * s);
    t.native.mockClear();

    t.resize();

    expect(t.native).not.toHaveBeenCalled();
  });
});

describe("repeat: next/prev methods", () => {
  it("next from the last slide goes on to the first, one loop on", () => {
    const t = setup();
    destroy = t.blossom.destroy;
    // slide 3 at the start edge
    t.scrollToPosition(PAD_START + 3 * SLIDE);

    t.blossom.next();
    t.settle();

    // slide 0 rests at 92 again, having gone forward through the seam
    expect(t.getScrollLeft()).toBe(PAD_START);
    const unwrapped = unwrap(t.jumps(), PERIOD);
    expect(unwrapped.at(-1)).toBe(PAD_START + PERIOD);
  });

  it("prev from the first slide goes back to the last one", () => {
    const t = setup();
    destroy = t.blossom.destroy;
    t.scrollToPosition(PAD_START);

    t.blossom.prev();
    t.settle();

    expect(t.getScrollLeft()).toBe(PAD_START + 3 * SLIDE);
    const unwrapped = unwrap(t.jumps(), PERIOD);
    expect(unwrapped.at(-1)).toBe(PAD_START + 3 * SLIDE - PERIOD);
  });
});

describe("repeat: snap target announcement", () => {
  it("announces the slide a smooth scroll is heading to, across the seam", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ snapType: "x mandatory", align: "start" });
    destroy = t.blossom.destroy;
    // slide 3 at the start edge, at rest
    t.scrollToPosition(PAD_START + 3 * SLIDE);
    vi.advanceTimersByTime(100);
    const changing = vi.fn();
    t.scroller.addEventListener("scrollsnapchanging", (e) =>
      changing((e as CustomEvent).detail.snapTargetInline),
    );

    // slide 0, one loop on
    t.scroller.scrollTo({ left: PAD_START + PERIOD, behavior: "smooth" });

    expect(changing).toHaveBeenCalledTimes(1);
    expect(changing).toHaveBeenCalledWith(t.slides[0]);
    t.settle();
    expect(t.getScrollLeft()).toBe(PAD_START);
  });

  it("announces a scroll it didn't run once it rests: changing, change, then scrollend", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ snapType: "x mandatory", align: "start" });
    destroy = t.blossom.destroy;
    const events: string[] = [];
    for (const type of ["scrollsnapchanging", "scrollsnapchange", "scrollend"])
      t.scroller.addEventListener(type, () => events.push(type));

    t.scrollToPosition(PAD_START + 2 * SLIDE);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(100);

    expect(events).toEqual(["scrollsnapchanging", "scrollsnapchange", "scrollend"]);
  });

  it("fires scrollend once per scroll, scrollsnapchange only when the target changed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ snapType: "x mandatory", align: "start" });
    destroy = t.blossom.destroy;
    const ends = vi.fn();
    const changes = vi.fn();
    t.scroller.addEventListener("scrollend", ends);
    t.scroller.addEventListener("scrollsnapchange", (e) =>
      changes((e as CustomEvent).detail.snapTargetInline),
    );
    const land = () => {
      t.settle();
      vi.advanceTimersByTime(100);
      t.settle();
      vi.advanceTimersByTime(100);
    };

    t.scroller.scrollTo({ left: PAD_START + SLIDE, behavior: "smooth" });
    land();
    expect(t.getScrollLeft()).toBe(PAD_START + SLIDE);
    expect(ends).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenLastCalledWith(t.slides[1]);

    // pushed off slide 1 and snapped back to it
    t.scrollToPosition(PAD_START + SLIDE + 30);
    land();
    expect(t.getScrollLeft()).toBe(PAD_START + SLIDE);
    expect(ends).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenCalledTimes(1);

    t.scroller.scrollTo({ left: PAD_START + 3 * SLIDE, behavior: "smooth" });
    land();
    expect(ends).toHaveBeenCalledTimes(3);
    expect(changes).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenLastCalledWith(t.slides[3]);
  });

  it("stays quiet when nothing moved", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ snapType: "x mandatory", align: "start" });
    destroy = t.blossom.destroy;
    const events = vi.fn();
    for (const type of ["scrollsnapchanging", "scrollsnapchange", "scrollend"])
      t.scroller.addEventListener(type, events);

    vi.advanceTimersByTime(1000);
    t.resize();
    vi.advanceTimersByTime(1000);

    expect(events).not.toHaveBeenCalled();
  });
});

describe("without repeat: events", () => {
  it("leaves the browser's own scrollend alone", () => {
    const listeners = captureListeners();
    const t = setup({ repeat: false, pointer: "mouse" });
    destroy = t.blossom.destroy;

    expect(listeners(t.scroller, "scrollend")).toEqual([]);
  });
});

describe("repeat: a touch takes over", () => {
  it("stops a programmatic scroll in flight where it is", () => {
    const t = setup({ pointer: "touch" });
    destroy = t.blossom.destroy;
    t.scrollToPosition(350);
    t.scroller.scrollTo({ left: 450, behavior: "smooth" });
    for (let i = 0; i < 5; i++) t.frame();
    const at = t.getScrollLeft();
    expect(at).toBeGreaterThan(350);

    t.scroller.dispatchEvent(new Event("touchstart"));

    expect(t.pending()).toBe(0);
    t.settle();
    expect(t.getScrollLeft()).toBe(at);
  });
});
