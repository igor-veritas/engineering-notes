# Letting an LLM draft meeting minutes without trusting it

Acta Ordia is a decision-ledger app I'm building that has not launched. One feature turns a recorded meeting into a draft of the minutes. This note covers how I built it so the model's output can be audited, and where the controls are weaker than they look. I did not measure how accurate the drafts are, and nothing below says they are.

## The pipeline

A recording comes from a file upload or from a meeting bot that joins the call. Deepgram transcribes it with speaker labels, so the transcript arrives as numbered segments, each with a speaker cluster and timestamps. I send those segments to a Groq-hosted model (`openai/gpt-oss-120b` today) with a system prompt that asks for formal minutes in the user's language and for JSON only. The result is written into the acta as a draft that a person then edits and eventually seals.

All model calls run in Cloud Functions, never from the browser, behind App Check, a per-user rate limit and the plan's AI quota.

## Decisions that make the output auditable

**The model returns JSON and my code builds the HTML.** I first thought about asking the model to emit the HTML with provenance attributes inline. I did not, because a model that forgets or mangles one attribute leaves a block with no provenance, and I could not tell that from a block that never had it. The model returns blocks (`tag`, `kind`, `text` or `items`, `confidence`, an optional segment reference and speaker), and my code writes every attribute. The cost is a rigid schema: the model cannot express anything the schema doesn't have.

**Everything the model returns is checked against an allow-list.** Tags, block kinds and confidence values must be on a short list, and anything else falls back to a default (`p`, `context`, `medium`). Text is HTML-escaped and the whole result goes through the same sanitizer the PDF renderer uses. The transcript is untrusted input, since anyone in a meeting can say anything, so a spoken instruction can steer the model. The allow-list and the sanitizer limit what such an instruction can produce. They do not stop the model from writing a false sentence.

**Every block carries its provenance.** Each block gets the model name, a confidence value, the block kind, and a reference to the transcript segment and speaker it came from. A reader can tell which parts of an acta were machine-written and which transcript line supports them.

**The draft is also stored as immutable evidence, in the same transaction.** The first write of a draft puts the content into the acta and a separate "shadow draft" record with a SHA-256 of the content into the evidence collection, atomically. If a person later edits the acta, the original AI output is still there to compare against. I decided never to split these two writes, because a draft with no shadow copy would let the AI's contribution be rewritten without a trace. The one exception is deliberate: when someone redacts transcript text for a legal reason, the matching shadow draft's content is blanked while its hash and row stay, and a separate event records it.

## Metering a call that can fail

Each call spends the company's monthly AI allowance, and then prepaid credits. The charge is a transaction that happens before the model call, so concurrent requests cannot both pass a limit that only one of them fits under. Because the charge comes first, every failure after it needs a refund.

I fixed this for six AI callables in August (a failure after the charge left the user paying for nothing, and a retry paid twice). I then found that the draft callable had the same hole. It kept no record of its charge, so a Groq error, invalid JSON or a failed write all left the user charged, and the capture stayed retryable. I found it on 2026-11-06 by reading the code while writing this note. The fix keeps the reservation, wraps everything from the model call to the final write, and refunds on any failure. Four new tests cover a model error, invalid JSON, an incomplete draft and a failed write, and they fail on the old code. The six-callable fix was written three months earlier, and I never checked whether a seventh caller of the same API had the same hole. What I take from it is that a fix is not finished until I have listed every caller of the code path it touches.

## What this does not prove

- **The drafts' accuracy.** I have no benchmark for them. The prompt says to use only the transcript and never invent names, amounts or dates, and that is an instruction to the model, not something I check.
- **The confidence values.** The model reports its own confidence for each block. I have not compared those values to anything, so they are a hint to a reviewer and not a calibrated measure.
- **That a person reviewed each block.** Sealing checks that at least one provenance attribute survived in an AI-drafted acta. It does not check that every machine-written block was read.
- **Transcript quality.** Errors in the speech recognition or in speaker labels pass straight through. A mislabeled speaker becomes a wrongly attributed statement.
- **A real run at scale.** The pipeline is covered by unit tests with the model and Firestore mocked. The fix above was not run against Groq or the emulator.

## What I'd do next

Measure the drafts the way I measured the invoice pipeline: a small set of real meetings, hand-written reference minutes, and a count of decisions and actions the draft missed, merged or invented. Then compare the model's confidence values to those counts. Until then the honest description of this feature is a drafting aid with an audit trail, and not an accurate one by measurement.
