import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@bramus/style-observer", () => ({
  default: class {
    observe() {}
    unobserve() {}
  },
  ReturnFormat: { OBJECT: "object" },
}));

import { Blossom } from "../src/index";

// jsdom has no layout: 4 slides of 100px in a 200px wide scroller, padded 50%
// on both sides the way `has-repeat` pads it. While it loops, the ::before
// pushes the slides LEAD (the inline --blossom-repeat-lead, 500000 to start
// with) into a scroll range that ends at the ::after, at --blossom-repeat-reach.
// HOME is that lead: HOME + PAD_START is where the slides naturally start.
const SLIDE = 100;
const COUNT = 4;
const CLIENT = 200;
const PAD_START = CLIENT / 2; // 100
const PERIOD = SLIDE * COUNT; // 400
const HOME = 500000;

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

  let slideWidth = SLIDE; // a test may change it: the loop is longer or shorter
  const scroller = document.createElement("div");
  const slides = Array.from({ length: COUNT }, () => {
    const slide = document.createElement("div");
    Object.defineProperty(slide, "clientWidth", { get: () => slideWidth });
    scroller.append(slide);
    return slide;
  });
  document.body.append(scroller);

  // jsdom keeps scrollLeft as a plain value. Core puts an own accessor on the
  // scroller that forwards to Element.prototype's: read and write that one
  // directly, the way the browser moves the scroll
  const native$ = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
  const getLeft = (): number => native$.get!.call(scroller);
  const setLeft = (value: number) => native$.set!.call(scroller, value);
  const looped = () => scroller.getAttribute("has-repeat") === "true";
  const prop = (name: string) => parseFloat(scroller.style.getPropertyValue(name)) || 0;
  const pad = () => (looped() ? PAD_START : 0);
  const lead = () => (looped() ? prop("--blossom-repeat-lead") : 0);
  Object.defineProperty(scroller, "clientWidth", { value: CLIENT });
  Object.defineProperty(scroller, "scrollWidth", {
    get: () =>
      looped() && prop("--blossom-repeat-reach")
        ? prop("--blossom-repeat-reach") + 1
        : Math.max(CLIENT, 2 * pad() + COUNT * slideWidth),
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, CLIENT, 100);
  slides.forEach((slide, i) => {
    slide.getBoundingClientRect = () => {
      const start = pad() + lead() + i * slideWidth; // logical, natural
      const logical = rtl ? -getLeft() : getLeft();
      const tx = parseFloat(slide.style.translate) || 0;
      const x = rtl
        ? CLIENT - (start - logical) - slideWidth + tx
        : start - logical + tx;
      return new DOMRect(x, 0, slideWidth, 100);
    };
  });

  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (el: Element) =>
      (el === scroller
        ? {
            direction: dir,
            position: "relative",
            scrollSnapType: snapType,
            scrollSnapAlign: "none",
            scrollBehavior,
            paddingInlineStart: `${pad()}px`,
            paddingInlineEnd: `${pad()}px`,
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
            marginLeft: "0px",
            marginRight: "0px",
          }) as unknown as CSSStyleDeclaration,
  );

  // the browser's own scrollTo/scrollBy: an instant jump, any other
  // behavior is only recorded
  const native = vi.fn((options: ScrollToOptions) => {
    if (options.behavior === "instant" && typeof options.left === "number")
      setLeft(options.left);
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
    setLeft(left);
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
    setSlideWidth: (width: number) => (slideWidth = width),
    scrollToPosition,
    jumps,
    getScrollLeft: getLeft,
    lead: () => prop("--blossom-repeat-lead"),
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

  it("scrollTo past a loop's end is animated by the ticker, straight through", () => {
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 350) * s);
    t.native.mockClear();

    t.scroller.scrollTo({ left: (HOME + 450) * s, behavior: "smooth" });

    // nothing is handed to the browser, which would stop at the edge
    expect(t.native).not.toHaveBeenCalled();
    expect(t.pending()).toBe(1);

    t.settle();
    expect(t.pending()).toBe(0); // the ticker stopped
    const path = t.jumps().map((x) => x * s); // logical
    expect(path.length).toBeGreaterThan(5); // animated, not a jump
    // no wrap on the way: it only ever moves on
    for (let i = 1; i < path.length; i++)
      expect(path[i]).toBeGreaterThanOrEqual(path[i - 1] - 1e-9);
    expect(path.at(-1)).toBe(HOME + 450);
    expect(t.getScrollLeft()).toBe((HOME + 450) * s);
  });

  it("scrollTo more than a loop away takes the short way round", () => {
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 50) * s);
    t.native.mockClear();

    // 900 on is two whole loops and 100
    t.scroller.scrollTo({ left: (HOME + 950) * s, behavior: "smooth" });
    t.settle();

    const path = t.jumps().map((x) => x * s);
    expect(Math.max(...path)).toBeLessThanOrEqual(HOME + 150);
    expect(t.getScrollLeft()).toBe((HOME + 150) * s);
  });

  it("scrollBy past a loop's end lands exactly where it was sent", () => {
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 350) * s);
    t.native.mockClear();

    t.scroller.scrollBy({ left: 100 * s, behavior: "smooth" });

    expect(t.nativeBy).not.toHaveBeenCalled();
    t.settle();
    expect(t.getScrollLeft()).toBe((HOME + 450) * s);
  });

  it("goes back a loop's end too", () => {
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 50) * s);
    t.native.mockClear();

    t.scroller.scrollBy({ left: -100 * s, behavior: "smooth" });
    t.settle();

    const path = t.jumps().map((x) => x * s);
    for (let i = 1; i < path.length; i++)
      expect(path[i]).toBeLessThanOrEqual(path[i - 1] + 1e-9);
    expect(t.getScrollLeft()).toBe((HOME - 50) * s);
  });

  it("follows the computed scroll-behavior for behavior: auto", () => {
    const t = setup({ dir, pointer, scrollBehavior: "smooth" });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 350) * s);
    t.native.mockClear();

    t.scroller.scrollTo({ left: (HOME + 450) * s });
    expect(t.native).not.toHaveBeenCalled();
    t.settle();
    expect(t.getScrollLeft()).toBe((HOME + 450) * s);
  });

  it("dispatches scrollend once it has landed", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ dir, pointer });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 350) * s);
    vi.advanceTimersByTime(100);
    const ends = vi.fn();
    t.scroller.addEventListener("scrollend", ends);

    t.scroller.scrollTo({ left: (HOME + 450) * s, behavior: "smooth" });
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
    [450, 450], // a loop's reach: as sent
    [-30, -30],
    [200, 200], // where it is
    [600, 600], // exactly a loop on
    [601, 201], // more than a loop on: on, once round at most
    [850, 450], // two loops and a bit on: still on, not the short way back
    [-850, -50], // and back
    // more than 125000px away is a position from outside the range's middle:
    // the short way round, to what it shows
    [-HOME, 0], // absolute 0
    [300 - HOME, 300], // a slide's offsetLeft
    [200 + 200000, 200], // whole loops on: nowhere
  ])("scrollTo(HOME + %d) jumps to HOME + %d", (left, expected) => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 200) * s);
    t.native.mockClear();

    t.scroller.scrollTo({ left: (HOME + left) * s, behavior: "instant" });

    expect(t.native).toHaveBeenCalledTimes(1);
    expect(t.native).toHaveBeenLastCalledWith({
      left: (HOME + expected) * s,
      behavior: "instant",
    });
    expect(t.pending()).toBe(0);
  });

  it("goes round the loop with the legacy (x, y) signature and scrollBy too", () => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 350) * s);
    t.native.mockClear();

    // 600 on: a loop and 200, on
    t.scroller.scrollTo((HOME + 950) * s, 0);
    expect(t.native).toHaveBeenLastCalledWith({
      left: (HOME + 550) * s,
      behavior: "instant",
    });
    t.scroller.scrollTo(0, 0); // far outside: the short way
    expect(t.native).toHaveBeenLastCalledWith({
      left: (HOME + 400) * s,
      behavior: "instant",
    });

    t.scrollToPosition((HOME + 350) * s);
    t.scroller.scrollBy({ left: 900 * s, behavior: "instant" });
    expect(t.nativeBy).not.toHaveBeenCalled();
    expect(t.native).toHaveBeenLastCalledWith({
      left: (HOME + 450) * s,
      behavior: "instant",
    });
  });

  it("takes scrollLeft = x as a scrollTo while looping", () => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 200) * s);
    t.native.mockClear();

    t.scroller.scrollLeft = 0; // far outside: the short way
    expect(t.native).toHaveBeenCalledTimes(1);
    expect(t.native).toHaveBeenLastCalledWith({ left: HOME * s, behavior: "instant" });
    expect(t.scroller.scrollLeft).toBe(HOME * s);
  });

  it("hands scrollLeft = x straight to the browser when not looping", () => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.setSlideWidth(40); // 160 is less than a viewport and a slide
    t.resize();
    t.frame();
    expect(t.scroller.getAttribute("has-repeat")).toBe("false");
    t.native.mockClear();

    t.scroller.scrollLeft = 30 * s;
    expect(t.native).not.toHaveBeenCalled();
    expect(t.getScrollLeft()).toBe(30 * s);

    t.blossom.destroy();
    destroy = undefined;
    expect(Object.prototype.hasOwnProperty.call(t.scroller, "scrollLeft")).toBe(false);
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
    ["x mandatory", "center", PAD_START + SLIDE / 2 - CLIENT / 2], // 50
    // the end alignment lies on the loop's start (0): in the middle of the range
    ["x mandatory", "end", PAD_START + SLIDE - CLIENT],
  ])("snap %s / align %s starts at HOME + %d", (snapType, align, expected) => {
    const t = setup({ dir, snapType, align });
    destroy = t.blossom.destroy;

    expect(t.start).toEqual([{ left: (HOME + expected) * s, behavior: "instant" }]);
  });

  it("is placed once, not again on a later resize", () => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 200) * s);
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
    t.scrollToPosition(HOME + PAD_START + 3 * SLIDE);

    t.blossom.next();
    t.settle();

    // slide 0 again, a loop on: no seam to go through
    expect(t.getScrollLeft()).toBe(HOME + PAD_START + PERIOD);
    for (const x of t.jumps()) expect(x).toBeGreaterThan(HOME + PAD_START + 3 * SLIDE - 1);
  });

  it("prev from the first slide goes back to the last one", () => {
    const t = setup();
    destroy = t.blossom.destroy;
    t.scrollToPosition(HOME + PAD_START);

    t.blossom.prev();
    t.settle();

    // slide 3, a loop back
    expect(t.getScrollLeft()).toBe(HOME + PAD_START + 3 * SLIDE - PERIOD);
    for (const x of t.jumps()) expect(x).toBeLessThan(HOME + PAD_START + 1);
  });
});

