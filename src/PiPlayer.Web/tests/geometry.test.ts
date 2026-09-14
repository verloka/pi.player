import { describe, expect, it } from "vitest";
import {
  defaultCircle,
  defaultTransform,
  uuid,
} from "../src/app/core/contracts";
import {
  angleAt,
  bounds,
  centre,
  centreOffset,
  circleBounds,
  corners,
  fit,
  maxScale,
  placeCentre,
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
  it("measures slider positions from the centre of the screen", () => {
    const v = { cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 };
    const t = { ...defaultTransform, scale: 2, rotation: 45 };
    const middle = placeCentre(t, v, 0, 0);
    expect(centreOffset(middle, v)).toEqual({ x: 0, y: 0 });
    // Only where the block sits changes, never its own size or angle.
    expect([
      middle.width,
      middle.height,
      middle.scale,
      middle.rotation,
    ]).toEqual([640, 360, 2, 45]);
    expect(centreOffset(placeCentre(middle, v, -100, 50), v)).toEqual({
      x: -100,
      y: 50,
    });
  });
  it("grows and turns the video about its centre, so size and rotation never shift it", () => {
    const v = { cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 };
    const t = placeCentre(defaultTransform, v, 120, -40);
    for (const next of [
      { ...t, scale: 2.5 },
      { ...t, rotation: 90 },
    ]) {
      const b = bounds(next);
      expect((b.minX + b.maxX) / 2).toBeCloseTo(760, 6);
      expect((b.minY + b.maxY) / 2).toBeCloseTo(320, 6);
    }
  });
  it("caps the size slider at the backend's rendering limits", () => {
    expect(maxScale(defaultTransform)).toBeCloseTo(6, 6);
    expect(
      maxScale({ ...defaultTransform, width: 1920, height: 1080 }),
    ).toBeCloseTo(2, 6);
  });
  it("places the circle from the screen centre and keeps it inside the schematic", () => {
    const v = { cssWidth: 1280, cssHeight: 720, devicePixelRatio: 1 };
    const middle = circleBounds(defaultCircle, v);
    expect([middle.cx, middle.cy, middle.radius]).toEqual([640, 360, 200]);
    const t = { ...defaultTransform, x: 320, y: 180 };
    const ring = circleBounds(
      { ...defaultCircle, x: 300, y: -200, diameter: 1200 },
      v,
    );
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
