import { Circle, Transform, Viewport } from "../core/contracts";

// The layer rotates and scales around its own centre: x/y still address the unrotated box's top-left,
// and the centre sits at (x + width/2, y + height/2). CSS does the same with transform-origin: 50% 50%.
export function centre(t: Transform): { x: number; y: number } {
  return { x: t.x + t.width / 2, y: t.y + t.height / 2 };
}
export function corners(t: Transform): { x: number; y: number }[] {
  const a = (t.rotation * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a),
    o = centre(t);
  return [
    [0, 0],
    [t.width, 0],
    [t.width, t.height],
    [0, t.height],
  ].map(([u, v]) => {
    const dx = u - t.width / 2,
      dy = v - t.height / 2;
    return {
      x: o.x + t.scale * (dx * c - dy * s),
      y: o.y + t.scale * (dx * s + dy * c),
    };
  });
}
export function bounds(t: Transform) {
  const p = corners(t);
  return {
    minX: Math.min(...p.map((p) => p.x)),
    minY: Math.min(...p.map((p) => p.y)),
    maxX: Math.max(...p.map((p) => p.x)),
    maxY: Math.max(...p.map((p) => p.y)),
  };
}
/** The largest scale the backend accepts for this box: 4096 px a side and 8 294 400 px of area. */
export function maxScale(t: Transform): number {
  return Math.min(
    4096 / t.width,
    4096 / t.height,
    Math.sqrt(8294400 / (t.width * t.height)),
    8,
  );
}
export function fit(t: Transform, v: Viewport): Transform {
  const b = bounds({ ...t, x: 0, y: 0, scale: 1 });
  const scale = Math.min(
    v.cssWidth / (b.maxX - b.minX),
    v.cssHeight / (b.maxY - b.minY),
    maxScale(t),
  );
  // Scaling happens about the centre, so centring the box centres the rotated shape with it.
  return { ...t, scale, ...centred(t, v) };
}
/**
 * The area the control panel draws. It is the screen itself while the block stays inside it, and zooms
 * out to hold the whole rotated block plus a margin as soon as the block hangs over an edge, so the
 * drag, resize and rotate grips never end up outside the picture. The screen's aspect ratio is kept.
 */
export function previewBounds(
  t: Transform,
  v: Viewport,
  extra: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  } | null = null,
  padding = 0.08,
) {
  const b = bounds(t);
  const minX = Math.min(0, b.minX, extra?.minX ?? Infinity),
    minY = Math.min(0, b.minY, extra?.minY ?? Infinity),
    maxX = Math.max(v.cssWidth, b.maxX, extra?.maxX ?? -Infinity),
    maxY = Math.max(v.cssHeight, b.maxY, extra?.maxY ?? -Infinity);
  const overflows =
    minX < 0 || minY < 0 || maxX > v.cssWidth || maxY > v.cssHeight;
  const zoom = overflows
    ? Math.min(
        8,
        Math.max((maxX - minX) / v.cssWidth, (maxY - minY) / v.cssHeight) *
          (1 + padding),
      )
    : 1;
  const width = v.cssWidth * zoom,
    height = v.cssHeight * zoom;
  return {
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    width,
    height,
    zoom,
  };
}
export function centred(t: Transform, v: Viewport): { x: number; y: number } {
  return { x: (v.cssWidth - t.width) / 2, y: (v.cssHeight - t.height) / 2 };
}
/** Offset of the block's centre from the centre of the screen, so a centred block reads 0, 0. */
export function centreOffset(
  t: Transform,
  v: Viewport,
): { x: number; y: number } {
  const c = centre(t);
  return { x: c.x - v.cssWidth / 2, y: c.y - v.cssHeight / 2 };
}
/** Puts the block's centre at an offset from the screen centre. Size, scale and angle stay as they are. */
export function placeCentre(
  t: Transform,
  v: Viewport,
  x: number,
  y: number,
): Transform {
  return {
    ...t,
    x: v.cssWidth / 2 + x - t.width / 2,
    y: v.cssHeight / 2 + y - t.height / 2,
  };
}
/** The circle in screen pixels, placed from the screen centre exactly as the screen draws it. */
export function circleBounds(c: Circle, v: Viewport) {
  const cx = v.cssWidth / 2 + c.x,
    cy = v.cssHeight / 2 + c.y,
    radius = c.diameter / 2;
  return {
    cx,
    cy,
    radius,
    minX: cx - radius,
    minY: cy - radius,
    maxX: cx + radius,
    maxY: cy + radius,
  };
}
/** Grows the box symmetrically about its centre so the dragged corner tracks the pointer. */
export function resizeRotated(
  t: Transform,
  dx: number,
  dy: number,
  previewScale: number,
  lock: boolean,
): Transform {
  const a = (t.rotation * Math.PI) / 180,
    x = dx / previewScale / t.scale,
    y = dy / previewScale / t.scale;
  const width = Math.max(
    1,
    Math.min(4096, t.width + 2 * (x * Math.cos(a) + y * Math.sin(a))),
  );
  const height = lock
    ? (width * t.height) / t.width
    : Math.max(
        1,
        Math.min(4096, t.height + 2 * (-x * Math.sin(a) + y * Math.cos(a))),
      );
  return {
    ...t,
    width,
    height,
    x: t.x - (width - t.width) / 2,
    y: t.y - (height - t.height) / 2,
  };
}
/** Angle of a point around the rotation centre, in radians. Uniform scale cancels out. */
export function angleAt(
  pivotX: number,
  pivotY: number,
  x: number,
  y: number,
): number {
  return Math.atan2(y - pivotY, x - pivotX);
}
export function rotateBy(
  t: Transform,
  startAngle: number,
  currentAngle: number,
  snapDegrees = 0,
): Transform {
  let rotation = t.rotation + ((currentAngle - startAngle) * 180) / Math.PI;
  if (snapDegrees > 0)
    rotation = Math.round(rotation / snapDegrees) * snapDegrees;
  return { ...t, rotation: ((rotation % 360) + 360) % 360 };
}
/** Where the rotation grip sits: outward from the middle of the top edge, along the rotated up axis. */
export function rotateHandle(t: Transform, distance: number) {
  const p = corners(t);
  const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
  const up = { x: p[0].x - p[3].x, y: p[0].y - p[3].y };
  const length = Math.hypot(up.x, up.y) || 1;
  return {
    anchor: mid,
    grip: {
      x: mid.x + (up.x / length) * distance,
      y: mid.y + (up.y / length) * distance,
    },
  };
}
// The embedded player may hang off the edge of the screen: only its own size and opacity are checked.
export function youtubeGeometry(
  t: Transform,
  rotationEnabled: boolean,
): string | null {
  if (
    t.opacity !== 1 ||
    t.objectFit !== "contain" ||
    t.width < 200 ||
    t.height < 200 ||
    t.width * t.scale < 200 ||
    t.height * t.scale < 200
  )
    return "YouTube requires an opaque, uncropped frame of at least 200x200.";
  if (t.rotation !== 0 && !rotationEnabled)
    return "Experimental YouTube rotation is disabled.";
  return null;
}
