// POST /api/evaluate {image} — AI judge: rate the finished canvas against the
// active task's reference image. Admin only (the presenter's client triggers it
// once when the countdown ends); the verdict is stored in the shared state so
// every polling client sees the same rating.
const { ANTHROPIC_API_KEY, EVAL_MODEL, getWorld, saveState, isAdmin, sendJson, readJson } = require("../lib/core");

const EVAL_SCHEMA = {
  type: "object",
  properties: {
    rating: { type: "integer", description: "Accuracy score from 0 (nichts erkennbar) to 10 (perfekte Nachbildung)." },
    feedback: { type: "string", description: "Ein kurzer, motivierender Satz Feedback auf Deutsch." },
  },
  required: ["rating", "feedback"],
  additionalProperties: false,
};

async function evaluateCanvas(refB64, dataUrl) {
  if (!ANTHROPIC_API_KEY) {
    return { rating: null, feedback: "Bewertung nicht verfügbar — ANTHROPIC_API_KEY ist nicht gesetzt." };
  }
  const m = /^data:(image\/png|image\/jpeg|image\/webp);base64,(.+)$/s.exec(dataUrl || "");
  if (!m) return { rating: null, feedback: "Bewertung fehlgeschlagen — ungültiges Bild." };

  const body = {
    model: EVAL_MODEL,
    max_tokens: 512,
    output_config: { format: { type: "json_schema", schema: EVAL_SCHEMA } },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Bild 1 ist die VORLAGE. Bild 2 ist die gemeinsame Pixel-Art-Nachbildung der Spieler·innen auf einem niedrig aufgelösten Raster." },
        { type: "image", source: { type: "base64", media_type: "image/webp", data: refB64 } },
        { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        { type: "text", text: "Bewerte, wie genau Bild 2 die Vorlage als Pixel-Art nachbildet (Form, Farben, Erkennbarkeit). Vergib eine Zahl von 0 bis 10 und einen kurzen, motivierenden Satz Feedback auf Deutsch." },
      ],
    }],
  };

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      console.error("Anthropic API error", r.status, await r.text().catch(() => ""));
      return { rating: null, feedback: "Bewertung fehlgeschlagen — API-Fehler." };
    }
    const data = await r.json();
    if (data.stop_reason === "refusal") {
      return { rating: null, feedback: "Bewertung abgelehnt." };
    }
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    let rating = Math.round(Number(parsed.rating));
    rating = Math.max(0, Math.min(10, isFinite(rating) ? rating : 0));
    return { rating, feedback: String(parsed.feedback || "") };
  } catch (e) {
    console.error("evaluateCanvas failed", e);
    return { rating: null, feedback: "Bewertung fehlgeschlagen — Netzwerkfehler." };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  if (!isAdmin(req)) { sendJson(res, 403, { error: "admin token required" }); return; }
  const { image } = await readJson(req, 3_000_000);
  const { state } = await getWorld();
  if (!state.task) {
    sendJson(res, 400, { rating: null, feedback: "Keine Aufgabe aktiv." });
    return;
  }
  // Idempotent: if this round was already rated, return the stored verdict.
  if (state.verdict && state.verdict.round === state.deadline) {
    sendJson(res, 200, state.verdict);
    return;
  }

  // The reference image lives in /public (served statically) — serverless
  // functions can't read it from disk, so fetch it from our own deployment.
  const proto = req.headers["x-forwarded-proto"] || "http";
  const refUrl = proto + "://" + req.headers.host + "/tasks/image" + state.task + ".webp";
  let refB64;
  try {
    refB64 = Buffer.from(await (await fetch(refUrl)).arrayBuffer()).toString("base64");
  } catch {
    sendJson(res, 200, { rating: null, feedback: "Bewertung fehlgeschlagen — Vorlage nicht gefunden." });
    return;
  }

  const result = await evaluateCanvas(refB64, image);
  state.verdict = { ...result, round: state.deadline };
  await saveState(state);
  sendJson(res, 200, state.verdict);
};
