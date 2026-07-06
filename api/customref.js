// GET /api/customref — the host-uploaded reference image (data URL) for a
// custom round. Open to all (players need to see the reference). Returned
// out-of-band so the ~50-80KB image isn't in every 1.2s poll of the state.
const { pipeline, sendJson } = require("../lib/core");

module.exports = async (req, res) => {
  const [image] = await pipeline([["GET", "pc:customref"]]);
  sendJson(res, 200, { image: typeof image === "string" ? image : null });
};
