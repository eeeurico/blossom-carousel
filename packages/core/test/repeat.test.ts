import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bramus/style-observer", () => ({
  default: class {
    observe() {}
    unobserve() {}
  },
  ReturnFormat: { OBJECT: "object" },
}));

import { Blossom } from "../src/index";

// jsdom has no layout: 4 slides of 100px in a 200px wide scroller, padded 50%
// on both sides while `has-repeat` is "true" (unpadded otherwise). While it
// loops the ::before pushes the slides by the inline --blossom-repeat-lead
// (500000 to start with) and the scroll range ends at the ::after, at
// --blossom-repeat-reach. HOME is that lead: the slides' natural positions
// start at HOME + PADDING, the natural loop.
const SLIDE = 100;
const COUNT = 4;
const CLIENT = 200;
const PADDING = CLIENT / 2;
const PERIOD = SLIDE * COUNT; // 400
const HOME = 500000;
const ROOM = 500000; // the room beyond the slides

type Observed = {
  callback: () => void;
  boxes: Map<Element, ResizeObserverOptions | undefined>;
};

function setup(
  direction: "ltr" | "rtl",
  repeat = true,
  /** runs on the scroller before Blossom() */
  before?: (scroller: HTMLElement) => void,
) {
  const observed: Observed = { callback: () => {}, boxes: new Map() };
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        observed.callback = callback;
      }
      observe(target: Element, options?: ResizeObserverOptions) {
        observed.boxes.set(target, options);
      }
      unobserve(target: Element) {
        observed.boxes.delete(target);
      }
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: true }));

  const scroller = document.createElement("div");
  const looped = () => scroller.getAttribute("has-repeat") === "true";
  const prop = (name: string) => parseFloat(scroller.style.getPropertyValue(name)) || 0;
  const pad = () => (looped() ? PADDING : 0);
  const lead = () => (looped() ? prop("--blossom-repeat-lead") : 0);
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        direction,
        position: "relative",
        scrollSnapType: "none",
        paddingInlineStart: `${pad()}px`,
        paddingInlineEnd: `${pad()}px`,
        scrollPaddingInlineStart: "0px",
        scrollPaddingInlineEnd: "0px",
        getPropertyValue: () => "auto",
      }) as unknown as CSSStyleDeclaration,
  );

  const slides = Array.from({ length: COUNT }, () => {
    const slide = document.createElement("div");
    Object.defineProperty(slide, "clientWidth", { value: SLIDE });
    scroller.append(slide);
    return slide;
  });
  document.body.append(scroller);

  // jsdom keeps scrollLeft as a plain value. Core puts an own accessor on the
  // scroller that forwards to Element.prototype's: the browser's moves go to
  // that one directly
  const native$ = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
  const getLeft = (): number => native$.get!.call(scroller);
  const setLeft = (value: number) => native$.set!.call(scroller, value);
  Object.defineProperty(scroller, "clientWidth", { value: CLIENT });
  Object.defineProperty(scroller, "scrollWidth", {
    get: () =>
      looped() && prop("--blossom-repeat-reach")
        ? prop("--blossom-repeat-reach") + 1
        : Math.max(CLIENT, 2 * pad() + PERIOD),
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, CLIENT, 100);
  slides.forEach((slide, i) => {
    slide.getBoundingClientRect = () => {
      const start = pad() + lead() + i * SLIDE; // logical, natural
      const logical = direction === "rtl" ? -getLeft() : getLeft();
      const tx = parseFloat(slide.style.translate) || 0;
      const x =
        direction === "rtl"
          ? CLIENT - (start - logical) - SLIDE + tx
          : start - logical + tx;
      return new DOMRect(x, 0, SLIDE, 100);
    };
  });
  // an instant jump moves the scroll, like the browser's own
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.behavior === "instant" && typeof options.left === "number")
      setLeft(options.left);
  });
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
  scroller.scrollBy = vi.fn() as unknown as typeof scroller.scrollBy;
  before?.(scroller);

  const blossom = Blossom(scroller, { repeat });
  blossom.init();
  observed.callback();
  scrollTo.mockClear();

  /** where the scroll sits: the start position, the first slide's start */
  const home = getLeft();
  const scrollToPosition = (left: number) => {
    setLeft(left);
    scroller.dispatchEvent(new Event("scroll"));
  };
  const translates = () => slides.map((slide) => slide.style.translate);
  const room = () => [
    scroller.style.getPropertyValue("--blossom-repeat-lead"),
    scroller.style.getPropertyValue("--blossom-repeat-reach"),
  ];

  return {
    blossom,
    observed,
    scroller,
    slides,
    scrollTo,
    scrollToPosition,
    translates,
    room,
    home,
    getLeft,
  };
}

