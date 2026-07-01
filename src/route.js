// Routing policy — deterministic, not model-driven.
//
// The LLM extracts facts and self-assesses; THIS file decides what happens next.
// Encoding the policy in code (not the prompt) means routing is auditable,
// testable, and can't be talked out of a safe decision by a persuasive input.

import { CATEGORIES, CONFIDENCE_FLOOR } from "./schema.js";

// Which action string each category maps to when we're confident and informed.
const NEXT_ACTION = {
  cashflow_liquidity: "Book a same-week cashflow triage call and start a 13-week cash forecast.",
  tax_compliance: "Route to a tax advisor to confirm the deadline and prepare/verify the filing.",
  funding_financing: "Prepare a financing options brief (overdraft vs. loan vs. grant) for review.",
  invoicing_receivables: "Send the overdue-invoice recovery playbook and offer a collections review.",
  cost_management: "Schedule a cost & subscription audit to find quick savings.",
  other_needs_human: "Hand to a human triage agent to clarify and re-route.",
};

export function route(result) {
  const category = CATEGORIES[result.category] ? result.category : "other_needs_human";
  const cat = CATEGORIES[category];

  // --- Gate 1: not enough information to act on ---------------------------
  if (result.has_enough_info === false) {
    return decision({
      status: "needs_more_info",
      routeTo: "clarification_bot",
      action: "Ask the owner for the missing details before routing to an advisor.",
      questions: result.missing_information || [],
      rationale:
        "The request is on-topic but under-specified. Collecting the missing facts first " +
        "avoids a wasted advisor session and a wrong route.",
      result,
      category,
    });
  }

  // --- Gate 2: low model confidence -> human review ----------------------
  if (typeof result.confidence === "number" && result.confidence < CONFIDENCE_FLOOR) {
    return decision({
      status: "low_confidence_review",
      routeTo: "human_triage",
      action: "Send to a human triage agent to confirm the category before advising.",
      questions: [],
      rationale:
        `Predicted "${cat.label}" but confidence ${fmt(result.confidence)} is below the ` +
        `${CONFIDENCE_FLOOR} floor. Cheaper to have a human confirm than to auto-route wrong.`,
      result,
      category,
    });
  }

  // --- Gate 3: explicit out-of-scope -------------------------------------
  if (category === "other_needs_human") {
    return decision({
      status: "routed",
      routeTo: cat.routeTo,
      action: NEXT_ACTION.other_needs_human,
      questions: [],
      rationale: "Request doesn't map to a financial advisory category; a human should clarify and re-route.",
      result,
      category,
    });
  }

  // --- Confident, informed, in-scope: route + set SLA from urgency -------
  return decision({
    status: "routed",
    routeTo: cat.routeTo,
    action: NEXT_ACTION[category],
    questions: [],
    rationale:
      `Classified as "${cat.label}" (confidence ${fmt(result.confidence)}). ` +
      `Urgency "${result.urgency}" → ${slaFor(result.urgency)}. Routed to ${cat.routeTo}.`,
    result,
    category,
  });
}

function slaFor(urgency) {
  return (
    {
      critical: "respond within 4 business hours",
      high: "respond within 1 business day",
      medium: "respond within 3 business days",
      low: "respond within 5 business days",
    }[urgency] || "respond within 5 business days"
  );
}

function decision({ status, routeTo, action, questions, rationale, result, category }) {
  return {
    status,
    category,
    category_label: CATEGORIES[category].label,
    urgency: result.urgency,
    confidence: result.confidence,
    sla: slaFor(result.urgency),
    route_to: routeTo,
    recommended_next_action: action,
    clarifying_questions: questions,
    rationale,
    extracted: result.extracted,
  };
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : String(n));
