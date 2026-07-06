// POST /api/timer {action: "start"|"pause"|"reset"} — control the shared
// countdown. Admin only.
const { getWorld, saveState, isAdmin, sendJson, readJson } = require("../lib/core");

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  if (!isAdmin(req)) { sendJson(res, 403, { error: "admin token required" }); return; }
  const { action } = await readJson(req, 200);
  const { state } = await getWorld();
  const now = Date.now();

  if (action === "start") {
    // paused === 0 (or an already-expired deadline) means the round is over:
    // starting again begins a fresh round of full length, not a 1-second stub.
    const remaining = state.paused ? state.paused : state.duration;
    state.deadline = now + Math.max(1, remaining) * 1000;
    state.paused = null;
    state.verdict = null;
  } else if (action === "pause") {
    if (state.deadline !== null) {
      const left = Math.ceil((state.deadline - now) / 1000);
      state.paused = left > 0 ? left : state.duration;
      state.deadline = null;
    }
  } else if (action === "reset") {
    state.deadline = null;
    state.paused = state.duration;
    state.verdict = null;
  } else {
    sendJson(res, 400, { error: "unknown action" });
    return;
  }
  await saveState(state);
  sendJson(res, 200, { state });
};