describe("repeat", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    cleanup = undefined;
  });

  afterEach(() => {
    cleanup?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("observes the border box, the content box is 0 wide", () => {
    const { blossom, observed, scroller } = setup("ltr");
    cleanup = blossom.destroy;

    expect(observed.boxes.get(scroller)).toEqual({ box: "border-box" });
  });

  it("keeps observing the content box without repeat", () => {
    const { blossom, observed, scroller } = setup("ltr", false);
    cleanup = blossom.destroy;

    expect(observed.boxes.has(scroller)).toBe(true);
    expect(observed.boxes.get(scroller)).toBeUndefined();
  });

  it("observes every slide's border box", () => {
    const { blossom, observed, scroller } = setup("ltr");
    cleanup = blossom.destroy;

    for (const slide of Array.from(scroller.children))
      expect(observed.boxes.get(slide)).toEqual({ box: "border-box" });
  });

  it("leaves the slides unobserved without repeat", () => {
    const { blossom, observed, scroller } = setup("ltr", false);
    cleanup = blossom.destroy;

    for (const slide of Array.from(scroller.children))
      expect(observed.boxes.has(slide)).toBe(false);
  });

  it("observes slides added later, and stops observing removed ones", async () => {
    const { blossom, observed, scroller } = setup("ltr");
    cleanup = blossom.destroy;

    const added = document.createElement("div");
    scroller.append(added);
    const removed = scroller.firstElementChild!;
    removed.remove();
    await Promise.resolve(); // MutationObserver delivery

    expect(observed.boxes.get(added)).toEqual({ box: "border-box" });
    expect(observed.boxes.has(removed)).toBe(false);
  });

  it("leaves scrollLeft alone without repeat", () => {
    const { blossom, scroller } = setup("ltr", false);
    cleanup = blossom.destroy;

    expect(Object.prototype.hasOwnProperty.call(scroller, "scrollLeft")).toBe(false);
  });

  // SUSPECTED SOURCE CONCERN: init() builds its scrollLeft override from
  // Element.prototype's descriptor, not from what the scroller resolves
  // scrollLeft to, so an own accessor defined before init (a test double, a
  // polyfill, a framework) is bypassed while it runs, and destroy()'s
  // `delete scroller.scrollLeft` removes it for good. A non-configurable one
  // makes init() throw "Cannot redefine property: scrollLeft".
  it("keeps an own scrollLeft accessor defined before init", () => {
    const reads = vi.fn();
    const { blossom, scroller } = setup("ltr", true, (el) => {
      const native$ = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
      Object.defineProperty(el, "scrollLeft", {
        configurable: true,
        get() {
          reads();
          return native$.get!.call(el);
        },
        set(value: number) {
          native$.set!.call(el, value);
        },
      });
    });
    reads.mockClear();

    void scroller.scrollLeft;
    expect(reads).toHaveBeenCalled();
    blossom.destroy();
    expect(Object.prototype.hasOwnProperty.call(scroller, "scrollLeft")).toBe(true);
  });

  describe.each(["ltr", "rtl"] as const)("%s", (dir) => {
    const s = dir === "rtl" ? -1 : 1; // physical sign
    const at = (x: number) => (HOME + x) * s;
    const shifts = (translates: string[]) => translates.map((t) => (parseFloat(t) || 0) + 0);

    it("starts on the first slide in its natural position, with the lead and the reach", () => {
      const { blossom, home, room } = setup(dir);
      cleanup = blossom.destroy;

      expect(home).toBe(at(PADDING));
      // lead + period + the room beyond + a viewport
      expect(room()).toEqual([`${HOME}px`, `${HOME + PERIOD + ROOM + CLIENT}px`]);
    });

    it("leaves every slide untranslated with the viewport's middle in the natural loop", () => {
      const { blossom, scrollToPosition, translates } = setup(dir);
      cleanup = blossom.destroy;

      // the viewport's middle on the middle of the slides
      scrollToPosition(at(PADDING + PERIOD / 2 - CLIENT / 2));
      expect(shifts(translates())).toEqual([0, 0, 0, 0]);
    });

    it("shows every slide in the loop nearest the middle of the viewport, by whole periods", () => {
      const { blossom, scrollToPosition, translates } = setup(dir);
      cleanup = blossom.destroy;

      // the viewport's middle is 390 into the loop: slides 0 and 1 are
      // nearest a loop on
      scrollToPosition(at(390));
      expect(shifts(translates())).toEqual([PERIOD * s, PERIOD * s, 0, 0]);

      // 10 before the loop: slides 2 and 3 are nearest a loop back
      scrollToPosition(at(10));
      expect(shifts(translates())).toEqual([0, 0, -PERIOD * s, -PERIOD * s]);

      // two loops on, all of them
      scrollToPosition(at(PADDING + 2 * PERIOD + 100));
      expect(shifts(translates())).toEqual(Array(COUNT).fill(2 * PERIOD * s));
    });

    it("writes a slide's style only when its shift changes", () => {
      const { blossom, scrollToPosition, slides } = setup(dir);
      cleanup = blossom.destroy;
      const writes = vi.fn();
      for (const slide of slides) {
        let value = slide.style.translate;
        Object.defineProperty(slide.style, "translate", {
          get: () => value,
          set: (next: string) => {
            value = next;
            writes();
          },
        });
      }

      scrollToPosition(at(390));
      writes.mockClear();
      for (const x of [391, 392, 395, 399, 380]) scrollToPosition(at(x));
      expect(writes).not.toHaveBeenCalled();

      scrollToPosition(at(300)); // slide 1 is nearer where it is now
      expect(writes).toHaveBeenCalledTimes(1);
    });

    it("writes a slide's translate again once something wrote over it", async () => {
      const { blossom, scrollToPosition, slides, translates } = setup(dir);
      cleanup = blossom.destroy;
      scrollToPosition(at(390));
      const placed = translates();

      // a scroll in the same loop puts it back
      slides[0].style.translate = "";
      scrollToPosition(at(391));
      expect(translates()).toEqual(placed);

      // and so does a framework wiping the style attribute, before layout
      slides[0].setAttribute("style", "");
      await Promise.resolve(); // MutationObserver delivery
      expect(translates()).toEqual(placed);
    });

    it("gets its lead and reach back when a framework wipes the scroller's style", async () => {
      const { blossom, scroller, scrollToPosition, scrollTo, room } = setup(dir);
      cleanup = blossom.destroy;
      scrollToPosition(at(250));
      const kept = room();

      scroller.setAttribute("style", "");
      await Promise.resolve(); // MutationObserver delivery

      expect(room()).toEqual(kept);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("never scrolls the browser for a scroll in the middle of the range, across the join", () => {
      const { blossom, scrollToPosition, scrollTo } = setup(dir);
      cleanup = blossom.destroy;

      // the last slide to the first, where the old range ended
      for (let x = PADDING + PERIOD - 60; x <= PADDING + PERIOD + 60; x += 5) {
        scrollToPosition(at(x));
        scrollToPosition(at(x - PERIOD));
        scrollToPosition(at(x + PERIOD));
      }
      // and anywhere else short of a period from either end
      for (let x = PERIOD; x <= HOME + ROOM; x += 12345.6)
        scrollToPosition(x * s);
      scrollToPosition(PERIOD * s);
      scrollToPosition((HOME + ROOM) * s);

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("comes back from within a period of either end of the range, by whole loops", () => {
      const { blossom, scrollToPosition, scrollTo } = setup(dir);
      cleanup = blossom.destroy;

      // within a period of the start of the range
      scrollToPosition((PERIOD - 10) * s);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: at(PERIOD - 10), behavior: "instant" });

      // and of its end
      scrollToPosition((HOME + ROOM + 10) * s);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: at(10), behavior: "instant" });
      expect(scrollTo).toHaveBeenCalledTimes(2);
    });

    it("goes to the start position from a scroll position below 1", () => {
      const { blossom, scrollToPosition, scrollTo, home } = setup(dir);
      cleanup = blossom.destroy;
      scrollToPosition(at(250));

      // a carousel put back in the document starts again at 0
      scrollToPosition(0);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: home, behavior: "instant" });
      scrollToPosition(0.5 * s);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: home, behavior: "instant" });
    });

    it.each([
      // [scroll, how far into the loop the viewport starts]
      [PADDING + 150, 150], // slide 1 half way in
      [50, PERIOD - 50], // less than the padding into the range's loops
      [PADDING + 3 * PERIOD + 70, 70], // loops on
      [PADDING - 5 * PERIOD + 330, 330], // loops back
    ])("destroy from HOME + %i lands %i into the slides, in the normal range", (from, into) => {
      const { blossom, scroller, scrollTo, scrollToPosition, slides, room } = setup(dir);
      scrollToPosition(at(from));
      scrollTo.mockClear();

      blossom.destroy();

      // unpadded once it no longer loops
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: into * s, behavior: "instant" });
      expect(room()).toEqual(["", ""]);
      expect(scroller.hasAttribute("has-repeat")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(scroller, "scrollLeft")).toBe(false);
      for (const slide of slides) expect(slide.style.translate).toBe("");
    });

    it("keeps within the range as far as it is a period from either end", () => {
      const { blossom, scrollToPosition, scrollTo } = setup(dir);
      cleanup = blossom.destroy;

      scrollToPosition(PERIOD * s);
      scrollToPosition((HOME + ROOM) * s);

      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  describe("rtl", () => {
    it("does not wrap while scrolling between the edges", () => {
      const { blossom, scrollToPosition, scrollTo } = setup("rtl");
      cleanup = blossom.destroy;

      scrollToPosition(-(HOME + 200));

      expect(scrollTo).not.toHaveBeenCalled();
    });
  });

  it("measures with the slides back in place", () => {
    const { blossom, observed, scrollToPosition, scrollTo, room } = setup("ltr");
    cleanup = blossom.destroy;

    scrollToPosition(HOME + 390); // slides are now translated
    observed.callback(); // a resize or a DOM change measures again

    // the period is still the slides' own: the lead didn't move, and out of
    // room is a whole loop away
    expect(room()[0]).toBe(`${HOME}px`);
    scrollToPosition(HOME + ROOM + 2);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: HOME + 2, behavior: "instant" });
  });
});
