// Domain definition for the advisory service.
//
// Decision: this is a *financial / cashflow* advisory triage service for small
// business owners. That domain was chosen deliberately — it has crisp, mutually
// exclusive categories and strong natural urgency signals (payroll due Friday,
// overdue tax, a bounced supplier payment), which makes routing legible and
// defensible rather than arbitrary.
//
// The categories, extracted fields, and routing policy all live here so the
// "what does good routing mean" decision is in one auditable place, separate
// from both the LLM call and the HTTP layer.

export const CATEGORIES = {
  cashflow_liquidity: {
    label: "Cashflow & liquidity",
    blurb: "Running low on cash, timing of money in vs. out, payroll/rent/supplier payments at risk.",
    routeTo: "cashflow_specialist",
  },
  tax_compliance: {
    label: "Tax & compliance",
    blurb: "VAT/sales tax, income/corporation tax, filing deadlines, penalties, bookkeeping for compliance.",
    routeTo: "tax_advisor",
  },
  funding_financing: {
    label: "Funding & financing",
    blurb: "Loans, overdrafts, lines of credit, grants, investor funding, debt refinancing.",
    routeTo: "financing_advisor",
  },
  invoicing_receivables: {
    label: "Invoicing & receivables",
    blurb: "Getting paid: late-paying customers, invoice disputes, chasing debt, payment terms.",
    routeTo: "receivables_specialist",
  },
  cost_management: {
    label: "Cost management",
    blurb: "Reducing spend, renegotiating contracts, subscription/overhead review, margins.",
    routeTo: "cost_analyst",
  },
  other_needs_human: {
    label: "Other / needs a human",
    blurb: "Doesn't fit a financial category, is out of scope, or is too ambiguous to route confidently.",
    routeTo: "human_triage",
  },
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);

export const URGENCY_LEVELS = ["low", "medium", "high", "critical"];

// The structured "shape" a human advisor would need extracted from the free text.
// This is passed to the LLM as a forced tool so the model must return JSON in
// this shape rather than prose. We still validate it ourselves (see validate())
// because a forced tool guarantees *a* tool call, not a *correct* one.
export const EXTRACTION_TOOL = {
  name: "record_triage",
  description:
    "Record the structured triage of a small-business owner's financial question. " +
    "Classify into exactly one category, extract the key fields a human advisor would need, " +
    "and assess urgency, confidence, and whether there is enough information to act.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: CATEGORY_KEYS,
        description: "The single best-fit category for the request.",
      },
      confidence: {
        type: "number",
        description:
          "Your confidence (0-1) that the category is correct AND the request is understood. " +
          "Be honest: use a low value for vague, contradictory, or off-topic input.",
      },
      urgency: {
        type: "string",
        enum: URGENCY_LEVELS,
        description:
          "How time-sensitive this is. critical = money/legal consequence within days " +
          "(payroll can't be met, tax deadline this week, account frozen); " +
          "high = within ~2 weeks; medium = this month; low = no hard deadline.",
      },
      has_enough_info: {
        type: "boolean",
        description: "True only if a human advisor could give a useful first answer from what was provided.",
      },
      missing_information: {
        type: "array",
        items: { type: "string" },
        description: "If has_enough_info is false, the specific facts you'd need to ask for. Empty otherwise.",
      },
      extracted: {
        type: "object",
        description: "Key structured fields pulled from the text. Use null for anything not stated.",
        properties: {
          summary: { type: "string", description: "One-sentence neutral restatement of the problem." },
          amount: { type: ["string", "null"], description: "Any money amount mentioned, verbatim (e.g. '£12,000')." },
          deadline: { type: ["string", "null"], description: "Any date/deadline mentioned, verbatim." },
          business_type: { type: ["string", "null"], description: "Trade/sector if stated (e.g. 'cafe', 'freelance designer')." },
          sentiment: {
            type: "string",
            enum: ["calm", "concerned", "stressed", "panicked"],
            description: "Emotional tone of the message.",
          },
        },
        required: ["summary", "amount", "deadline", "business_type", "sentiment"],
      },
    },
    required: ["category", "confidence", "urgency", "has_enough_info", "missing_information", "extracted"],
  },
};

// Confidence below this routes to a human regardless of predicted category.
export const CONFIDENCE_FLOOR = 0.55;

// Defensive validation of the model's tool call. A forced tool_choice guarantees
// the model *calls* the tool, but not that every field is present or in range —
// so we check here and let the caller decide whether to retry or fall back.
export function validate(input) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["not an object"] };

  if (!CATEGORY_KEYS.includes(input.category)) errors.push(`category '${input.category}' not in enum`);
  if (typeof input.confidence !== "number" || input.confidence < 0 || input.confidence > 1)
    errors.push(`confidence '${input.confidence}' not a 0-1 number`);
  if (!URGENCY_LEVELS.includes(input.urgency)) errors.push(`urgency '${input.urgency}' not in enum`);
  if (typeof input.has_enough_info !== "boolean") errors.push("has_enough_info not a boolean");
  if (!Array.isArray(input.missing_information)) errors.push("missing_information not an array");
  if (!input.extracted || typeof input.extracted !== "object") errors.push("extracted missing");
  else if (typeof input.extracted.summary !== "string" || !input.extracted.summary.trim())
    errors.push("extracted.summary missing");

  return { ok: errors.length === 0, errors };
}
