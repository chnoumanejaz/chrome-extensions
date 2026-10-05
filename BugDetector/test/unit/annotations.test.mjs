import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRect,
  clipRect,
  isMeaningful,
  arrowHead,
  blurBlockSize,
  pixelBlocks,
  strokeWidthFor,
  drawAnnotations
} from "../../lib/annotations.js";

test("normalizeRect works from any corner", () => {
  assert.deepEqual(normalizeRect({ x1: 50, y1: 40, x2: 10, y2: 10 }), { x: 10, y: 10, w: 40, h: 30 });
});

test("clipRect keeps rects inside the image", () => {
  assert.deepEqual(clipRect({ x: -10, y: 5, w: 30, h: 1000 }, 100, 80), { x: 0, y: 5, w: 20, h: 75 });
  assert.equal(clipRect({ x: 200, y: 0, w: 10, h: 10 }, 100, 80), null);
});

test("isMeaningful ignores accidental clicks", () => {
  assert.equal(isMeaningful({ type: "box", x1: 0, y1: 0, x2: 2, y2: 50 }), false);
  assert.equal(isMeaningful({ type: "blur", x1: 0, y1: 0, x2: 20, y2: 20 }), true);
  assert.equal(isMeaningful({ type: "arrow", x1: 0, y1: 0, x2: 5, y2: 0 }), false);
  assert.equal(isMeaningful({ type: "arrow", x1: 0, y1: 0, x2: 0, y2: 30 }), true);
});

test("arrowHead wings sit behind the tip, symmetric around the shaft", () => {
  const [[lx, ly], [rx, ry]] = arrowHead({ x1: 0, y1: 0, x2: 100, y2: 0 }, 10);
  assert.ok(lx < 100 && rx < 100);
  assert.ok(Math.abs(lx - rx) < 1e-9);
  assert.ok(Math.abs(ly + ry) < 1e-9);
});

test("blur blocks are coarse and tile the region exactly", () => {
  assert.equal(blurBlockSize({ w: 60, h: 20 }), 12, "minimum block size");
  assert.equal(blurBlockSize({ w: 600, h: 40 }), 50);
  const rect = { x: 5, y: 5, w: 30, h: 25 };
  const blocks = pixelBlocks(rect, 12);
  assert.equal(blocks.length, 9);
  const area = blocks.reduce((sum, b) => sum + b.w * b.h, 0);
  assert.equal(area, rect.w * rect.h);
  assert.ok(blocks.every((b) => b.x + b.w <= 35 && b.y + b.h <= 30));
});

test("strokeWidthFor scales with the image", () => {
  assert.equal(strokeWidthFor(800), 3);
  assert.equal(strokeWidthFor(2880), 7);
});

test("drawAnnotations applies blurs before shapes", () => {
  const calls = [];
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => {
        calls.push(prop);
        if (prop === "getImageData") return { data: new Uint8ClampedArray(args[2] * args[3] * 4).fill(100) };
        return undefined;
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    }
  });
  drawAnnotations(ctx, {}, [
    { type: "box", x1: 0, y1: 0, x2: 50, y2: 50 },
    { type: "blur", x1: 10, y1: 10, x2: 40, y2: 40 }
  ], 100, 100);
  assert.equal(calls[0], "clearRect");
  assert.equal(calls[1], "drawImage");
  assert.ok(calls.indexOf("getImageData") < calls.indexOf("strokeRect"));
  assert.equal(ctx.fillStyle, "#e5484d", "box colour defaults to red");
});
