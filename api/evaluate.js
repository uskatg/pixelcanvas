// POST /api/evaluate {image} — AI judge: rate the finished canvas against the
// active task's reference image. Admin only (the presenter's client triggers it
// once when the countdown ends); the verdict is stored in the shared state so
// every polling client sees the same rating.
const { ANTHROPIC_API_KEY, EVAL_MODEL, getWorld, saveState, pipeline, isAdmin, sendJson, readJson } = require("../lib/core");

// The host's UI language (sent with the request) decides the rating language.
const EVAL = {
  de: {
    ratingDesc: "Accuracy score from 0 (nichts erkennbar) to 10 (perfekte Nachbildung).",
    feedbackDesc: "Ein kurzer, motivierender Satz Feedback auf Deutsch.",
    intro: "Bild 1 ist die VORLAGE. Bild 2 ist die gemeinsame Pixel-Art-Nachbildung der Spieler·innen auf einem niedrig aufgelösten Raster.",
    ask: "Bewerte, wie genau Bild 2 die Vorlage als Pixel-Art nachbildet (Form, Farben, Erkennbarkeit). Vergib eine Zahl von 0 bis 10 und einen kurzen, motivierenden Satz Feedback auf Deutsch.",
    noKey: "Bewertung nicht verfügbar — ANTHROPIC_API_KEY ist nicht gesetzt.",
    badImage: "Bewertung fehlgeschlagen — ungültiges Bild.",
    apiError: "Bewertung fehlgeschlagen — API-Fehler.",
    refused: "Bewertung abgelehnt.",
    netError: "Bewertung fehlgeschlagen — Netzwerkfehler.",
    noTask: "Keine Aufgabe aktiv.",
    noRef: "Bewertung fehlgeschlagen — Vorlage nicht gefunden.",
  },
  en: {
    ratingDesc: "Accuracy score from 0 (nothing recognizable) to 10 (perfect recreation).",
    feedbackDesc: "One short, encouraging sentence of feedback in English.",
    intro: "Image 1 is the REFERENCE. Image 2 is the players' collaborative pixel-art recreation on a low-resolution grid.",
    ask: "Rate how accurately Image 2 recreates the reference as pixel art (shape, colors, recognizability). Give a number from 0 to 10 and one short, encouraging sentence of feedback in English.",
    noKey: "Rating unavailable — ANTHROPIC_API_KEY is not set.",
    badImage: "Rating failed — invalid image.",
    apiError: "Rating failed — API error.",
    refused: "Rating declined.",
    netError: "Rating failed — network error.",
    noTask: "No task active.",
    noRef: "Rating failed — reference not found.",
  },
};
function evalStrings(lang) { return EVAL[lang === "en" ? "en" : "de"]; }

async function evaluateCanvas(refB64, refMedia, dataUrl, L) {
  if (!ANTHROPIC_API_KEY) return { rating: null, feedback: L.noKey };
  const m = /^data:(image\/png|image\/jpeg|image\/webp);base64,(.+)$/s.exec(dataUrl || "");
  if (!m) return { rating: null, feedback: L.badImage };

  const schema = {
    type: "object",
    properties: {
      rating: { type: "integer", description: L.ratingDesc },
      feedback: { type: "string", description: L.feedbackDesc },
    },
    required: ["rating", "feedback"],
    additionalProperties: false,
  };
  const body = {
    model: EVAL_MODEL,
    max_tokens: 512,
    output_config: { format: { type: "json_schema", schema } },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: L.intro },
        { type: "image", source: { type: "base64", media_type: refMedia, data: refB64 } },
        { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } },
        { type: "text", text: L.ask },
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
      return { rating: null, feedback: L.apiError };
    }
    const data = await r.json();
    if (data.stop_reason === "refusal") return { rating: null, feedback: L.refused };
    const textBlock = (data.content || []).find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock.text);
    let rating = Math.round(Number(parsed.rating));
    rating = Math.max(0, Math.min(10, isFinite(rating) ? rating : 0));
    return { rating, feedback: String(parsed.feedback || "") };
  } catch (e) {
    console.error("evaluateCanvas failed", e);
    return { rating: null, feedback: L.netError };
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") { sendJson(res, 405, {}); return; }
  if (!isAdmin(req)) { sendJson(res, 403, { error: "admin token required" }); return; }
  const { image, lang } = await readJson(req, 3_000_000);
  const L = evalStrings(lang);
  const { state } = await getWorld();
  if (!state.task) {
    sendJson(res, 400, { rating: null, feedback: L.noTask });
    return;
  }
  // Idempotent: if this round was already rated, return the stored verdict.
  if (state.verdict && state.verdict.round === state.deadline) {
    sendJson(res, 200, state.verdict);
    return;
  }

  // Reference image: a custom round stores it in Redis (pc:customref); the
  // built-in tasks live in /public, which serverless functions can't read from
  // disk, so fetch those from our own deployment.
  let refB64, refMedia = "image/webp";
  if (state.task === "custom") {
    try {
      const [dataUrl] = await pipeline([["GET", "pc:customref"]]);
      const rm = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(dataUrl || "");
      if (!rm) throw new Error("no custom ref");
      refMedia = rm[1];
      refB64 = rm[2];
    } catch {
      sendJson(res, 200, { rating: null, feedback: L.noRef });
      return;
    }
  } else {
    const proto = req.headers["x-forwarded-proto"] || "http";
    const refUrl = proto + "://" + req.headers.host + "/tasks/image" + state.task + ".webp";
    try {
      refB64 = Buffer.from(await (await fetch(refUrl)).arrayBuffer()).toString("base64");
    } catch {
      sendJson(res, 200, { rating: null, feedback: L.noRef });
      return;
    }
  }

  const round = state.deadline;
  const result = await evaluateCanvas(refB64, refMedia, image, L);
  // The API call above takes seconds — the host may have started a new round or
  // switched tasks meanwhile. Re-read fresh state and attach the verdict to THAT,
  // and only if the round is unchanged; never write the stale pre-call snapshot back.
  const { state: fresh } = await getWorld();
  if (fresh.verdict && fresh.verdict.round === round) {
    sendJson(res, 200, fresh.verdict);
    return;
  }
  const verdict = { ...result, round };
  if (fresh.deadline === round && fresh.task === state.task) {
    fresh.verdict = verdict;
    await saveState(fresh);
  }
  sendJson(res, 200, verdict);
};
