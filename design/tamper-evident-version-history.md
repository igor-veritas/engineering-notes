# How tamper-evident version history works in a decision ledger

Acta Ordia is a decision-ledger SaaS I built on Firebase (Firestore and Cloud Functions), currently pre-launch, with only test data. It records decisions that a group takes, such as meeting minutes with approvals. This note covers how the version history of a decision record is made tamper-evident, what the server-side state machine does, and what I decided against. The goal is tamper-evident, not tamper-proof, and the Limits section says where the difference matters.

## What is hashed and chained

Every saved version is one row. The row holds a body: the document content as JSON, a rendered HTML copy, the title, type, a snapshot of the proposer, approvers, responsible party and executor, and the deadline. The link hash is:

```ts
// synthetic example
function linkHash(body: VersionBody, prevHash: string | null): string {
  return sha256(stableStringify(body) + (prevHash ?? ""));
}
```

`stableStringify` is JSON with keys sorted recursively, so the same body produces the same bytes. It is not a standard canonicalization such as RFC 8785, which is acceptable while one codebase both writes and verifies. The hash is computed on the body before it is written, and verification recomputes it from the stored copy, so the body has to come back from Firestore unchanged. That rules out values Firestore stores differently from a JavaScript object, such as `undefined`, timestamps and integers versus doubles. Plain concatenation is unambiguous here because the JSON body always ends in `}` and the previous hash is a fixed 64 hex characters, although a separator and a hash-version prefix would be the more conventional design. The first row has a null `prevHash`.

Verification walks the rows in ordinal order. For each row it checks that `prevHash` equals the previous row's hash (the first row must have none), recomputes the hash from the body, and reports the first row where either check fails.

That is the original rule, version 1. New rows use version 2, which hashes one envelope with the body, the author id and name, the creation time (as integer milliseconds, because Firestore timestamps do not round-trip stably), the state, the reason, the decision id, the row's ordinal and, for a sealed row, the seal hash, who sealed it and when, under a domain prefix. Rows record which version they use, old rows keep verifying under the old rule, and a version 1 row after a version 2 row is rejected, since version 1 covers the body only and would be forgeable. Verification also checks that the first ordinal is 1, that ordinals are contiguous, that a row's stored decision id and ordinal match where it lives, and that the chain's tail agrees with the version count and head hash kept on the decision record (a chain shorter than the count, or a different tail hash, is a failure). The writer rejects text that Firestore might store differently from what was hashed, such as lone UTF-16 surrogates. Version 2 is live, and the chain holds only test data for now.

## How append-only is enforced

Clients cannot write version rows at all. The database rules deny every client create, update and delete:

```
// synthetic example
match /decisions/{id}/revisions/{rev} {
  allow read: if canRead(id);
  allow create, update, delete: if false;
}
```

The same deny-all applies to the transition log and to the decision document itself. All writes go through server code, which has admin privileges and bypasses these rules. So the rules keep clients out, and the server module is the only writer. A new version row is appended inside a transaction that first reads the latest row and takes its hash as `prevHash`. The version id comes from the ordinal and the row is written with a create-only write, so two concurrent appenders cannot both create the same version. A seal writes the version row, the transition-log row and an audit entry in one transaction.

Verification runs on demand through a Cloud Function, and a nightly job checks about 50 records starting from a random document id, which keeps the job's reads bounded and covers different records on different nights, though not all of them. Each run appends a result row to a server-only collection.

## What the state machine does

The state graph is a pure module with no database imports, mirrored on the frontend only for display. The server callable checks every transition against the graph, the actor's role and the approval quorum (unanimous, a count, or a percentage). Rejecting or amending requires a reason. Content is editable only in draft. Sealing computes a seal hash over the id, number, title, content, approvals and abstentions. The seal hash is stored on the decision record, is not part of the version chain, and verification does not recompute it. A sealed record is never edited. An amendment creates a successor.

## What I chose not to do

