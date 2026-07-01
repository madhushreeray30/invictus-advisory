import "dotenv/config";
import express from "express";
import { classify } from "./classify.js";
import { route } from "./route.js";

const app = express();
app.use(express.json({ limit: "64kb" }));

// Tiny structured request logger. In production this is where you'd emit the
// fields listed in the README's observability section (latency, source, degraded).
app.use((req, _res, next) => {
  req._t0 = Date.now();
  next();
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", llm: process.env.ANTHROPIC_API_KEY ? "configured" : "mock" });
});

// Main endpoint: free text (+ optional context) -> structured triage + next action.
app.post("/triage", async (req, res) => {
  const { text, context } = req.body || {};

  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Body must include a non-empty 'text' string." });
  }

  try {
    const { result, source, degraded, note } = await classify(text, context || {});
    const decision = route(result);

    const latency_ms = Date.now() - req._t0;
    // One structured log line per request — the raw material for monitoring.
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        latency_ms,
        source,
        degraded,
        category: decision.category,
        status: decision.status,
        urgency: decision.urgency,
        confidence: decision.confidence,
      })
    );

    res.json({
      ...decision,
      meta: { source, degraded, note, latency_ms, model: source === "llm" ? "claude-opus-4-8" : "heuristic" },
    });
  } catch (err) {
    // Last-resort guard. classify() already degrades gracefully, so reaching
    // here means something unexpected — fail closed with a 500, don't hang.
    console.error(JSON.stringify({ at: new Date().toISOString(), error: err.message }));
    res.status(500).json({ error: "Internal triage error." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const mode = process.env.ANTHROPIC_API_KEY ? "LLM (claude-opus-4-8)" : "MOCK (heuristic — no API key)";
  console.log(`invictus-advisory listening on :${PORT}  [${mode}]`);
});
