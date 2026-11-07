# Measuring an invoice-extraction pipeline, and the leak that fooled me

I'm building a tax-assistant app for Paraguay, currently pre-launch. This note is about the invoice-extraction pipeline in it and about how I almost misread my own benchmark. Everything here comes from an evaluation harness and the notes I kept while building it. The sample is small, and I say what that does and doesn't mean.

## The problem

The input is a phone photo of an invoice. The output is 14 structured fields: issuer and buyer taxpayer ids, issuer and buyer names, invoice number, date, authorization number (timbrado), payment condition, the total, and the taxable base and tax amount for each rate (10%, 5%, exempt). A wrong number in a tax app is worse than a blank, because a blank can be reviewed and a confident error will not be.

## The approach

Invoice photos reach a hosted vision model through a proxy I run, so users' images leave the device. The product discloses that processor and records acceptance of the terms and privacy policy at signup.

No single reader was good enough, so I fuse several, field by field:

- Local OCR, together with the extraction code the app already uses.
- A hosted vision LLM that reads the image directly.
- Two more local readers, a layout and table pipeline and a second OCR engine, used only to break ties.
- A public national taxpayer registry, checked after fusion to validate ids and names.

When the two main sources agree, the field is accepted. When they disagree, deterministic rules go first: a taxpayer-id checksum, arithmetic identities between the amount fields (for example, the tax on a base at the stated rate), and a check that buyer and seller differ. If a conflict is still unresolved, the LLM's answer wins.

I also tried the opposite policy, where an unresolved conflict becomes empty. Both policies run over the same stored source outputs, so the comparison is direct:

| Policy | Correct | Wrong value | Blank | Value on a field that has none | Pages fully correct |
|---|---|---|---|---|---|
| LLM wins on conflict (chosen) | 299 | 51 | 12 | 15 | 7 of 34 |
| Unresolved conflict left empty | 269 | 46 | 50 | 13 | 1 of 34 |

Leaving conflicts empty removes 7 confident errors (66 down to 59, counting values on fields that should be empty) and costs 30 correct answers and 38 more blanks. Most fields have no deterministic tiebreaker, so abstaining throws away the LLM's usually-correct answer along with the local reader's wrong one. If a confident error costs more than about 5.4 blanks (7 fewer errors against 38 more blanks), abstaining wins, and I have not decided what the real ratio is. I chose the first policy on plain accuracy, which counts a blank as wrong and so does not price an error above a blank, and added a confidence tag to each field so a reviewer can find the doubtful ones (the tags are covered below). When the two main sources agree they can still share an error, since both read the same photo, so agreement is evidence but not proof.

## How I evaluated

I labeled 34 real invoice pages by hand and scored every pipeline version against the same labels with one scoring script. Not every invoice carries every field, so 362 labeled values are scored, not 34 × 14. A second set contains 36 curated pages of printed invoices: 24 of the 34 pages, selected by excluding utility bills, money receipts and handwritten fill-ins, plus 12 pages I labeled later. It is easier by construction, and it overlaps the first set.

## The numbers

I re-ran all of this with the project's own scoring script. Re-running the fusion step reproduces the stored results exactly. Accuracy is exact matches over exact matches, wrong values and blanks on fields the label says exist. That is 362 values at 82.6% for the fused pipeline.

**Each source alone, and fused, on the 34 pages:**

| Source | Exact | Wrong | Blank | Accuracy |
|---|---|---|---|---|
| Local OCR plus the app's extraction code | 178 | 81 | 106 | 48.8% |
| Hosted vision LLM alone | 240 | 91 | 28 | 66.9% |
| Fused, with registry check (shipped in the eval, not in the app) | 299 | 51 | 12 | 82.6% |

The two tie-break readers alone score lower still, so fusion helps because the sources fail in different places. The LLM alone fully gets 2 of 34 pages right and the fused pipeline gets 7.

**What the headline excludes.** The scorer does not count 15 values the pipeline filled in on fields the label says are empty, and it counts 19 near-miss text fields (a name that contains the right one, or matches after stripping a trailing note) as neither right nor wrong. Counting all of them against the pipeline gives 299 of 396, or 75.5%. Both views are fair, and the second is closer to what a user would experience.

**By field**, exact matches out of values scored: issuer taxpayer id 32 of 34, buyer taxpayer id 20 of 23, authorization number 23 of 25, invoice number 26 of 30, payment condition 26 of 27, total 26 of 33, base at 10% 19 of 23, tax at 10% 16 of 23, the 5% and exempt amounts 22 of 22 each, date 18 of 29, issuer name 14 of 21, buyer name 13 of 27. The weak fields are names and dates, which are free text and handwriting, and the tax at 10%.

**Confidence tags.** Each field carries a high, medium or low tag. Scored values by tag:

| Tag | Values | Exact | Wrong | Filled on an empty field |
|---|---|---|---|---|
| High | 185 | 183 (98.9%) | 2 | 0 |
| Medium | 126 | 93 (73.8%) | 33 | 13 |
| Low | 39 | 23 (59.0%) | 16 | 2 |
| No value returned | 12 | 0 | 12 blanks | 0 |

Taking only high-confidence values would give 183 correct and 2 wrong of the 396 counted values, with no value filled in on a field that should be empty, and a person would review the rest. No page out of 34 had every field marked high, so a whole page is not auto-accepted yet. I wrote the tag rules while looking at these pages, so the table shows the tags separate good values from bad ones on development data, not that they will on new invoices.

**Curated 36-page printed set:** 89.4% field accuracy with 16 of 36 pages fully correct. These two figures come from my project notes and I did not recompute them. The effort started at about 45% on the 34 pages.

**Uncertainty.** 34 pages is too few to quote a rate with any precision. Wilson 95% intervals are about 78% to 86% for 299 of 362 fields (treating fields as independent), 10% to 37% for 7 of 34 pages, and 30% to 60% for 16 of 36 pages. Fields on one page are correlated, so the field-level interval is really wider. These pages are also not an untouched test set. I root-caused mismatches on them and fixed them with new rules, so they are development pages, and the 82.6% is optimistic about unseen invoices. The curated set grew from 24 to 36 pages when I labeled 12 more. A more lenient name comparison would move its page count from 16 to 19 of 36, but that is a labeling decision, not a pipeline improvement, so I did not count it.

## The leak

Before fusion, I tried fine-tuning the OCR model four times. The second attempt, trained on real pseudo-labeled pages, looked like a win at 78/168 fields. It wasn't. Four pages I believed were held out had leaked into training. The harness used one page-ID convention (`p3_16`) and the training data another (`p3-16`), so my exclusion list matched nothing. After the fix, every fine-tuned checkpoint scored below the stock model on the same pages with the same scorer. A later run at larger scale showed the same thing: 85/180 for stock against 65-75/180 for the fine-tuned checkpoints. A fourth attempt, trained only on verified lines, collapsed to 23-42/184. The denominators differ between runs because the sets differ, so these figures cannot be compared with each other, only each with its own stock baseline. My working hypothesis is that about 200 partially labeled real pages is too little data to fine-tune safely. I did not test that directly.

A check that the exclusion list matched at least one item would have caught the leak on the first run, and I now treat an exclusion list that matches nothing as an error. Splitting by page also would not catch the same vendor's invoices appearing on both sides, which inflates scores in a similar way.

## What I changed

A number only counts if it is scored against the stock baseline on the same pages. Every rule change gets a before-and-after diff of mismatches, and I accept it only with zero regressions, which on pages I also used to write the rules is a weak guard. I write down negative results, including that fine-tuning lost to the stock model.
