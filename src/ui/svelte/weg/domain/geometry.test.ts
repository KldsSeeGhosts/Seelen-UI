import assert from "node:assert/strict";
import { test } from "node:test";
import type { Rect, SeelenWegSide } from "@seelen-ui/lib/types";
import { getDockOverlapRect, rectangleCovers, rectanglesIntersect } from "./geometry.ts";

function rect(left: number, top: number, right: number, bottom: number): Rect {
  return { left, top, right, bottom };
}

const bottomStrip = rect(0, 1008, 1920, 1080);
const bottomWebview = rect(0, 810, 1920, 1080);
const bottomDock = rect(760, 206, 1160, 262);

test("notifications beside a compact dock do not hide it, but intersecting controls do", () => {
  const footprint = getDockOverlapRect(bottomDock, bottomStrip, bottomWebview, "Bottom" as SeelenWegSide, 1);
  assert.deepEqual(footprint, rect(760, 1008, 1160, 1080));
  assert.ok(footprint);

  for (const notification of [rect(16, 980, 400, 1070), rect(1500, 980, 1904, 1070)]) {
    // The old full-edge check incorrectly treated both notifications as conflicts.
    assert.equal(rectanglesIntersect(bottomStrip, notification), true);
    assert.equal(rectanglesIntersect(footprint, notification), false);
  }
  assert.equal(rectanglesIntersect(footprint, rect(900, 980, 1300, 1070)), true);
  assert.equal(rectanglesIntersect(footprint, rect(1160, 980, 1500, 1070)), false);
});

test("top and bottom docks keep the same footprint while translated offscreen", () => {
  for (const position of ["Top", "Bottom"] as SeelenWegSide[]) {
    const strip = position === "Top" ? rect(0, 30, 1920, 102) : bottomStrip;
    const webview = position === "Top" ? rect(0, 30, 1920, 300) : bottomWebview;
    const visible = getDockOverlapRect(bottomDock, strip, webview, position, 1);
    for (const offset of [-100, 100]) {
      const hidden = { ...bottomDock, top: bottomDock.top + offset, bottom: bottomDock.bottom + offset };
      assert.deepEqual(getDockOverlapRect(hidden, strip, webview, position, 1), visible);
    }
  }
});

test("left and right docks ignore popups above and below their rendered length", () => {
  for (const position of ["Left", "Right"] as SeelenWegSide[]) {
    const strip = position === "Left" ? rect(0, 30, 72, 1080) : rect(1848, 30, 1920, 1080);
    const webview = position === "Left" ? rect(0, 30, 1440, 1080) : rect(480, 30, 1920, 1080);
    const bounds = rect(8, 300, 64, 700);
    const footprint = getDockOverlapRect(bounds, strip, webview, position, 1);
    assert.deepEqual(footprint, { ...strip, top: 330, bottom: 730 });
    assert.ok(footprint);
    assert.equal(rectanglesIntersect(footprint, { ...strip, top: 800 }), false);
    assert.equal(rectanglesIntersect(footprint, { ...strip, bottom: 200 }), false);
    assert.equal(rectanglesIntersect(footprint, { ...strip, top: 400, bottom: 600 }), true);
    const hidden = { ...bounds, left: bounds.left + 100, right: bounds.right + 100 };
    assert.deepEqual(getDockOverlapRect(hidden, strip, webview, position, 1), footprint);
  }
});

test("measurements respect fractional DPI and negative monitor coordinates", () => {
  assert.deepEqual(
    getDockOverlapRect(
      rect(100.2, 200, 400.2, 256),
      rect(-1920, -72, 0, 0),
      rect(-1920, -270, 0, 0),
      "Bottom" as SeelenWegSide,
      1.25,
    ),
    rect(-1795, -72, -1419, 0),
  );
  assert.deepEqual(
    getDockOverlapRect(
      rect(200, 100.2, 256, 400.2),
      rect(-72, -1080, 0, 0),
      rect(-1440, -1080, 0, 0),
      "Right" as SeelenWegSide,
      1.5,
    ),
    rect(-72, -930, 0, -479),
  );
});

test("full-width docks and overflowing themes stay within the configured strip", () => {
  for (const bounds of [rect(0, 206, 1920, 262), rect(-20, 206, 1940, 262)]) {
    assert.deepEqual(
      getDockOverlapRect(bounds, bottomStrip, bottomWebview, "Bottom" as SeelenWegSide, 1),
      bottomStrip,
    );
  }
});

test("changing the item count updates which nearby popups intersect", () => {
  const popup = rect(1200, 1000, 1500, 1080);
  for (const [bounds, expected] of [[bottomDock, false], [rect(600, 206, 1320, 262), true]] as const) {
    const footprint = getDockOverlapRect(bounds, bottomStrip, bottomWebview, "Bottom" as SeelenWegSide, 1);
    assert.ok(footprint);
    assert.equal(rectanglesIntersect(footprint, popup), expected);
  }
});

test("empty or clipped measurements do not fall back to the full screen edge", () => {
  for (const bounds of [rect(0, 0, 0, 0), rect(0, 0, 100, 0), rect(2000, 206, 2100, 262)]) {
    assert.equal(getDockOverlapRect(bounds, bottomStrip, bottomWebview, "Bottom" as SeelenWegSide, 1), null);
  }
});

test("fullscreen capture overlays still cover and intersect the dock", () => {
  const monitor = rect(0, 0, 1920, 1080);
  const capture = rect(2, 2, 1918, 1078);
  const footprint = getDockOverlapRect(bottomDock, bottomStrip, bottomWebview, "Bottom" as SeelenWegSide, 1);
  assert.ok(footprint);
  assert.equal(rectangleCovers(capture, monitor), true);
  assert.equal(rectanglesIntersect(footprint, capture), true);
  assert.equal(rectangleCovers(rect(1500, 980, 1904, 1070), monitor), false);
});
