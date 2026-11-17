import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@bramus/style-observer", () => ({
  default: class {
    observe() {}
    unobserve() {}
  },
  ReturnFormat: { OBJECT: "object" },
}));

import { Blossom } from "../src/index";

// jsdom has no layout: slides of 100px in a scroller padded 50% on both sides
// while it loops (or while core measures whether it can), laid out with an
// optional flex gap. While it loops the ::before pushes the slides by the
// inline --blossom-repeat-lead (500000 to start with), and the scroll range
// ends at the ::after, at --blossom-repeat-reach.
const SLIDE = 100;
const HOME = 500000;
/** where a scroll out of room at x comes back to: whole loops on, to the
 *  natural loop (the one whose slides start at the lead) */
const homed = (x: number, period: number) => x - period * Math.floor((x - HOME) / period);

interface Options {
  count?: number;
  client?: number;
  display?: string;
  gap?: number;
  /** false: a fixed grid track, the last slide's margin doesn't grow the range */
  gapGrows?: boolean;
  /** inline margin-inline-end of the last slide */
  lastMargin?: string;
  /** false: an author grid template, the ::before doesn't push the slides */
  leadPushes?: boolean;
  /** the scroller's computed position, as an author rule has it */
  position?: string;
}

function setup({
  count = 2,
  client = 200,
  display = "block",
  gap = 0,
  gapGrows = true,
  lastMargin = "",
  leadPushes = true,
  position = "relative",
}: Options = {}) {
  let width = client;
  let resize: (entries?: { target: Element }[]) => void = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: typeof resize) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  let frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frames = [];
  });
  const frame = () => {
    const queued = frames;
    frames = [];
    for (const cb of queued) cb(0);
  };

  const scroller = document.createElement("div");
  const padded = () =>
    scroller.getAttribute("has-repeat") === "true" ||
    !!scroller.style.getPropertyValue("padding-inline") ||
    !!scroller.style.getPropertyValue("padding-inline-start");
  const pad = () => (padded() ? width / 2 : 0);
  const slides = () => Array.from(scroller.children) as HTMLElement[];
  const margin = (el: HTMLElement) => parseFloat(el.style.marginInlineEnd) || 0;

  // jsdom keeps scrollLeft as a plain value; core forwards its own accessor
  // to Element.prototype's, which moves the scroll the way the browser does
  const native$ = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
  const getLeft = (): number => native$.get!.call(scroller);
  const setLeft = (value: number) => native$.set!.call(scroller, value);
  const looped = () => scroller.getAttribute("has-repeat") === "true";
  const prop = (name: string) => parseFloat(scroller.style.getPropertyValue(name)) || 0;
  const lead = () => (looped() && leadPushes ? prop("--blossom-repeat-lead") : 0);

  Object.defineProperty(scroller, "clientWidth", { get: () => width });
  Object.defineProperty(scroller, "scrollWidth", {
    get: () => {
      if (looped() && prop("--blossom-repeat-reach")) return prop("--blossom-repeat-reach") + 1;
      const all = slides();
      const last = all.at(-1);
      const content =
        all.length * SLIDE +
        Math.max(all.length - 1, 0) * gap +
        (gapGrows && last ? margin(last) : 0);
      return Math.max(pad() * 2 + content, width);
    },
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, width, 100);

  const addSlide = () => {
    const slide = document.createElement("div");
    Object.defineProperty(slide, "clientWidth", { value: SLIDE });
    slide.getBoundingClientRect = () => {
      const i = slides().indexOf(slide);
      const tx = parseFloat(slide.style.translate) || 0;
      // a fixed grid track squeezes the last slide by the margin lent to it
      const squeezed = !gapGrows && slide === slides().at(-1) ? margin(slide) : 0;
      return new DOMRect(
        pad() + lead() + i * (SLIDE + gap) - getLeft() + tx,
        0,
        SLIDE - squeezed,
        100,
      );
    };
    scroller.append(slide);
    return slide;
  };
  for (let i = 0; i < count; i++) addSlide();
  if (lastMargin) slides().at(-1)!.style.marginInlineEnd = lastMargin;
  document.body.append(scroller);

  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (el: Element) =>
      (el === scroller
        ? {
            direction: "ltr",
            display,
            columnGap: `${gap}px`,
            scrollSnapType: "none",
            scrollBehavior: "auto",
            paddingInlineStart: `${pad()}px`,
            paddingInlineEnd: `${pad()}px`,
            scrollPaddingInlineStart: "0px",
            scrollPaddingInlineEnd: "0px",
            borderInlineStartWidth: "0px",
            position: scroller.style.position || position,
            getPropertyValue: () => "auto",
          }
        : {
            direction: "ltr",
            scrollSnapAlign: "none",
            marginInlineEnd: (el as HTMLElement).style?.marginInlineEnd || "0px",
            marginLeft: "0px",
            marginRight: (el as HTMLElement).style?.marginInlineEnd || "0px",
            position: "static",
          }) as unknown as CSSStyleDeclaration,
  );

  const native = vi.fn((options: ScrollToOptions) => {
    if (options.behavior === "instant" && typeof options.left === "number")
      setLeft(options.left);
  });
  scroller.scrollTo = ((options: ScrollToOptions) => native(options)) as typeof scroller.scrollTo;
  scroller.scrollBy = vi.fn() as unknown as typeof scroller.scrollBy;

  const blossom = Blossom(scroller, { repeat: true });
  blossom.init();
  resize([{ target: scroller }]);
  frame();
  native.mockClear();

  return {
    blossom,
    scroller,
    slides,
    addSlide,
    native,
    frame,
    /** the scroller's width changes, as its ResizeObserver hears of it */
    resizeTo: (next: number) => {
      width = next;
      resize([{ target: scroller }]);
    },
    scrollToPosition: (left: number) => {
      setLeft(left);
      scroller.dispatchEvent(new Event("scroll"));
    },
    translates: () => slides().map((slide) => slide.style.translate),
    looping: () => scroller.getAttribute("has-repeat"),
    getScrollLeft: getLeft,
    room: () => [
      scroller.style.getPropertyValue("--blossom-repeat-lead"),
      scroller.style.getPropertyValue("--blossom-repeat-reach"),
    ],
  };
}

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("repeat guard", () => {
  it("doesn't loop when the slides are shorter than a viewport plus a slide", () => {
    const t = setup({ count: 2, client: 200 });
    destroy = t.blossom.destroy;

    expect(t.looping()).toBe("false");

    t.scrollToPosition(2);
    t.scrollToPosition(98);
    expect(t.translates()).toEqual(["", ""]);
    expect(t.native).not.toHaveBeenCalled();

    t.scroller.scrollTo({ left: 450, behavior: "smooth" });
    expect(t.native).toHaveBeenCalledExactlyOnceWith({ left: 450, behavior: "smooth" });
  });

  it("loops from exactly a viewport plus the widest slide", () => {
    const t = setup({ count: 3, client: 200 });
    destroy = t.blossom.destroy;

    expect(t.looping()).toBe("true");
    // period 300: out of room is a whole number of loops away
    t.scrollToPosition(2);
    expect(t.native).toHaveBeenLastCalledWith({
      left: homed(2, 300),
      behavior: "instant",
    });
  });

  it("starts looping a frame after a resize makes it fit", () => {
    const t = setup({ count: 2, client: 200 });
    destroy = t.blossom.destroy;

    t.resizeTo(100);
    expect(t.looping()).toBe("false");
    t.frame();
    expect(t.looping()).toBe("true");

    // period 2 * 100 = 200
    t.native.mockClear();
    t.scrollToPosition(2);
    expect(t.native).toHaveBeenLastCalledWith({
      left: homed(2, 200),
      behavior: "instant",
    });
  });

  it("stops looping a frame after a resize leaves it too short", () => {
    const t = setup({ count: 3, client: 200 });
    destroy = t.blossom.destroy;
    t.scrollToPosition(50);

    t.resizeTo(300);
    expect(t.looping()).toBe("true");
    t.frame();
    expect(t.looping()).toBe("false");
    expect(t.translates().every((x) => x === "" || x === "0px 0")).toBe(true);

    t.native.mockClear();
    t.scroller.scrollTo({ left: 450, behavior: "smooth" });
    expect(t.native).toHaveBeenCalledExactlyOnceWith({ left: 450, behavior: "smooth" });
  });

  it("starts looping right away once a slide added makes it fit", async () => {
    const t = setup({ count: 2, client: 200 });
    destroy = t.blossom.destroy;

    t.addSlide();
    await Promise.resolve(); // MutationObserver delivery

    expect(t.looping()).toBe("true");
  });

  it("leaves nothing behind on destroy", () => {
    const t = setup({ count: 2, client: 200 });
    t.blossom.destroy();

    expect(t.scroller.hasAttribute("has-repeat")).toBe(false);
    expect(t.scroller.style.getPropertyValue("padding-inline-start")).toBe("");
    expect(t.scroller.style.getPropertyValue("--blossom-repeat-reach")).toBe("");
  });

  it("sets the lead and the reach while looping, and drops them on destroy", () => {
    const t = setup({ count: 3, client: 200 });

    // lead + period + the room beyond + a viewport
    expect(t.room()).toEqual([`${HOME}px`, `${HOME + 300 + HOME + 200}px`]);
    expect(t.scroller.style.position).toBe("");

    t.blossom.destroy();
    expect(t.room()).toEqual(["", ""]);
  });

  it("drops the lead and the reach when it stops looping", () => {
    const t = setup({ count: 3, client: 200 });
    destroy = t.blossom.destroy;

    t.resizeTo(300);
    t.frame();
    expect(t.looping()).toBe("false");
    expect(t.room()).toEqual(["", ""]);
  });

  it("positions a static scroller for the ::after, and only then", () => {
    const t = setup({ count: 3, client: 200, position: "static" });

    expect(t.looping()).toBe("true");
    expect(t.scroller.style.position).toBe("relative");

    t.blossom.destroy();
    expect(t.scroller.style.position).toBe("");
  });

  it("refuses to loop when the ::before doesn't push the slides (an author grid template)", () => {
    const t = setup({ count: 3, client: 200, leadPushes: false });
    destroy = t.blossom.destroy;

    expect(t.looping()).toBe("false");
    expect(t.room()).toEqual(["", ""]);
    t.scrollToPosition(2);
    expect(t.translates()).toEqual(["", "", ""]);
    expect(t.native).not.toHaveBeenCalled();
    t.scroller.scrollTo({ left: 450, behavior: "smooth" });
    expect(t.native).toHaveBeenCalledExactlyOnceWith({ left: 450, behavior: "smooth" });
  });

  it("starting to loop after a scroll unlooped jumps to the same content", () => {
    const t = setup({ count: 2, client: 200 });
    destroy = t.blossom.destroy;
    t.scrollToPosition(30); // 30 into the first slide, unlooped and unpadded

    t.resizeTo(100);
    t.frame();
    expect(t.looping()).toBe("true");

    // the first slide starts at the padding (50) and the lead: 30 into it
    expect(t.native).toHaveBeenCalledExactlyOnceWith({
      left: HOME + 50 + 30,
      behavior: "instant",
    });
  });

  it("starting to loop unscrolled goes to the start position", () => {
    const t = setup({ count: 2, client: 200 });
    destroy = t.blossom.destroy;

    t.resizeTo(100);
    t.frame();

    expect(t.native).toHaveBeenCalledExactlyOnceWith({
      left: HOME + 50,
      behavior: "instant",
    });
  });
});

