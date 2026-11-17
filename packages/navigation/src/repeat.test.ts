import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommands, registerCommands } from "./commands";
import {
  getActiveMarkerIndex,
  getMarkerPositions,
  getMarkerTargets,
  selectRepeatActiveIndex,
} from "./markers";
import { canScroll, pageScroll } from "./scroll";
import { getSnapPositions, repeatPeriod, resolveScrollPadding } from "./snap";

// jsdom has no layout, so this lays a carousel out by hand: SLIDES slides of
// WIDTH px in a CLIENT px wide scroller. Under `has-repeat` core pads the
// scroller calc(50% - 8px) / calc(50% + 8px): one loop is then exactly the
// slides' length.
const CLIENT = 300;
const WIDTH = 100;
const SLIDES = 6;
const PAD_START = CLIENT / 2 - 8; // 142
const PAD_END = CLIENT / 2 + 8; // 158
const PERIOD = SLIDES * WIDTH; // 600

interface LayoutOptions {
  dir?: "ltr" | "rtl";
  repeat?: boolean;
  align?: "start" | "center" | "end";
  scrollPadding?: string;
  scrollLeft?: number;
}

/**
 * A scroller whose rects follow scrollLeft, and whose slides follow their own
 * `style.translate` the way the browser moves a translated element: the
 * natural (logical) start of slide i is PAD_START + i * WIDTH.
 */
