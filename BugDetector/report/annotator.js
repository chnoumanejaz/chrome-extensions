/**
 * In-place screenshot annotation editor: box, arrow and blur tools, colour,
 * undo and clear. Draws on a canvas sized to the screenshot (image pixels);
 * pointer coordinates are scaled from CSS pixels. Works with mouse, pen and
 * touch via Pointer Events.
 */
import { COLORS, TOOLS, drawAnnotations, isMeaningful } from "../lib/annotations.js";
import { h } from "../ui/ui.js";

const TOOL_LABELS = { box: "Box", arrow: "Arrow", blur: "Blur" };
const TOOL_ICONS = {
  box: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
  arrow: '<path d="M5 19L19 5M19 5h-8M19 5v8"/>',
  blur: '<rect x="4" y="4" width="5" height="5"/><rect x="10" y="4" width="5" height="5" opacity=".5"/><rect x="16" y="4" width="4" height="5"/><rect x="4" y="10" width="5" height="5" opacity=".5"/><rect x="10" y="10" width="5" height="5"/><rect x="16" y="10" width="4" height="5" opacity=".5"/><rect x="4" y="16" width="5" height="4"/><rect x="10" y="16" width="5" height="4" opacity=".5"/><rect x="16" y="16" width="4" height="4"/>'
};
const COLOR_NAMES = ["Red", "Amber", "Green", "Blue"];

function icon(paths) {
  const span = h("span", { className: "tool-icon", "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return span;
}

/**
 * @param {object} options
 * @param {HTMLCanvasElement} options.canvas
 * @param {HTMLElement} options.toolbar
 * @param {ImageBitmap} options.image
 * @param {object[]} options.annotations   initial annotations (image pixels)
 * @param {(list: object[]) => void} options.onChange
 */
export function createAnnotator({ canvas, toolbar, image, annotations, onChange }) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  canvas.width = image.width;
  canvas.height = image.height;

  let list = annotations.map((a) => ({ ...a }));
  let tool = "box";
  let color = COLORS[0];
  let draft = null;
  let editing = false;

  function redraw() {
    drawAnnotations(ctx, image, draft ? [...list, draft] : list, canvas.width, canvas.height);
  }

  function commit(next) {
    list = next;
    redraw();
    syncButtons();
    onChange(list.map((a) => ({ ...a })));
  }

  // ------------------------------------------------------------- toolbar

  const toolButtons = new Map();
  for (const name of TOOLS) {
    const button = h("button", {
      type: "button",
      className: "tool",
      title: `${TOOL_LABELS[name]}${name === "blur" ? " (hide private info)" : ""}`,
      "aria-pressed": "false",
      onclick: () => setTool(name)
    }, icon(TOOL_ICONS[name]), h("span", {}, TOOL_LABELS[name]));
    toolButtons.set(name, button);
  }

  const swatches = COLORS.map((value, index) => h("button", {
    type: "button",
    className: "swatch",
    title: COLOR_NAMES[index],
    "aria-label": `${COLOR_NAMES[index]} colour`,
    "aria-pressed": "false",
    style: `--swatch: ${value}`,
    onclick: () => {
      color = value;
      syncButtons();
    }
  }));

  const undoButton = h("button", { type: "button", className: "tool", title: "Undo (Ctrl+Z)", onclick: undo }, "Undo");
  const clearButton = h("button", { type: "button", className: "tool", title: "Remove all annotations", onclick: () => commit([]) }, "Clear");

  toolbar.replaceChildren(
    h("div", { className: "tool-group" }, [...toolButtons.values()]),
    h("div", { className: "tool-group swatches", role: "radiogroup", "aria-label": "Colour" }, swatches),
    h("div", { className: "tool-group" }, undoButton, clearButton),
    h("span", { className: "tool-hint small muted" }, "Drag on the screenshot to draw")
  );

  function syncButtons() {
    for (const [name, button] of toolButtons) button.setAttribute("aria-pressed", String(name === tool));
    swatches.forEach((swatch, index) => swatch.setAttribute("aria-pressed", String(COLORS[index] === color)));
    for (const swatch of swatches) swatch.disabled = tool === "blur";
    undoButton.disabled = clearButton.disabled = list.length === 0;
  }

  function setTool(name) {
    tool = name;
    syncButtons();
  }

  function undo() {
    if (list.length) commit(list.slice(0, -1));
  }

  // -------------------------------------------------------------- pointer

  function toImage(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - rect.left) / rect.width) * canvas.width),
      y: Math.round(((event.clientY - rect.top) / rect.height) * canvas.height)
    };
  }

  canvas.addEventListener("pointerdown", (event) => {
    if (!editing || event.button !== 0) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const { x, y } = toImage(event);
    draft = { type: tool, color: tool === "blur" ? null : color, x1: x, y1: y, x2: x, y2: y };
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!draft) return;
    const { x, y } = toImage(event);
    draft.x2 = x;
    draft.y2 = y;
    redraw();
  });

  const finish = () => {
    if (!draft) return;
    const done = draft;
    draft = null;
    if (isMeaningful(done)) commit([...list, done]);
    else redraw();
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", () => {
    draft = null;
    redraw();
  });

  document.addEventListener("keydown", (event) => {
    if (!editing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (event.key === "Escape" && draft) {
      draft = null;
      redraw();
    }
  });

  // ---------------------------------------------------------------- API

  function setEditing(value) {
    editing = value;
    toolbar.hidden = !value;
    canvas.classList.toggle("editing", value);
    syncButtons();
  }

  syncButtons();
  redraw();

  return {
    setEditing,
    get editing() {
      return editing;
    },
    get annotations() {
      return list.map((a) => ({ ...a }));
    }
  };
}
