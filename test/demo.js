// Runnable demo: pushes a spread of cases through the pipeline and prints the
// triage decision for each. Works with OR without an API key.
//
//   npm run demo
//
// The cases are chosen to exercise every branch: a clear urgent case, a
// different category, a low-info case (missing-information state), and an
// off-topic / ambiguous case (should land on a human).

import "dotenv/config";
import { classify } from "../src/classify.js";
import { route } from "../src/route.js";

const CASES = [
  {
    name: "Urgent cashflow",
    text: "I run a small cafe and I don't think I can make payroll this Friday, I'm about £4,000 short. What do I do??",
  },
  {
    name: "Tax deadline",
    text: "My VAT return is due at the end of the month and I haven't done the bookkeeping, worried about a penalty.",
  },
  {
    name: "Late-paying customer",
    text: "A client owes me £12,000 on an invoice that was due 45 days ago and keeps ignoring my emails.",
  },
  {
    name: "Missing information (vague)",
    text: "money is tight, help",
  },
  {
    name: "Off-topic / ambiguous",
    text: "Can you recommend a good logo designer for my new packaging?",
  },
];

function line(char = "─") {
  return char.repeat(72);
}

const run = async () => {
  for (const c of CASES) {
    const { result, source, degraded, note } = await classify(c.text);
    const d = route(result);

    console.log(line());
    console.log(`▶ ${c.name}`);
    console.log(`  input:      "${c.text}"`);
    console.log(`  source:     ${source}${degraded ? " (DEGRADED fallback)" : ""}${note ? `  — ${note}` : ""}`);
    console.log(`  category:   ${d.category_label}  [${d.category}]`);
    console.log(`  status:     ${d.status}`);
    console.log(`  urgency:    ${d.urgency}   confidence: ${d.confidence}`);
    console.log(`  route to:   ${d.route_to}   (SLA: ${d.sla})`);
    console.log(`  next step:  ${d.recommended_next_action}`);
    if (d.clarifying_questions.length) {
      console.log(`  ask first:  ${d.clarifying_questions.join(" | ")}`);
    }
    console.log(`  rationale:  ${d.rationale}`);
  }
  console.log(line());
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
