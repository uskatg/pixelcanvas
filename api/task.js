// POST /api/task {task: "1"|"2"|null, seconds?} — choose (or close) the shared
// reference image. Admin only. Choosing a task reshapes the canvas to the
// image's proportion, clears it, and starts the shared countdown for everyone.
const { TASK_DIMS, DEFAULT_SECONDS, getWorld, setWorld, emptyGrid, defaultState, isAdmin, sendJson, readJson } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  if (!isAdmin(req)) { sendJson(res, 403, { error: "admin token required" }); return; }
  const { task, seconds } = await readJson(req, 1000);
  const { state } = await getWorld();

  if (task === null || task === undefined || task === "") {
    // Back to the free-drawing canvas at its default size, wiped.
    const def = defaultState();
    state.task = null;
    state.deadline = null;
    state.paused = null;
    state.verdict = null;
    state.w = def.w;
    state.h = def.h;
    state.ts = Date.now();
    await setWorld(emptyGrid(def.w, def.h), state);
  } else if (TASK_DIMS[String(task)]) {
    const dims = TASK_DIMS[String(task)];
    const secs = Math.min(3600, Math.max(5, parseInt(seconds, 10) || DEFAULT_SECONDS));
    state.task = String(task);
    state.w = dims.w;
    state.h = dims.h;
    state.duration = secs;
    state.deadline = Date.now() + secs * 1000; // countdown begins immediately
    state.paused = null;
    state.verdict = null;
    state.ts = Date.now();
    await setWorld(emptyGrid(dims.w, dims.h), state);
  } else {
    sendJson(res, 400, { error: "unknown task" });
    return;
  }
  sendJson(res, 200, { state });
};
