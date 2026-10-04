/**
 * Screenshot annotations: boxes, arrows and privacy blur.
 *
 * Annotations are stored as data ({ type, x1, y1, x2, y2, color }) in image
 * pixel coordinates; the original screenshot is never modified. Everything
 * that leaves the report page (copy, download, AI triage) uses the composite
 * produced by `renderComposite`.
 *
 * Geometry helpers are pure and unit tested; drawing needs a 2D canvas.
 */

export const TOOLS = Object.freeze(["box", "arrow", "blur"]);
export const COLORS = Object.freeze(["#e5484d", "#f59e0b", "#16a34a", "#2563eb"]);
const MIN_SIZE = 4;

/** {x, y, w, h} with non-negative size, from any two corners. */
export function normalizeRect({ x1, y1, x2, y2 }) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1)
  };
}

/** Rect clipped to the image; null when nothing is left. */
export function clipRect(rect, width, height) {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(width, Math.ceil(rect.x + rect.w));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.h));
  return right > x && bottom > y ? { x, y, w: right - x, h: bottom - y } : null;
}

/** Ignore accidental clicks: arrows need length, boxes/blurs need area. */
export function isMeaningful(annotation) {
  const { w, h } = normalizeRect(annotation);
  return annotation.type === "arrow" ? Math.hypot(w, h) >= MIN_SIZE * 2 : w >= MIN_SIZE && h >= MIN_SIZE;
}

/** Line width that stays visible on both small and retina screenshots. */
export function strokeWidthFor(imageWidth) {
  return Math.max(3, Math.round(imageWidth / 400));
}

/** The two wing points of an arrow head at (x2, y2). */
export function arrowHead({ x1, y1, x2, y2 }, size) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  return [
    [x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread)],
    [x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread)]
  ];
}

/** Pixel block size: coarse enough that text inside can't be read. */
export function blurBlockSize(rect) {
  return Math.max(12, Math.round(Math.max(rect.w, rect.h) / 12));
}

/** Blocks tiling a (clipped) rect; edge blocks are trimmed to the rect. */
export function pixelBlocks(rect, blockSize) {
  const blocks = [];
  for (let y = rect.y; y < rect.y + rect.h; y += blockSize) {
    for (let x = rect.x; x < rect.x + rect.w; x += blockSize) {
      blocks.push({
        x,
        y,
        w: Math.min(blockSize, rect.x + rect.w - x),
        h: Math.min(blockSize, rect.y + rect.h - y)
      });
    }
  }
  return blocks;
}

function pixelate(ctx, annotation, width, height) {
  const rect = clipRect(normalizeRect(annotation), width, height);
  if (!rect) return;
  const { data } = ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  const size = blurBlockSize(rect);

  for (const block of pixelBlocks(rect, size)) {
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let y = block.y; y < block.y + block.h; y += 1) {
      for (let x = block.x; x < block.x + block.w; x += 1) {
        const i = ((y - rect.y) * rect.w + (x - rect.x)) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count += 1;
      }
    }
    ctx.fillStyle = `rgb(${Math.round(r / count)} ${Math.round(g / count)} ${Math.round(b / count)})`;
    ctx.fillRect(block.x, block.y, block.w, block.h);
  }
}

function strokeShape(ctx, annotation, lineWidth) {
  ctx.save();
  ctx.strokeStyle = annotation.color || COLORS[0];
  ctx.fillStyle = annotation.color || COLORS[0];
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // A soft outline keeps marks readable on any background.
  ctx.shadowColor = "rgb(0 0 0 / 0.35)";
  ctx.shadowBlur = lineWidth;

  if (annotation.type === "box") {
    const { x, y, w, h } = normalizeRect(annotation);
    ctx.strokeRect(x, y, w, h);
  } else if (annotation.type === "arrow") {
    const head = lineWidth * 4.5;
    const [left, right] = arrowHead(annotation, head);
    // Stop the shaft inside the head so the tip stays sharp.
    const angle = Math.atan2(annotation.y2 - annotation.y1, annotation.x2 - annotation.x1);
    ctx.beginPath();
    ctx.moveTo(annotation.x1, annotation.y1);
    ctx.lineTo(annotation.x2 - Math.cos(angle) * head * 0.6, annotation.y2 - Math.sin(angle) * head * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(annotation.x2, annotation.y2);
    ctx.lineTo(left[0], left[1]);
    ctx.lineTo(right[0], right[1]);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draws `image` plus annotations onto `ctx` (canvas sized to the image).
 * Blurs are applied first so marks drawn on top of them stay visible.
 */
export function drawAnnotations(ctx, image, annotations, width, height) {
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  for (const annotation of annotations) {
    if (annotation.type === "blur") pixelate(ctx, annotation, width, height);
  }
  const lineWidth = strokeWidthFor(width);
  for (const annotation of annotations) {
    if (annotation.type !== "blur") strokeShape(ctx, annotation, lineWidth);
  }
}

/**
 * Composite PNG of a screenshot Blob with its annotations, optionally
 * downscaled so the long edge is at most `maxEdge` pixels.
 * @returns {Promise<Blob>}
 */
export async function renderComposite(screenshot, annotations = [], { maxEdge = Infinity } = {}) {
  const bitmap = await createImageBitmap(screenshot);
  const { width, height } = bitmap;
  const full = new OffscreenCanvas(width, height);
  drawAnnotations(full.getContext("2d"), bitmap, annotations, width, height);
  bitmap.close();

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  if (scale >= 1) return full.convertToBlob({ type: "image/png" });

  const small = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
  const ctx = small.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(full, 0, 0, small.width, small.height);
  return small.convertToBlob({ type: "image/png" });
}