describe.each(["ltr", "rtl"] as const)("repeat: next/prev around home (%s)", (dir) => {
  const s = dir === "rtl" ? -1 : 1;
  const at = (x: number) => (HOME + PAD_START + x) * s;

  it.each([
    // [slide at the start edge, next, prev]
    [1, 2, 0],
    [0, 1, -1], // the last slide, a loop back
    [3, 4, 2], // the first slide, a loop on
    [-3, -2, -4], // a loop before the lead
    [9, 10, 8], // two loops on
  ])("from slide %i, next goes to %i and prev to %i", (from, forward, back) => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;

    t.scrollToPosition(at(from * SLIDE));
    t.blossom.next();
    t.settle();
    expect(t.getScrollLeft()).toBe(at(forward * SLIDE));

    t.scrollToPosition(at(from * SLIDE));
    t.blossom.prev();
    t.settle();
    expect(t.getScrollLeft()).toBe(at(back * SLIDE));
  });
});

describe.each(["ltr", "rtl"] as const)("repeat: rest (%s)", (dir) => {
  const s = dir === "rtl" ? -1 : 1;

  it("recentres at rest when far from the middle, without events of its own", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    const events: string[] = [];
    for (const type of ["scroll", "scrollend", "scrollsnapchange", "scrollsnapchanging"])
      t.scroller.addEventListener(type, () => events.push(type));

    // in the middle: a rest is left where it is
    t.scrollToPosition((HOME + 130) * s);
    vi.advanceTimersByTime(100);
    expect(t.jumps()).toEqual([]);
    const middle = events.filter((type) => type !== "scroll");
    events.length = 0;

    // a hundred thousand px away, still in the range: no jump while it moves
    t.scrollToPosition(100230 * s);
    expect(t.jumps()).toEqual([]);
    vi.advanceTimersByTime(100);

    expect(t.jumps()).toEqual([(HOME + 230) * s]);
    expect(t.getScrollLeft()).toBe((HOME + 230) * s);
    // announced once like any other rest: the move adds nothing to it
    expect(events.filter((type) => type !== "scroll")).toEqual(middle);
    vi.advanceTimersByTime(1000);
    expect(t.jumps()).toEqual([(HOME + 230) * s]);
  });

  it("takes a rest a loop on back to the natural loop, showing the same", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    const shown = () => t.slides.map((slide) => slide.getBoundingClientRect().left + 0);

    t.scrollToPosition((HOME + PAD_START + PERIOD + 50) * s);
    const before = shown();
    expect(t.jumps()).toEqual([]);
    vi.advanceTimersByTime(100);

    expect(t.jumps()).toEqual([(HOME + PAD_START + 50) * s]);
    expect(shown()).toEqual(before);
    expect(t.slides.map((slide) => parseFloat(slide.style.translate) + 0)).toEqual([0, 0, 0, 0]);
  });

  it("a rest back where it was, loops away, announces nothing", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    const ends = vi.fn();
    t.scroller.addEventListener("scrollend", ends);
    vi.advanceTimersByTime(100);

    t.scrollToPosition((100000 + PAD_START) * s); // whole loops from the start
    vi.advanceTimersByTime(1000);

    expect(t.getScrollLeft()).toBe((HOME + PAD_START) * s);
    expect(ends).not.toHaveBeenCalled();
  });
});

