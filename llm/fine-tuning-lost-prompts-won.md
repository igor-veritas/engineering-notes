# Four fine-tuning attempts that lost, and what moved accuracy instead

This is the work behind the numbers in [the extraction-pipeline benchmark](measuring-an-extraction-pipeline.md): what I tried to improve invoice reading for a Paraguayan tax app that has not launched, and which attempts failed. The figures come from my project notes and the evaluation harness. I did not re-run them for this note. All of them were measured on the same 34 hand-labeled pages that I also used to find and fix mistakes, so they are development numbers and not a promise about unseen invoices.

## Fine-tuning the OCR model: four attempts, no win

I fine-tuned the recognition model of an open-source OCR engine (PaddleOCR's Latin mobile model) and scored every checkpoint against the stock model on real held-out pages.

1. **Synthetic data only.** A clear regression. I reverted it.
2. **Real pages with pseudo-labels.** It looked like a win until I found that four "held-out" pages had leaked into training. The leak is described in the benchmark note. After the fix every checkpoint scored below stock.
3. **More real labels and 269 verified line corrections, 191 training pages.** The same result at a larger scale: 85 of 180 fields for stock, 65 to 75 of 180 for every fine-tuned checkpoint.
4. **Only the 269 verified-correct lines, no bulk pseudo-labels.** It fell to 23 to 42 of 184, which is worse than the noisy version. The model lost general ability while it learned a few hundred lines.

My hypothesis is that about 200 partially labeled real pages is too little data to fine-tune a model of this size without either learning noise or forgetting. I did not test that directly, for example by labeling more pages. The denominators differ between runs because the page sets differ, so each result is only comparable to its own stock baseline.

I also tried the opposite direction: swapping in the larger server-tier model with no training. It scored 45% against 44% for the mobile model. So recognition capacity was never the bottleneck, and a bigger or better-trained reader was not going to fix what was going wrong.

## What was actually wrong: geometry in the extraction code

Looking at mismatches page by page, a pattern showed up. The app's extraction code finds a value by looking at the text near a label, for example the nearest line above the taxpayer id. That reasoning assumes the page is upright. 14 of the 34 pages were rotated by 90 or 270 degrees, and on those pages "above" in the image no longer means above on the page, so the code silently looked in the wrong place.

The fix was to thread an existing, unused upright-page check through the issuer-id and issuer-name extractors, and to measure which axis to search along on a rotated page. It is X, not Y. In one page the correct answer was 0.35 away from the anchor along Y and 0.005 away along X. The issuer taxpayer id went from 62% to 79% on the local pipeline alone, with no regression in a full before-and-after diff of mismatches. This was a bug in code I had written, and no amount of OCR training would have found it.

## Prompt wording moved more than anything else

The biggest single lever was the prompt to the hosted vision model, which I iterated four times and scored each version on the same pages:

- **v1 (56.5% alone).** 48 fields were invented. The pattern was systematic and not random: every electricity bill got made-up taxable-base and tax values, and every money receipt got a made-up authorization number and invoice number, on document types that do not have those fields.
- **v2 (54.2%).** I added instructions to transcribe only what is printed, never compute a field, and to separate "this field does not apply" from "this field is genuinely zero". Invented fields fell from 48 to 17. I accepted the small accuracy drop, because in a tax app an empty field gets reviewed and a wrong number does not.
- **v3.** Four independent pages showed that the labels treat the printed 10% column as already including tax, with the tax equal to that value divided by 11. The model was dividing by 1.1 because my prompt said "taxable base". Fixing that took the 10% base from 17% to 61%, and it broke the 5% fields (41% to 18% and 39% to 17%), because the model became too eager to return nothing.
- **v4 (66.9%).** I separated "the whole rate table is absent" (return nothing) from "the table exists and a column shows a real 0" (report 0). This kept the 10% gain and recovered the 5% fields, to 86% and 87%.

Rewording one prompt took the vision model from 54.2% to 66.9% alone, 12.7 points, at no extra cost per scan. None of the four fine-tuning runs gained anything, and I only measured the geometry fix on one field, so I can't rank them precisely. The v3 step is the one I'd point to: a fix that is right for one field can break its neighbours, and only a full re-score showed it.

## What it costs

The vision call costs about $0.0034 per scan, measured from the token counts in Groq's response: 3,083 input tokens (an image costs a fixed 2,048 whatever its size, plus about 1,035 for the prompt) and 226 output tokens. A user at 500 scans a month would cost about $1.69. That is the figure from one set of responses on one model at one time, and prices change.

Rate limits shaped the design more than price did. The free tier allowed roughly 8,000 tokens a minute and 200,000 a day per model, and I hit the daily limit routinely while testing. Even on a paid tier, bursts of scans will queue against some per-minute ceiling, so a scan has to be a background job and never a blocking call.

## A bug in shipped code that the harness found

Building the harness also found a real bug in the app. The function that validates a Paraguayan taxpayer id used a check-digit weight cycle of `[2,3,4,5,6,7]` repeated, where the real algorithm cycles `[2,3,4,5,6,7,8,9]`. I tested 12 real ids from my labeled pages against both: the old code rejected all 12 and the corrected one accepted all 12. The function gates id input in the app's settings, so real users entering their own valid id would often have been rejected. It had no test at all. I fixed it and added one.

## What I did not finish, and what this does not prove

- **Few-shot prompting has no result.** I tried showing the model one worked example. One page looked promising, but the full run got through 1 of 34 pages before both API keys hit their daily quota, and I moved on. A single page is an anecdote, so I'm not claiming any effect.
- **I never tested the "more data" explanation** for why fine-tuning lost, and I did not try fine-tuning a different model.
- **The prompt gains are tuned to these pages.** I wrote v3 and v4 after reading failures on them, so the gain on unseen invoices is probably smaller than the table suggests.
- **The per-field numbers are small samples.** Several fields are scored on 20 to 30 values, so a few values move a percentage a lot.
