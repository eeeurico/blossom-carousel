import { afterEach, describe, expect, it, vi } from "vitest";
import { clamp, lerp, project, resolveCSSLength, round } from "../src/utils";

describe("clamp", () => {
  it("returns the value when it is already in range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("limits values below and above the range", () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe("lerp", () => {
  it("returns the start and end values at the edges", () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
  });

  it("returns the midpoint at t = 0.5", () => {
    expect(lerp(10, 20, 0.5)).toBe(15);
  });
});

describe("round", () => {
  it("rounds to the requested precision", () => {
    expect(round(3.14159, 2)).toBe(3.14);
    expect(round(3.14159, 3)).toBe(3.142);
  });
});

describe("project", () => {
  it("projects the resting position from target, velocity, and friction", () => {
    expect(project(100, 50, 0.5)).toBe(200);
  });
});

describe("resolveCSSLength", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  it("returns pixel lengths as they are, without layout", () => {
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    expect(resolveCSSLength(document.body, "12px")).toBe(12);
    expect(resolveCSSLength(document.body, "auto")).toBe(0);
    expect(measure).not.toHaveBeenCalled();
  });

  it("resolves a percentage through layout against the parent's width", () => {
    const parent = document.createElement("div");
    Object.defineProperty(parent, "clientWidth", { value: 300 });
    let measured: { width: string; parent: string } | undefined;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        measured = {
          width: this.style.width,
          parent: (this.parentElement as HTMLElement).style.width,
        };
        return new DOMRect(0, 0, 150, 0);
      },
    );

    expect(resolveCSSLength(parent, "50%")).toBe(150); // not 50
    expect(measured).toEqual({ width: "50%", parent: "300px" });
  });
});