describe.each(["ltr", "rtl"] as const)("repeat: ticker out of room (%s)", (dir) => {
  const s = dir === "rtl" ? -1 : 1;

  it.each([
    ["on", 2 * HOME - 100, 300, HOME + 200],
    ["back", PERIOD + 100, -300, HOME + PERIOD - 200],
  ])("a glide %s past the end of the range carries on in the middle", (_, from, by, to) => {
    const t = setup({ dir, pointer: "mouse" });
    destroy = t.blossom.destroy;
    t.scrollToPosition(from * s);
    t.native.mockClear();

    t.scroller.scrollBy({ left: by * s, behavior: "smooth" });
    t.settle();

    const path = t.jumps().map((x) => x * s);
    expect(path.length).toBeGreaterThan(5);
    // it came back to the middle, and is there for good
    expect(path.some((x) => Math.abs(x - HOME) < PERIOD * 2)).toBe(true);
    expect(t.getScrollLeft()).toBe(to * s);
  });
});

describe.each(["ltr", "rtl"] as const)("repeat: resize anchor (%s)", (dir) => {
  const s = dir === "rtl" ? -1 : 1;
  /** how far x (logical) is past the natural start of slide i, round the loop */
  const into = (t: ReturnType<typeof setup>, x: number, i: number, width: number) => {
    const d = x - (t.lead() + PAD_START + i * width);
    return ((d % (COUNT * width)) + COUNT * width) % (COUNT * width);
  };

  it.each([0, 2, -3])(
    "keeps the content at the start edge by moving the lead, %i loops away, without scrolling",
    (loops) => {
      const t = setup({ dir });
      destroy = t.blossom.destroy;
      // 30 into the loop
      const from = HOME + loops * PERIOD + PAD_START + 30;
      t.scrollToPosition(from * s);
      t.native.mockClear();

      t.setSlideWidth(150); // a slide size change: the loop is 600 now
      t.resize();

      expect(t.native).not.toHaveBeenCalled();
      expect(t.getScrollLeft()).toBe(from * s);
      expect(into(t, from, 0, 150)).toBe(30);
      // a whole loop more or less shows the same: the lead stays near the middle
      expect(Math.abs(t.lead() - HOME)).toBeLessThanOrEqual(600 / 2);
      const reach = t.lead() + 600 + HOME + CLIENT;
      expect(t.scroller.style.getPropertyValue("--blossom-repeat-reach")).toBe(`${reach}px`);
    },
  );

  it.each([0, 2, -3])(
    "keeps the snap target where it was by moving the lead, %i loops away, without scrolling",
    (loops) => {
      const t = setup({ dir, snapType: "x mandatory", align: "start" });
      destroy = t.blossom.destroy;
      // 10 past slide 1 at the start edge
      const from = HOME + loops * PERIOD + PAD_START + SLIDE + 10;
      t.scrollToPosition(from * s);
      t.native.mockClear();

      t.setSlideWidth(150);
      t.resize();

      expect(t.native).not.toHaveBeenCalled();
      expect(t.getScrollLeft()).toBe(from * s);
      expect(into(t, from, 1, 150)).toBe(10);
    },
  );

  it("leaves lead and scroll alone when nothing changed", () => {
    const t = setup({ dir });
    destroy = t.blossom.destroy;
    t.scrollToPosition((HOME + 2 * PERIOD + 130) * s);
    t.native.mockClear();

    t.resize();

    expect(t.native).not.toHaveBeenCalled();
    expect(t.lead()).toBe(HOME);
  });
});

