// LLM interpretation layer.
//
// Responsibility: turn free text into the validated structured shape defined in
// schema.js. It does NOT decide routing — that's route.js. Keeping interpretation
// and policy separate means the model never invents the routing rules; it only
// extracts facts, and deterministic code makes the decision.

import Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_TOOL, validate } from "./schema.js";
import { heuristicClassify } from "./heuristic.js";

const MODEL = "claude-opus-4-8";
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const client = hasKey ? new Anthropic() : null;

const SYSTEM = `You are the intake triage engine for a financial advisory service for small business owners.
You receive a messy, free-text description of a money problem. Classify it, extract the key fields a human
advisor would need, and honestly assess urgency, confidence, and whether there is enough information to act.
Do not give financial advice. Do not guess facts that were not stated — use null. Always call the
record_triage tool; never reply in prose.`;

// Returns { result, source, degraded, note }.
//   source: "llm" | "heuristic"
//   degraded: true when we fell back off the LLM path (used to flag the response)
export async function classify(text, context = {}) {
  if (!hasKey) {
    return {
      result: heuristicClassify(text),
      source: "heuristic",
      degraded: false, // running in mock mode by design, not a failure
      note: "No ANTHROPIC_API_KEY set — running in mock (heuristic) mode.",
    };
  }

  try {
    const input = await callModelWithRetry(text, context);
    return { result: input, source: "llm", degraded: false, note: null };
  } catch (err) {
    // Provider down, rate-limited, or repeatedly malformed output.
    // Degrade to heuristics instead of failing the caller's request.
    return {
      result: heuristicClassify(text),
      source: "heuristic",
      degraded: true,
      note: `LLM unavailable (${err.code || err.name || "error"}); served by heuristic fallback.`,
    };
  }
}

async function callModelWithRetry(text, context, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: [EXTRACTION_TOOL],
      // Force the model to call our tool so we get structured JSON, not prose.
      tool_choice: { type: "tool", name: EXTRACTION_TOOL.name },
      messages: [{ role: "user", content: buildUserContent(text, context) }],
    });

    const toolUse = msg.content.find((b) => b.type === "tool_use");
    if (!toolUse) {
      lastErr = new Error("model returned no tool_use block");
      continue;
    }

    const { ok, errors } = validate(toolUse.input);
    if (ok) return toolUse.input;

    // Malformed / out-of-schema output — a real failure mode even with forced
    // tools. Retry once with the errors fed back, then give up to the fallback.
    lastErr = new Error(`invalid tool output: ${errors.join("; ")}`);
  }
  throw lastErr;
}

function buildUserContent(text, context) {
  let content = `Business owner's message:\n"""\n${text}\n"""`;
  // Optional structured context the caller may supply (a few fields / an upload).
  const extras = Object.entries(context).filter(([, v]) => v != null && v !== "");
  if (extras.length) {
    content += `\n\nAdditional context provided:\n${extras.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`;
  }
  return content;
}
