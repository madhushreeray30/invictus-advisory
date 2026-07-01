# Invictus Advisory — AI Financial Triage Service

An AI-powered intake service for a **small-business financial advisory**. A first-time
user pastes a messy, free-text money problem; the service interprets it with an LLM,
assesses it, and returns a **structured triage result with a recommended next action
and a plain-English rationale**.

> Time spent: ~3 hours. Self-timed.

---

## The one-command run

No API key required — it ships with a deterministic mock mode.

```bash
npm install
npm run demo        # pushes 5 example cases through the full pipeline
```

To run it as a service:

```bash
npm start           # starts HTTP server on :3000
curl -s -X POST localhost:3000/triage \
  -H 'content-type: application/json' \
  -d '{"text":"I run a cafe and can'\''t make payroll this Friday, I'\''m £4k short."}' | jq
```

To use the real model instead of the mock, copy `.env.example` → `.env` and set
`ANTHROPIC_API_KEY`. The service auto-detects the key; with it, requests are served by
`claude-opus-4-8`, without it by the heuristic fallback. `GET /health` reports which.

---

## What it does (mapping to the brief)

| Requirement | Where |
|---|---|
| **Interpret** input with an LLM — classify + extract structured fields | `src/classify.js` calls Claude with a **forced tool call** (`src/schema.js` → `EXTRACTION_TOOL`) so the model must return typed JSON, not prose |
| **Assess** urgency, confidence, sufficiency of info | Model self-reports `urgency`, `confidence`, `has_enough_info`, `missing_information`; validated in `schema.js` |
| **Respond** with a structured result + recommended next action + rationale | `src/route.js` — a deterministic routing policy that maps the interpretation to an action, an SLA, and a rationale |
| **Handle hard cases gracefully** | See below — four distinct failure modes are handled |
| **Scaling note** | See below |

### Domain choice (a deliberate product decision)

I chose **SMB cashflow/financial advisory** over legal or generic operations. It has
crisp, mutually-exclusive categories (cashflow, tax, funding, receivables, cost
management) and strong natural **urgency signals** ("payroll Friday", "VAT due", "45
days overdue"), which makes routing *legible and defensible* rather than arbitrary. The
categories and routing policy live in one auditable place (`schema.js` + `route.js`).

### Key architectural decision: the LLM extracts, code decides

The model is **not** trusted to choose the route. It interprets the text into facts and
a self-assessment; a deterministic policy in `route.js` makes the actual routing call.
This means the routing rules are testable, auditable, and can't be argued out of a safe
decision by a persuasive or adversarial input.

---

## Handling an unreliable AI (the hard cases)

The service is built assuming the model *will* sometimes misbehave. Four cases:

1. **Malformed / out-of-schema model output.** A forced `tool_choice` guarantees the
   model *calls* the tool, but not that every field is valid. `schema.js:validate()`
   checks enums, ranges, and required fields. On failure we **retry once** with the
   errors, then **degrade to the heuristic** rather than return garbage.
2. **Low model confidence.** Below a `0.55` floor (`CONFIDENCE_FLOOR`), the request is
   routed to a **human** regardless of the predicted category. Cheaper to have a person
   confirm than to auto-route wrong.
3. **Missing information.** If the model reports `has_enough_info: false`, the service
   returns a `needs_more_info` state with the **specific questions to ask first**,
   instead of routing an under-specified request to an advisor.
4. **Provider down / rate-limited.** Any API failure (or repeated malformed output) is
   caught in `classify.js`; the service **degrades to the heuristic classifier** and
   flags the response with `meta.degraded: true` and `meta.source: "heuristic"`. The
   caller still gets a usable answer; the low fallback confidence naturally pushes
   borderline cases to a human.

> The heuristic fallback (`src/heuristic.js`) is the same code that powers mock mode, so
> the "LLM is down" path is exercised every time you run without a key.

---

## What I'd monitor / log in production

The service already emits **one structured JSON log line per request** (see
`server.js`). In production I'd ship these to a log pipeline and alert on:

- **`degraded` rate** — the single most important signal; a spike means the LLM provider
  is failing and traffic is silently falling back to the weaker heuristic.
- **`latency_ms`** (p50/p95/p99) — model latency and timeouts.
- **Category & status distribution** — a sudden jump in `low_confidence_review` or
  `other_needs_human` signals prompt drift, a bad model change, or a new kind of input.
- **Confidence histogram** — drift in the model's self-reported confidence over time.
- **Error / 5xx rate and validation-retry rate** — how often output fails the schema.
- **Cost per request** (input+output tokens × price) — see scaling note.

I would *not* log raw user financial text to general-purpose logs (PII/financial data);
I'd redact or store it in a separate, access-controlled store with retention limits.

---

## Scaling note — 10k requests/day

10k/day ≈ **7 requests/minute average**, with bursty peaks (Monday mornings, tax
deadlines). That volume is trivial for the Node process itself — **the design breaks at
the LLM call first**, in this order:

1. **First break: the LLM provider — latency, rate limits, cost.** Every `/triage` is a
   synchronous model call (~1–3s). Under a burst you hit provider rate limits and tail
   latency, and cost is now material (~10k × a ~600-token call/day).
   **What I'd change:**
   - **Cache** identical/near-identical inputs and add **prompt caching** for the fixed
     system prompt + tool schema (the stable prefix is the bulk of every request).
   - **Downshift the model**: this is a bounded classification task — `claude-haiku-4-5`
     or `claude-sonnet-5` would cut cost/latency dramatically with little accuracy loss.
     Reserve Opus for low-confidence re-checks only (a cheap-model-first, escalate-on-
     low-confidence cascade).
   - **Queue + async**: accept the request, return a ticket, process triage on a worker
     pool, and deliver the result via webhook/poll. This absorbs bursts and decouples
     user-facing latency from model latency.
   - Use the **Batch API** for anything not real-time (50% cheaper).
2. **Second break: the synchronous request model.** Express handling one blocking call
   per request wastes nothing CPU-wise but couples availability to the provider. The
   queue above fixes this; horizontally scale stateless workers behind it.
3. **Third break: observability & feedback.** At 10k/day you need the monitoring above
   plus a **human-review feedback loop** — capture advisor corrections on
   `low_confidence_review` cases and use them to tune the prompt/categories (or fine-tune
   a small model later).

### Self-host vs. hosted API

**Stay on the hosted API (Anthropic).** At 10k/day the economics and operational burden
of self-hosting an open model — GPUs, autoscaling, evals, safety, on-call — dwarf the
API bill, and a hosted frontier model gives better classification accuracy out of the
box. Self-hosting only becomes interesting at **much higher, steady volume** or under a
**hard data-residency/privacy requirement** that forbids sending financial text to a
third party. Even then I'd self-host a *small* classifier fine-tuned on our accumulated
triage data, not a general frontier model, and keep the hosted API as the escalation
tier for low-confidence cases.

---

## Project layout

```
src/
  schema.js     Domain: categories, extraction tool, validation, confidence floor
  heuristic.js  Deterministic keyword classifier (mock mode + provider-down fallback)
  classify.js   LLM call: forced tool use, validate, retry, degrade-to-heuristic
  route.js      Deterministic routing policy → action + SLA + rationale
  server.js     Express: POST /triage, GET /health, structured logging
test/
  demo.js       Runs 5 example cases through the pipeline (no key needed)
```