- **Rewrite old rows.** I stopped writing two older state names, but historical rows keep them. Version history is never migrated.
- **Anonymize identity on erasure.** I first planned to anonymize author names for GDPR and LGPD compliance. There is also a technical reason: names sit inside the hashed body, in the proposer, approver, responsible and executor snapshots, so rewriting them would change the body and break the chain. The legal side is my reading, not legal advice. GDPR Article 17(3)(b) and (e) exempt data needed to comply with a legal obligation or to establish or defend legal claims. LGPD Article 16 allows retention to meet a legal or regulatory obligation of the controller, and Article 7, VI covers processing for the regular exercise of rights in proceedings. Those exemptions apply only to the extent a real obligation or claim exists, and the customer is probably the controller, so whether their decision log qualifies depends on their own duties. On that reading I leave author names on version rows. If a record is used to show that a specific person had to do something and did not, replacing their name defeats it. Pseudonymizing with a separately held mapping is the alternative I would revisit.
- **Keep snapshot-restore as a rollback.** I removed the backup-restore feature. Rollback should be a new appended version plus an amendment, not an overwrite.
- **Harden an earlier pair of approve and reject functions in place.** They predated the state machine. I retired them and routed everything through it. Two implementations of one transition in different places drift apart, so I kept one.

## What it can prove

If a stored body or `prevHash` is changed without recomputing that row's hash and every later hash, the walk reports the first broken row. Inserting or deleting a row anywhere before the newest one also breaks a link. The claim is limited to this: the stored history is internally consistent, or it is not. A [runnable demo](../demos/version-chain/README.md) on the Firestore emulator shows which edits are caught and which are not, including the Firestore round-trip hazards above.

## Rolling it out

The two hash versions cannot be mixed safely. An old function that writes a version 1 row after version 2 rows would permanently fail the chain, and rows are append-only, so a deploy has to update every function at once. The plan is roll forward and never back.

The first deploy was refused by CI before it changed anything. The anchor trigger is the project's first function with retries enabled, and firebase-tools will not create one non-interactively without `--force`. I created that single function by hand and re-ran the full deploy, which then updated all 159 functions.

## Limits

- The rules bind clients only. Server code and anyone with project admin credentials bypass them. The hash is plain SHA-256, not a keyed MAC, so on the chain alone such a person could edit a row, recompute every later hash, and verification would pass. The external anchor below is what is meant to catch that. This is tamper-evident and not tamper-proof, and I designed against casual and accidental edits and against after-the-fact rewrites, not against someone who controls the whole project, which was outside my threat model. The anchor below narrows that gap but does not close it.
- The head hash is not anchored anywhere outside the database, so deleting the newest rows, or rewriting a body and every later hash, is not detected by the chain alone. To close that, a trigger writes each new row's hash as a create-only object to a Cloud Storage bucket, and verification compares the chain with those anchors, reporting a missing tail or a changed hash. The anchor key carries the hash version, so a chain rewritten wholesale as version 1 shows up as a mismatch. The result is one of ok, partial, mismatch, incomplete (the listing was truncated) or unverified (no anchors), so a chain with no anchors is never reported as ok. Without the anchor, a chain rewritten wholesale as version 1 would still verify, so the protection of the metadata depends on the anchor being configured. I plan to move to an RFC 3161 timestamp authority once there are real users.
- The anchor is only as strong as the identity that can touch the bucket. The bucket has a locked one-year retention policy, and the trigger runs as its own service account that can only create objects. That account matters less than the lock: every other function runs as an account with a broad project admin role, so bucket permissions cannot stop it from deleting anchors, and only a locked retention policy does, for the length of the period. That broad role dates from the start of the project; separate roles along the trust boundaries I have since decided are on my roadmap.
- Version 2 covers who saved a version, when, the state, the reason and the seal fields, but not every column on the row. The encryption metadata is deliberately outside the hash, because it is rewritten when keys rotate, and a flag recording that a seal came from a workflow is outside it too. Rows written before version 2 keep the old rule. Clients cannot write any of these fields, since clients are denied all writes, so a change would need server code or database access.
- Verification checks internal consistency only. It cannot tell a genuine history from one that was consistently rewritten. Under version 1 the decision id was not hashed, so a valid chain copied onto another decision would still verify. Version 2 binds it. The seal hash is still not recomputed by verification.
- The nightly job is a sample, so it is not a full audit. On-demand verification checks one record in full. The seal hash and the transition log are outside the chain. I intend to raise the sample size once volume grows, for example to a fixed fraction (30-40%) of actas instead of a fixed 50.