describe("repeat seam gap", () => {
  it("lends the gap to the last slide's end margin while looping", () => {
    const t = setup({ count: 4, display: "flex", gap: 10 });
    destroy = t.blossom.destroy;

    expect(t.looping()).toBe("true");
    expect(t.slides().map((slide) => slide.style.marginInlineEnd)).toEqual([
      "",
      "",
      "",
      "10px",
    ]);
    // one gap per slide: the loop is 4 * 110 long
    t.scrollToPosition(2);
    expect(t.native).toHaveBeenLastCalledWith({
      left: homed(2, 440),
      behavior: "instant",
    });
  });

  it("restores the margin on destroy", () => {
    const t = setup({ count: 4, display: "flex", gap: 10, lastMargin: "2px" });
    const last = t.slides().at(-1)!;
    expect(last.style.marginInlineEnd).toBe("12px");

    t.blossom.destroy();
    expect(last.style.marginInlineEnd).toBe("2px");
  });

  it("gives the gap back when the margin doesn't grow the range", () => {
    const t = setup({ count: 4, display: "grid", gap: 10, gapGrows: false });
    destroy = t.blossom.destroy;

    expect(t.looping()).toBe("true");
    expect(t.slides().at(-1)!.style.marginInlineEnd).toBe("");
  });

  it("lends nothing without a flex or grid gap", () => {
    const t = setup({ count: 4, display: "block", gap: 10 });
    destroy = t.blossom.destroy;

    expect(t.slides().at(-1)!.style.marginInlineEnd).toBe("");
  });

  it("lends nothing while not looping", () => {
    const t = setup({ count: 2, display: "flex", gap: 10 });
    destroy = t.blossom.destroy;

    expect(t.looping()).toBe("false");
    expect(t.slides().at(-1)!.style.marginInlineEnd).toBe("");
  });
});
