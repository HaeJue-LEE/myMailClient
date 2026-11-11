import { describe, expect, it } from "vitest";
import { moveIndex, targetIndex } from "@/features/mail/components/use-drag-reorder";

describe("drag reorder", () => {
  // Four rows, 50px tall, one under the other.
  const rects = [0, 50, 100, 150].map((top) => ({ top, height: 50 }));

  it("stays put until its leading edge passes a neighbour's middle", () => {
    expect(targetIndex(rects, 1, 0)).toBe(1);
    expect(targetIndex(rects, 1, 24)).toBe(1);
    expect(targetIndex(rects, 1, -24)).toBe(1);
  });

  it("finds the slot it is dragged to, in either direction", () => {
    expect(targetIndex(rects, 1, 26)).toBe(2);
    expect(targetIndex(rects, 1, 76)).toBe(3);
    expect(targetIndex(rects, 2, -26)).toBe(1);
    expect(targetIndex(rects, 3, -140)).toBe(0);
  });

  it("moves an item to its new index", () => {
    expect(moveIndex(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveIndex(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moveIndex(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});