function layout({
  dir = "ltr",
  repeat = true,
  align = "start",
  scrollPadding = "0px",
  scrollLeft = 0,
}: LayoutOptions = {}) {
  const rtl = dir === "rtl";
  const scroller = document.createElement("div");
  if (repeat) scroller.setAttribute("has-repeat", "true");

  let left = scrollLeft;
  Object.defineProperty(scroller, "scrollLeft", {
    get: () => left,
    set: (value: number) => (left = value),
  });
  Object.defineProperty(scroller, "clientWidth", { value: CLIENT });
  Object.defineProperty(scroller, "scrollWidth", {
    value: PAD_START + SLIDES * WIDTH + PAD_END,
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, CLIENT, 100);
  scroller.scrollTo = vi.fn() as unknown as typeof scroller.scrollTo;
  scroller.scrollBy = vi.fn() as unknown as typeof scroller.scrollBy;

  const translateX = (el: HTMLElement) =>
    parseFloat(el.style.translate) || 0;

  const slides = Array.from({ length: SLIDES }, (_, i) => {
    const slide = document.createElement("div");
    slide.setAttribute("data-blossom-slide", "");
    slide.scrollIntoView = vi.fn();
    Object.defineProperty(slide, "clientWidth", { value: WIDTH });
    slide.getBoundingClientRect = () => {
      const start = PAD_START + i * WIDTH; // logical, natural
      const logical = rtl ? -left : left;
      const x = rtl
        ? CLIENT - (start - logical) - WIDTH + translateX(slide)
        : start - logical + translateX(slide);
      return new DOMRect(x, 0, WIDTH, 100);
    };
    scroller.append(slide);
    return slide;
  });
  document.body.append(scroller);

  const style = (el: Element) => {
    if (el === scroller) {
      return {
        direction: dir,
        scrollPaddingInlineStart: scrollPadding,
        scrollPaddingInlineEnd: scrollPadding,
        paddingInlineStart: `${PAD_START}px`,
        paddingInlineEnd: `${PAD_END}px`,
        scrollSnapAlign: "none",
        scrollBehavior: "auto",
        translate: "none",
      };
    }
    const translate = (el as HTMLElement).style?.translate;
    return {
      direction: dir,
      scrollSnapAlign: (slides as HTMLElement[]).includes(el as HTMLElement)
        ? align
        : "none",
      scrollMarginInlineStart: "0px",
      scrollMarginInlineEnd: "0px",
      marginLeft: "0px",
      marginRight: "0px",
      translate: translate || "none",
    };
  };
  const getComputedStyle = ((el: Element) =>
    style(el)) as unknown as typeof window.getComputedStyle;
  vi.stubGlobal("getComputedStyle", getComputedStyle);
  vi.spyOn(window, "getComputedStyle").mockImplementation(getComputedStyle);

  const scrollTo = scroller.scrollTo as unknown as ReturnType<typeof vi.fn>;
  /** The `left` of the last scrollTo call. */
  const lastLeft = () => scrollTo.mock.lastCall?.[0]?.left as number;

  return { scroller, slides, scrollTo, lastLeft, setScrollLeft: (v: number) => (left = v) };
}

/** Physical scrollLeft for a logical position. */
const physical = (logical: number, dir: "ltr" | "rtl") =>
  dir === "rtl" ? -logical : logical;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("resolveScrollPadding", () => {
  it("resolves percentages against the scrollport", () => {
    expect(resolveScrollPadding("50%", 300)).toBe(150);
    expect(resolveScrollPadding(" 10% ", 300)).toBe(30);
  });

  it("keeps pixel lengths and treats auto as 0", () => {
    expect(resolveScrollPadding("12px", 300)).toBe(12);
    expect(resolveScrollPadding("auto", 300)).toBe(0);
  });
});

describe("percent scroll-padding", () => {
  // Without repeat too: the computed value of scroll-padding keeps the %.
  it("offsets snap positions by a share of clientWidth, not by the number", () => {
    const { scroller } = layout({ repeat: false, scrollPadding: "10%" });
    // slide 1 starts at 242; 10% of 300 = 30
    expect(getSnapPositions(scroller).map((p) => p.x)).toContain(212);
    expect(getSnapPositions(scroller).map((p) => p.x)).not.toContain(232);
  });

  it("offsets marker positions by a share of clientWidth", () => {
    const { scroller } = layout({ scrollPadding: "10%" });
    const positions = getMarkerPositions(scroller, getMarkerTargets(scroller));
    expect(positions).toEqual([112, 212, 312, 412, 512, 12]);
  });
});

describe("repeatPeriod", () => {
  it("is the natural length of one loop under repeat", () => {
    const { scroller, slides } = layout();
    expect(repeatPeriod(scroller)).toBe(PERIOD);

    // slides core moved to the far side do not stretch the loop
    slides[0].style.translate = `${PERIOD}px 0`;
    slides[1].style.translate = `${PERIOD}px 0`;
    expect(repeatPeriod(scroller)).toBe(PERIOD);
  });

  it("is 0 without the attribute", () => {
    const { scroller } = layout({ repeat: false });
    expect(repeatPeriod(scroller)).toBe(0);
  });
});

describe.each(["ltr", "rtl"] as const)("repeat geometry (%s)", (dir) => {
  it("takes snap positions modulo the loop", () => {
    const { scroller } = layout({ dir });
    expect(getSnapPositions(scroller).map((p) => p.x)).toEqual([
      42, 142, 242, 342, 442, 542,
    ]);
    // tree order: slide 5's start (642) lies one loop on, at 42
    expect(getSnapPositions(scroller)[0].el).toBe(scroller.children[5]);
  });

  it("measures slides in their natural place while core translates them", () => {
    const { scroller, slides, setScrollLeft } = layout({ dir });
    const natural = getMarkerPositions(scroller, slides);
    const naturalPages = getSnapPositions(scroller).map((p) => p.x);

    // near the end core moves the first two slides one loop on (to the
    // inline-end: right in LTR, left in RTL)
    setScrollLeft(physical(550, dir));
    const shift = dir === "rtl" ? -PERIOD : PERIOD;
    slides[0].style.translate = `${shift}px 0`;
    slides[1].style.translate = `${shift}px 0`;

    expect(getMarkerPositions(scroller, slides)).toEqual(natural);
    expect(getSnapPositions(scroller).map((p) => p.x)).toEqual(naturalPages);
  });

  it("aligns positions by each slide's snap-align", () => {
    const center = layout({ dir, align: "center" });
    // slide 0 centred: 142 + 50 - 150
    expect(getMarkerPositions(center.scroller, center.slides)[0]).toBe(42);
    document.body.replaceChildren();
    const end = layout({ dir, align: "end" });
    // slide 0 at the end: 242 - 300 = -58, one loop on: 542
    expect(getMarkerPositions(end.scroller, end.slides)[0]).toBe(542);
  });
});

describe.each(["ltr", "rtl"] as const)("repeat paging (%s)", (dir) => {
  it("next goes from the last slide to the first, beyond the seam", () => {
    // slide 4 rests at 542; the next one is slide 5, then slide 0
    const { scroller, lastLeft, setScrollLeft } = layout({
      dir,
      scrollLeft: physical(542, dir),
    });

    pageScroll(scroller, "next", "instant");
    expect(lastLeft()).toBe(physical(642, dir)); // slide 5 at 42, one loop on

    setScrollLeft(physical(42, dir));
    pageScroll(scroller, "next", "instant");
    expect(lastLeft()).toBe(physical(142, dir)); // slide 0
  });

  it("prev goes from the first slide back across the seam", () => {
    // slide 5 (the last) rests at 42; prev is slide 4 at 542, one loop back
    const { scroller, lastLeft } = layout({ dir, scrollLeft: physical(42, dir) });

    pageScroll(scroller, "prev", "instant");
    expect(lastLeft()).toBe(physical(-58, dir));
  });

  it("pages by the scrollport beyond the seam when nothing snaps", () => {
    const { scroller, slides, lastLeft } = layout({
      dir,
      scrollLeft: physical(550, dir),
    });
    for (const slide of slides) slide.removeAttribute("data-blossom-slide");
    const styles = window.getComputedStyle;
    vi.stubGlobal("getComputedStyle", (el: Element) => ({
      ...styles(el),
      scrollSnapAlign: "none",
    }));

    pageScroll(scroller, "next", "instant");
    expect(lastLeft()).toBe(physical(550 + CLIENT * 0.85, dir));
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });

  it("uses scrollTo with the requested behavior, never scrollIntoView", () => {
    const { scroller, slides, scrollTo } = layout({
      dir,
      scrollLeft: physical(142, dir),
    });

    pageScroll(scroller, "next", "smooth");

    expect(scrollTo).toHaveBeenCalledWith({
      left: physical(242, dir),
      behavior: "smooth",
    });
    for (const slide of slides) expect(slide.scrollIntoView).not.toHaveBeenCalled();
  });

  it("steps from the slide a smooth scroll is heading to on quick clicks", () => {
    const { scroller, lastLeft } = layout({ dir, scrollLeft: physical(542, dir) });

    pageScroll(scroller, "next", "smooth");
    expect(lastLeft()).toBe(physical(642, dir));
    // the scroller has not moved yet: the second click adds a step
    pageScroll(scroller, "next", "smooth");
    expect(lastLeft()).toBe(physical(742, dir));
  });

  it("steps from the current position once the user takes over", () => {
    const { scroller, lastLeft } = layout({ dir, scrollLeft: physical(542, dir) });

    pageScroll(scroller, "next", "smooth");
    scroller.dispatchEvent(new Event("pointerdown"));
    pageScroll(scroller, "next", "smooth");
    expect(lastLeft()).toBe(physical(642, dir));
  });
});

describe.each(["ltr", "rtl"] as const)("repeat goto (%s)", (dir) => {
  function goTo(scroller: HTMLElement, index: number) {
    const unregister = registerCommands(scroller);
    createCommands(() => scroller).goTo(index, { behavior: "instant" });
    unregister();
  }

  it("goes the short way round, across the seam", () => {
    // at slide 5 (42): slide 4 (542) is one slide back, not five on
    const { scroller, lastLeft } = layout({ dir, scrollLeft: physical(42, dir) });
    goTo(scroller, 4);
    expect(lastLeft()).toBe(physical(-58, dir));
  });

  it("goes forward when that is shorter", () => {
    // at slide 4 (542): slide 0 (142) is two slides on
    const { scroller, lastLeft } = layout({ dir, scrollLeft: physical(542, dir) });
    goTo(scroller, 0);
    expect(lastLeft()).toBe(physical(742, dir));
  });

  it("targets the natural position of a translated slide", () => {
    const { scroller, slides, lastLeft } = layout({
      dir,
      scrollLeft: physical(550, dir),
    });
    slides[0].style.translate = `${dir === "rtl" ? -PERIOD : PERIOD}px 0`;
    goTo(scroller, 0);
    // from 550 to 142 is 192 on (742), not 408 back
    expect(lastLeft()).toBe(physical(742, dir));
    expect(slides[0].scrollIntoView).not.toHaveBeenCalled();
  });
});

describe("repeat active index", () => {
  it("is the slide passed most recently going forward, around the loop", () => {
    const positions = [142, 242, 342, 442, 542, 42];
    expect(selectRepeatActiveIndex(positions, 142, PERIOD)).toBe(0);
    expect(selectRepeatActiveIndex(positions, 200, PERIOD)).toBe(0);
    expect(selectRepeatActiveIndex(positions, 590, PERIOD)).toBe(4);
    // past the seam, before slide 5's position: still slide 4
    expect(selectRepeatActiveIndex(positions, 10, PERIOD)).toBe(4);
    expect(selectRepeatActiveIndex(positions, 42, PERIOD)).toBe(5);
    // within 1px counts as arrived
    expect(selectRepeatActiveIndex(positions, 141.5, PERIOD)).toBe(0);
  });

  it.each(["ltr", "rtl"] as const)(
    "reads the active slide from the live scroller (%s)",
    (dir) => {
      const { scroller, slides, setScrollLeft } = layout({ dir });
      const active = (logical: number) => {
        setScrollLeft(physical(logical, dir));
        return getActiveMarkerIndex(scroller, slides);
      };
      expect(active(42)).toBe(5);
      expect(active(142)).toBe(0);
      expect(active(10)).toBe(4);
      expect(active(560)).toBe(4);
    },
  );
});

describe("canScroll", () => {
  it("is always true in both directions under repeat", () => {
    const { scroller, setScrollLeft } = layout();
    setScrollLeft(0);
    expect(canScroll(scroller, "prev")).toBe(true);
    setScrollLeft(PERIOD);
    expect(canScroll(scroller, "next")).toBe(true);
  });

  it("still stops at the edges without repeat", () => {
    const { scroller, setScrollLeft } = layout({ repeat: false });
    setScrollLeft(0);
    expect(canScroll(scroller, "prev")).toBe(false);
    expect(canScroll(scroller, "next")).toBe(true);
    setScrollLeft(PERIOD);
    expect(canScroll(scroller, "next")).toBe(false);
  });
});

describe("without has-repeat", () => {
  it("clamps snap positions to the scroll range and follows translates", () => {
    const { scroller, slides } = layout({ repeat: false, align: "end" });
    slides[2].style.translate = "40px 0";
    const xs = getSnapPositions(scroller).map((p) => p.x);
    // slide 0 at its end would be -58: clamped to 0; slide 2 moved by 40
    expect(xs[0]).toBe(0);
    expect(xs).toContain(142 + 3 * WIDTH - 300 + 40);
  });

  it("pages and goes to slides with scrollIntoView", () => {
    const { scroller, slides, scrollTo } = layout({ repeat: false, scrollLeft: 142 });
    pageScroll(scroller, "next", "smooth");
    expect(slides[1].scrollIntoView).toHaveBeenCalledWith(
      expect.objectContaining({ inline: "start", behavior: "smooth" }),
    );

    const unregister = registerCommands(scroller);
    createCommands(() => scroller).goTo(4);
    unregister();
    expect(slides[4].scrollIntoView).toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("has no previous snap at the start: does not scroll", () => {
    const { scroller, slides, scrollTo } = layout({ repeat: false, scrollLeft: 0 });
    pageScroll(scroller, "prev", "smooth");
    for (const slide of slides) expect(slide.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollBy).not.toHaveBeenCalled();
  });

  it("pages by the scrollport when nothing snaps", () => {
    const { scroller, scrollTo } = layout({ repeat: false, scrollLeft: 0 });
    vi.stubGlobal("getComputedStyle", () => ({
      direction: "ltr",
      scrollSnapAlign: "none",
      scrollPaddingInlineStart: "0px",
      scrollPaddingInlineEnd: "0px",
    }));
    pageScroll(scroller, "next", "smooth");
    expect(scrollTo).not.toHaveBeenCalled();
    expect(scroller.scrollBy).toHaveBeenCalledWith({
      left: CLIENT * 0.85,
      behavior: "smooth",
    });
  });

  it("is not set by has-repeat=false", () => {
    const { scroller } = layout({ repeat: false });
    scroller.setAttribute("has-repeat", "false");
    expect(repeatPeriod(scroller)).toBe(0);
    expect(canScroll(scroller, "prev")).toBe(false);
  });
});

describe("observeNavigationState with repeat", () => {
  function stubObservers() {
    const resizeBoxes: (ResizeObserverOptions | undefined)[] = [];
    const resizeTargets: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(target: Element, options?: ResizeObserverOptions) {
          resizeTargets.push(target);
          resizeBoxes.push(options);
        }
        disconnect() {}
      },
    );
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const runFrames = () => {
      for (const cb of frames.splice(0)) cb(0);
    };
    return { resizeBoxes, resizeTargets, runFrames };
  }

  it("observes the border box too: the padded content box is 0 wide", async () => {
    const { resizeBoxes, resizeTargets } = stubObservers();
    const { scroller } = layout();
    const { observeNavigationState } = await import("./observe");
    const stop = observeNavigationState(scroller, () => {});
    const boxes = resizeTargets
      .map((target, i) => [target, resizeBoxes[i]] as const)
      .filter(([target]) => target === scroller)
      .map(([, box]) => box);
    expect(boxes).toEqual([undefined, { box: "border-box" }]);
    stop();
  });

  it("observes the border box of every slide, and of slides added later", async () => {
    const { resizeBoxes, resizeTargets } = stubObservers();
    const { scroller } = layout();
    const { observeNavigationState } = await import("./observe");
    const stop = observeNavigationState(scroller, () => {});
    const boxOf = (el: Element) => resizeBoxes[resizeTargets.lastIndexOf(el)];
    for (const slide of Array.from(scroller.children))
      expect(boxOf(slide)).toEqual({ box: "border-box" });

    const added = document.createElement("div");
    scroller.append(added);
    await Promise.resolve(); // MutationObserver delivery
    expect(boxOf(added)).toEqual({ box: "border-box" });
    stop();
  });

  it("picks up core switching has-repeat on after it subscribed", async () => {
    const { runFrames } = stubObservers();
    const { scroller } = layout({ repeat: false, scrollLeft: 0 });
    const { observeNavigationState } = await import("./observe");
    const states: { canPrev: boolean; activeIndex: number }[] = [];
    const stop = observeNavigationState(scroller, (s) => states.push(s));

    runFrames();
    expect(states.at(-1)?.canPrev).toBe(false);

    scroller.setAttribute("has-repeat", "true");
    await Promise.resolve(); // MutationObserver delivery
    runFrames();
    expect(states.at(-1)?.canPrev).toBe(true);

    // the refreshed cache pages across the seam: prev from slide 5 at 42
    (scroller as unknown as { scrollLeft: number }).scrollLeft = 42;
    pageScroll(scroller, "prev", "instant");
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({
      left: -58,
      behavior: "instant",
    });
    stop();
  });
});
