// POST /api/task {task, seconds?, image?, w?, h?} — choose (or close) the shared
// reference. Admin only. Choosing a task reshapes the canvas to the image's
// proportion, clears it, and starts the shared countdown for everyone.
//   task "1"|"2"      → built-in reference (public/tasks/imageN.webp)
//   task "custom"     → host-uploaded image (data URL in `image`, grid dims w×h);
//                       the image is stored in Redis (pc:customref) and served
//                       to clients via /api/customref, rated via /api/evaluate.
//   task null/""      → back to the free-drawing canvas.
const { TASK_DIMS, MAX_CELLS, DEFAULT_SECONDS, getWorld, setWorld, pipeline, emptyGrid, defaultState, isAdmin, sendJson, readJson } = require("../lib/core");

const CUSTOM_IMAGE_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  if (!isAdmin(req)) { sendJson(res, 403, { error: "admin token required" }); return; }
  const body = await readJson(req, 1_400_000); // custom uploads carry a small image
  const { task, seconds } = body;
  const { state } = await getWorld();
  const secs = () => Math.min(3600, Math.max(5, parseInt(seconds, 10) || DEFAULT_SECONDS));

  if (task === null || task === undefined || task === "") {
    // Back to the free-drawing canvas at its default size, wiped.
    const def = defaultState();
    state.task = null;
    state.deadline = null;
    state.paused = null;
    state.verdict = null;
    state.customVer = null;
    state.w = def.w;
    state.h = def.h;
    state.ts = Date.now();
    await setWorld(emptyGrid(def.w, def.h), state);
  } else if (String(task) === "custom") {
    const image = body.image;
    const w = parseInt(body.w, 10), h = parseInt(body.h, 10);
    if (typeof image !== "string" || !CUSTOM_IMAGE_RE.test(image) || image.length > 1_000_000) {
      sendJson(res, 400, { error: "invalid image" });
      return;
    }
    if (!(w >= 8 && w <= 64 && h >= 8 && h <= 64 && w * h <= MAX_CELLS)) {
      sendJson(res, 400, { error: "invalid dimensions" });
      return;
    }
    // Store the reference out-of-band (NOT in state — every poll reads state).
    await pipeline([["SET", "pc:customref", image], ["EXPIRE", "pc:customref", 21600]]);
    state.task = "custom";
    state.w = w;
    state.h = h;
    state.duration = secs();
    state.deadline = Date.now() + secs() * 1000;
    state.paused = null;
    state.verdict = null;
    state.customVer = Date.now(); // clients refetch the image when this changes
    state.ts = Date.now();
    await setWorld(emptyGrid(w, h), state);
  } else if (TASK_DIMS[String(task)]) {
    const dims = TASK_DIMS[String(task)];
    state.task = String(task);
    state.w = dims.w;
    state.h = dims.h;
    state.duration = secs();
    state.deadline = Date.now() + secs() * 1000; // countdown begins immediately
    state.paused = null;
    state.verdict = null;
    state.customVer = null;
    state.ts = Date.now();
    await setWorld(emptyGrid(dims.w, dims.h), state);
  } else {
    sendJson(res, 400, { error: "unknown task" });
    return;
  }
  sendJson(res, 200, { state });
};