describe("repeat: snap target announcement", () => {
  it("announces the slide a smooth scroll is heading to, a loop on", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ snapType: "x mandatory", align: "start" });
    destroy = t.blossom.destroy;
    // slide 3 at the start edge, at rest: its middle is a loop on, so the rest
    // takes it back a loop, to the same content
    t.scrollToPosition(HOME + PAD_START + 3 * SLIDE);
    vi.advanceTimersByTime(100);
    const from = t.getScrollLeft();
    expect(from).toBe(HOME + PAD_START + 3 * SLIDE - PERIOD);
    const changing = vi.fn();
    t.scroller.addEventListener("scrollsnapchanging", (e) =>
      changing((e as CustomEvent).detail.snapTargetInline),
    );

    // slide 0, one slide on
    t.scroller.scrollTo({ left: from + SLIDE, behavior: "smooth" });

    expect(changing).toHaveBeenCalledTimes(1);
    expect(changing).toHaveBeenCalledWith(t.slides[0]);
    t.settle();
    expect(t.getScrollLeft()).toBe(from + SLIDE);
  });

  it("announces a scroll it didn't run once it rests: changing, change, then scrollend", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = setup({ snapType: "x mandatory", align: "start" });
    destroy = t.blossom.destroy;
    const events: string[] = [];
    for (const type of ["scrollsnapchanging", "scrollsnapchange", "scrollend"])
      t.scroller.addEventListener(type, () => events.push(type));

    t.scrollToPosition(HOME + PAD_START + 2 * SLIDE);
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

    t.scroller.scrollTo({ left: HOME + PAD_START + SLIDE, behavior: "smooth" });
    land();
    expect(t.getScrollLeft()).toBe(HOME + PAD_START + SLIDE);
    expect(ends).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(changes).toHaveBeenLastCalledWith(t.slides[1]);

    // pushed off slide 1 and snapped back to it
    t.scrollToPosition(HOME + PAD_START + SLIDE + 30);
    land();
    expect(t.getScrollLeft()).toBe(HOME + PAD_START + SLIDE);
    expect(ends).toHaveBeenCalledTimes(2);
    expect(changes).toHaveBeenCalledTimes(1);

    t.scroller.scrollTo({ left: HOME + PAD_START + 3 * SLIDE, behavior: "smooth" });
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
    t.scrollToPosition(HOME + 350);
    t.scroller.scrollTo({ left: HOME + 450, behavior: "smooth" });
    for (let i = 0; i < 5; i++) t.frame();
    const at = t.getScrollLeft();
    expect(at).toBeGreaterThan(HOME + 350);

    t.scroller.dispatchEvent(new Event("touchstart"));

    expect(t.pending()).toBe(0);
    t.settle();
    expect(t.getScrollLeft()).toBe(at);
  });
});
