import { describe, expect, it } from "vitest";
import { defaultTransform, uuid } from "../src/app/core/contracts";
import {
  angleAt,
  bounds,
  centre,
  corners,
  fit,
  millimetresToPixels,
  previewBounds,
  resizeRotated,
  rotateBy,
  rotateHandle,
  youtubeGeometry,
} from "../src/app/shared/geometry";
describe("CSS geometry", () => {
  it("100/20/33 rotates around the centre of the block", () => {
    const t = {
      ...defaultTransform,
      x: 100,
      y: 20,
      width: 800,
      height: 450,
      rotation: 33,
    };
    // The centre is the fixed point: it is where it would be with no rotation at all.
    expect(centre(t)).toEqual({ x: 500, y: 245 });
    const p = corners(t);
    expect(p[0].x).toBeCloseTo(287.075556, 5);
    expect(p[0].y).toBeCloseTo(-161.556492, 5);
    expect(p[1].x).toBeCloseTo(958.01201, 5);
    expect(p[2].x).toBeCloseTo(712.924444, 5);
    // Opposite corners stay symmetric about the centre.
    expect((p[0].x + p[2].x) / 2).toBeCloseTo(500, 5);
    expect((p[0].y + p[2].y) / 2).toBeCloseTo(245, 5);
  });
  it("drags rotation around the centre and snaps with Shift", () => {
    const t = { ...defaultTransform, rotation: 10 };
    const o = centre(t);
    const start = angleAt(o.x, o.y, o.x + 100, o.y);
    const quarter = angleAt(o.x, o.y, o.x, o.y + 100);
    expect(rotateBy(t, start, quarter).rotation).toBeCloseTo(100, 6);
    expect(rotateBy(t, start, quarter, 15).rotation).toBeCloseTo(105, 6);
    // Dragging back past zero wraps instead of going negative.
    expect(rotateBy(t, quarter, start).rotation).toBeCloseTo(280, 6);
  });
  it("puts the rotation grip above the top edge, turning with the block", () => {
    const upright = rotateHandle({ ...defaultTransform, rotation: 0 }, 40);
    expect(upright.anchor).toEqual({ x: 320, y: 0 });
    expect(upright.grip.y).toBeCloseTo(-40, 6);
    const turned = rotateHandle({ ...defaultTransform, rotation: 90 }, 40);
    expect(turned.grip.x).toBeCloseTo(turned.anchor.x + 40, 6);
    expect(turned.grip.y).toBeCloseTo(turned.anchor.y, 6);
  });
  it("fits all transformed corners", () => {
    const t = fit(
      { ...defaultTransform, x: -50, y: 80, rotation: 33 },
      { cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 },
    );
    const b = bounds(t);
    expect(b.minX).toBeGreaterThanOrEqual(-0.001);
    expect(b.minY).toBeGreaterThanOrEqual(-0.001);
    expect(b.maxX).toBeLessThanOrEqual(1280.001);
    expect(b.maxY).toBeLessThanOrEqual(720.001);
  });
  it("inverts rotation and preview scale on resize", () => {
    const t = resizeRotated(
      { ...defaultTransform, rotation: 90 },
      0,
      50,
      0.5,
      false,
    );
    // Growing about the centre: the dragged corner moves by half of the size change.
    expect(t.width).toBeCloseTo(840);
    expect(t.height).toBeCloseTo(360);
    expect(centre(t)).toEqual(centre({ ...defaultTransform, rotation: 90 }));
  });
  it("locks aspect ratio", () => {
    const t = resizeRotated(defaultTransform, 50, 0, 0.5, true);
    expect(t.width / t.height).toBeCloseTo(640 / 360);
  });
  it("keeps the schematic on the screen until the block leaves it", () => {
    const v = { cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 };
    const inside = previewBounds({ ...defaultTransform, x: 100, y: 100 }, v);
    expect(inside.zoom).toBe(1);
    expect([inside.x, inside.y, inside.width, inside.height]).toEqual([
      0, 0, 1280, 720,
    ]);
  });
  it("zooms the schematic out so an overflowing block stays reachable", () => {
    const v = { cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 };
    const t = { ...defaultTransform, x: -600, y: -400, rotation: 33 };
    const box = previewBounds(t, v);
    const b = bounds(t);
    expect(box.zoom).toBeGreaterThan(1);
    // Both the whole screen and the whole rotated block fit inside the drawn area.
    expect(box.x).toBeLessThanOrEqual(Math.min(0, b.minX));
    expect(box.y).toBeLessThanOrEqual(Math.min(0, b.minY));
    expect(box.x + box.width).toBeGreaterThanOrEqual(Math.max(1280, b.maxX));
    expect(box.y + box.height).toBeGreaterThanOrEqual(Math.max(720, b.maxY));
    // The screen's proportions are preserved, so the schematic never distorts.
    expect(box.width / box.height).toBeCloseTo(1280 / 720, 6);
  });
  it("converts millimetres with the measured panel width, or 96 dpi without it", () => {
    const v = { cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 };
    // A 300 mm wide panel showing 1280 px: 225 mm covers three quarters of it.
    expect(millimetresToPixels(225, v, 300)).toBeCloseTo(960, 6);
    // Uncalibrated: the CSS convention of 96 pixels per inch.
    expect(millimetresToPixels(225, v, 0)).toBeCloseTo((225 * 96) / 25.4, 6);
    expect(millimetresToPixels(25.4, v, 0)).toBeCloseTo(96, 6);
  });
  it("keeps the alignment ring inside the schematic", () => {
    const v = { cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 };
    const t = { ...defaultTransform, x: 320, y: 180 };
    const ring = { minX: -200, minY: -150, maxX: 1500, maxY: 900 };
    const box = previewBounds(t, v, ring);
    expect(box.zoom).toBeGreaterThan(1);
    expect(box.x).toBeLessThanOrEqual(ring.minX);
    expect(box.y).toBeLessThanOrEqual(ring.minY);
    expect(box.x + box.width).toBeGreaterThanOrEqual(ring.maxX);
    expect(box.y + box.height).toBeGreaterThanOrEqual(ring.maxY);
  });
  it("checks only the YouTube frame itself, not where it sits", () => {
    expect(youtubeGeometry(defaultTransform, false)).toBeNull();
    expect(
      youtubeGeometry({ ...defaultTransform, rotation: 33 }, false),
    ).not.toBeNull();
    expect(
      youtubeGeometry({ ...defaultTransform, opacity: 0.5 }, false),
    ).not.toBeNull();
    expect(
      youtubeGeometry({ ...defaultTransform, width: 150 }, false),
    ).not.toBeNull();
  });
  it("lets a rotated YouTube frame hang off the edge of the screen", () => {
    // Far outside a 1280×720 screen, and rotated: both are allowed now.
    expect(
      youtubeGeometry(
        { ...defaultTransform, x: -400, y: -300, rotation: 33 },
        true,
      ),
    ).toBeNull();
  });
  it("generates UUID v7 on insecure LAN without randomUUID", () =>
    expect(uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ));
});
