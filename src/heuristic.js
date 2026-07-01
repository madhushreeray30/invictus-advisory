// Deterministic, keyword-based classifier.
//
// This serves two jobs:
//   1. Lets the whole service run with NO API key (MOCK mode) so a reviewer can
//      clone and `npm run demo` without secrets.
//   2. Is the graceful fallback when the LLM provider is down or rate-limited —
//      the service degrades to heuristics rather than failing the request.
//
// It is intentionally simple and honest: it reports low confidence, because a
// keyword matcher genuinely is less reliable than the model. That low confidence
// then flows through the normal routing logic and pushes borderline cases to a
// human — which is the correct behaviour when the AI is unavailable.

const SIGNALS = {
  cashflow_liquidity: ["cash flow", "cashflow", "run out of cash", "payroll", "can't pay", "cant pay", "rent", "wages", "liquidity", "short on cash", "short", "money is tight", "bounce"],
  tax_compliance: ["tax", "vat", "hmrc", "irs", "sales tax", "filing", "deadline", "penalty", "return", "bookkeeping", "compliance", "audit"],
  funding_financing: ["loan", "overdraft", "line of credit", "funding", "investor", "grant", "borrow", "refinance", "capital", "financing"],
  invoicing_receivables: ["invoice", "unpaid", "late payment", "customer hasn't paid", "chase", "receivable", "owe me", "owes me", "owes", "due", "debtor", "payment terms"],
  cost_management: ["cut costs", "reduce spend", "overhead", "subscription", "renegotiate", "expensive", "margin", "cheaper", "save money"],
};

const URGENCY_WORDS = {
  critical: ["today", "tomorrow", "this week", "friday", "frozen", "immediately", "emergency", "can't make payroll", "cant make payroll", "make payroll"],
  high: ["next week", "urgent", "asap", "soon", "two weeks", "overdue", "45 days", "60 days"],
  medium: ["this month", "next month", "few weeks", "end of the month", "end of month"],
};

export function heuristicClassify(text) {
  const t = (text || "").toLowerCase();

  // Score each category by keyword hits.
  const scores = {};
  for (const [cat, words] of Object.entries(SIGNALS)) {
    scores[cat] = words.reduce((n, w) => (t.includes(w) ? n + 1 : n), 0);
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  const [category, hits] = best;

  // Confidence is deliberately capped low — this is a fallback, not the model.
  // No keyword hits at all -> unknown -> hand to a human.
  // Confidence stays capped below what the model would produce — this is a
  // fallback. But strong multi-keyword matches are allowed to clear the routing
  // floor so unambiguous cases still route without a human in mock/degraded mode.
  const noSignal = hits === 0;
  const confidence = noSignal ? 0.2 : Math.min(0.75, 0.25 + hits * 0.12);

  let urgency = "low";
  for (const level of ["critical", "high", "medium"]) {
    if (URGENCY_WORDS[level].some((w) => t.includes(w))) {
      urgency = level;
      break;
    }
  }

  const tooShort = t.trim().split(/\s+/).filter(Boolean).length < 5;

  return {
    category: noSignal ? "other_needs_human" : category,
    confidence,
    urgency,
    has_enough_info: !tooShort && !noSignal,
    missing_information: tooShort
      ? ["A fuller description of the problem (only a few words were provided)."]
      : noSignal
        ? ["What financial area this relates to — the request didn't match a known category."]
        : [],
    extracted: {
      summary: (text || "").trim().slice(0, 160) || "(empty request)",
      amount: (t.match(/[£$€]\s?[\d,.]+/) || [null])[0],
      deadline: (t.match(/\b(today|tomorrow|friday|monday|this week|next week|this month)\b/) || [null])[0],
      business_type: null,
      sentiment: /panic|desperate|terrified|freaking/.test(t)
        ? "panicked"
        : /worried|stress|scared|anxious/.test(t)
          ? "stressed"
          : /concern/.test(t)
            ? "concerned"
            : "calm",
    },
  };
}
