import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@bramus/style-observer", () => ({
  default: class {
    observe() {}
    unobserve() {}
  },
  ReturnFormat: { OBJECT: "object" },
}));

import { Blossom } from "../src/index";

// jsdom has no layout: 4 slides of 100px in a 200px wide scroller that is
// padded 100px on both sides, the way `has-repeat` pads it 50% + 50%.
const SLIDE = 100;
const COUNT = 4;
const CLIENT = 200;
const PADDING = CLIENT / 2;
const SCROLL = PADDING * 2 + SLIDE * COUNT; // 600
const PERIOD = SCROLL - CLIENT; // 400
const END = PERIOD - 4; // 396

type Observed = {
  callback: () => void;
  boxes: Map<Element, ResizeObserverOptions | undefined>;
};

function setup(direction: "ltr" | "rtl", repeat = true) {
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
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    () =>
      ({
        direction,
        scrollSnapType: "none",
        paddingInlineStart: `${PADDING}px`,
        paddingInlineEnd: `${PADDING}px`,
        scrollPaddingInlineStart: "0px",
        scrollPaddingInlineEnd: "0px",
        getPropertyValue: () => "auto",
      }) as unknown as CSSStyleDeclaration,
  );

  const scroller = document.createElement("div");
  const slides = Array.from({ length: COUNT }, () => {
    const slide = document.createElement("div");
    Object.defineProperty(slide, "clientWidth", { value: SLIDE });
    scroller.append(slide);
    return slide;
  });
  document.body.append(scroller);

  const translated = () => slides.some((slide) => slide.style.translate);
  Object.defineProperty(scroller, "clientWidth", { value: CLIENT });
  // like a browser, slides moved past the end make the scroller longer
  Object.defineProperty(scroller, "scrollWidth", {
    get: () => SCROLL + (translated() ? 116 : 0),
  });
  let scrollLeft = 0;
  Object.defineProperty(scroller, "scrollLeft", {
    get: () => scrollLeft,
    set: (value: number) => (scrollLeft = value),
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, CLIENT, 100);
  slides.forEach((slide, i) => {
    slide.getBoundingClientRect = () => {
      const start = PADDING + i * SLIDE; // logical, natural
      const logical = direction === "rtl" ? -scrollLeft : scrollLeft;
      const tx = parseFloat(slide.style.translate) || 0;
      const x =
        direction === "rtl"
          ? CLIENT - (start - logical) - SLIDE + tx
          : start - logical + tx;
      return new DOMRect(x, 0, SLIDE, 100);
    };
  });
  const scrollTo = vi.fn();
  scroller.scrollTo = scrollTo as unknown as typeof scroller.scrollTo;
  scroller.scrollBy = vi.fn() as unknown as typeof scroller.scrollBy;

  const blossom = Blossom(scroller, { repeat });
  blossom.init();
  observed.callback();
  scrollTo.mockClear();

  const scrollToPosition = (left: number) => {
    scrollLeft = left;
    scroller.dispatchEvent(new Event("scroll"));
  };
  const translates = () => slides.map((slide) => slide.style.translate);

  return { blossom, observed, scroller, scrollTo, scrollToPosition, translates };
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

  describe("ltr", () => {
    it("moves the first slide after the last one near the end", () => {
      const { blossom, scrollToPosition, translates, scrollTo } = setup("ltr");
      cleanup = blossom.destroy;

      scrollToPosition(390);

      expect(translates()).toEqual([`${PERIOD}px 0`, "0px 0", "0px 0", "0px 0"]);
      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("wraps past the end and before the start", () => {
      const { blossom, scrollToPosition, scrollTo } = setup("ltr");
      cleanup = blossom.destroy;

      scrollToPosition(END + 2);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: 4, behavior: "instant" });

      scrollToPosition(2);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: END, behavior: "instant" });
    });
  });

  describe("rtl", () => {
    it("does not wrap while scrolling between the edges", () => {
      const { blossom, scrollToPosition, scrollTo } = setup("rtl");
      cleanup = blossom.destroy;

      scrollToPosition(-200);

      expect(scrollTo).not.toHaveBeenCalled();
    });

    it("moves the first slide after the last one near the end", () => {
      const { blossom, scrollToPosition, translates } = setup("rtl");
      cleanup = blossom.destroy;

      scrollToPosition(-390);

      expect(translates()).toEqual([`${-PERIOD}px 0`, "0px 0", "0px 0", "0px 0"]);
    });

    it("moves the last slide before the first one near the start", () => {
      const { blossom, scrollToPosition, translates } = setup("rtl");
      cleanup = blossom.destroy;

      scrollToPosition(-10);

      expect(translates()).toEqual(["0px 0", "0px 0", "0px 0", `${PERIOD}px 0`]);
    });

    it("wraps past the end and before the start", () => {
      const { blossom, scrollToPosition, scrollTo } = setup("rtl");
      cleanup = blossom.destroy;

      scrollToPosition(-(END + 2));
      expect(scrollTo).toHaveBeenLastCalledWith({ left: -4, behavior: "instant" });

      scrollToPosition(-2);
      expect(scrollTo).toHaveBeenLastCalledWith({ left: -END, behavior: "instant" });
    });
  });

  it("measures with the slides back in place", () => {
    const { blossom, observed, scrollToPosition, scrollTo } = setup("ltr");
    cleanup = blossom.destroy;

    scrollToPosition(390); // slides are now translated
    observed.callback(); // a resize or a DOM change measures again

    scrollToPosition(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: END, behavior: "instant" });
  });
});
