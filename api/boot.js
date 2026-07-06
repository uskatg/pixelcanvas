// GET /api/boot — everything a freshly loaded client needs.
const { PALETTE, EMPTY, ICONS, getWorld, pipeline, isAdmin, sendJson, ADMIN_TOKEN } = require("../lib/core");

module.exports = async (req, res) => {
  const { state, grid } = await getWorld();
  const admin = isAdmin(req);
  // Admins get the current mute list so muting survives a host page reload.
  let muted = [];
  if (admin) { try { [muted] = await pipeline([["SMEMBERS", "pc:muted"]]); } catch {} }
  sendJson(res, 200, {
    palette: PALETTE,
    empty: EMPTY,
    icons: ICONS,
    admin,
    adminConfigured: Boolean(ADMIN_TOKEN),
    now: Date.now(),
    state,
    grid,
    muted: muted || [],
  });
};
