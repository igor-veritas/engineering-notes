# Five authorization and concurrency patterns I found in my own multi-tenant Firebase app

These come from two security reviews of Acta Ordia, my multi-tenant SaaS on Firebase (Firestore rules plus Cloud Functions), which has not launched yet. I ran a full-codebase review in May 2026 and a deeper one in July 2026 that produced 20 numbered findings  and I reproduced each against the running system. Each pattern below is fixed. This note shows the patterns and the fixes, not exact locations.

## 1. A role check that fails open

My Firestore rule for "is this user a writer in this workspace" had a backward-compatibility branch: if the workspace document had no writer index field, every member counted as a writer. The branch predated the read-only member role, so it silently gave members read access to content meant for writers.

The backend was correct. Creating content as a member failed with a proper permission error, and the frontend had a matching fallback that only affected which buttons showed. I found it by creating a real member-role user and clicking through the app. This one came from my own live testing, and reading the code had not turned it up.

The same review found the sibling bug in several backend functions: the gate was a blocklist (`if role == "member" deny`), so any other value, including a missing or mistyped one, passed as writer.

```
// synthetic example; ws is the workspace document's data, and the caller is already a member
// fails open: a workspace with no editor index treats every member as an editor
allow read: if isMember(ws, uid) && (!("editorIds" in ws) || uid in ws.editorIds);
// fails closed
allow read: if isMember(ws, uid) && uid in ws.get("editorIds", []);
```

The fix was to backfill the missing field, flip the rule to fail closed, and route every call site through one allowlist helper. I also fixed the invite path that kept the index incomplete. A regression test runs against the Firestore emulator.

## 2. Trusting a cached field as proof of membership

Three read rules compared a document against a company id stored on the user document, a field that was only meant as a signup default. Nothing cleared it when a user left a company, so a user who moved to another company kept reading their old company's billing document, and current colleagues could read the profile of someone who had already left.

It was easy to miss because the rule's own comment said "checked against membership" and the field name looks authoritative. I confirmed it by tracing every write path to that field and finding that none ever cleared it.

The fix was to re-check live membership in each rule. I also deleted the helper that read the stale field, since leaving it in place invited the same mistake. The backend functions did not have this problem: they derive the tenant from the target resource and then verify membership against that, which is the correct order.

## 3. Check-then-increment on quota

The AI quota check and the usage increment were two separate steps, so concurrent requests could all pass the check. Transcription had a related double-tap problem: two requests could process and bill twice.

The fix was to reserve quota inside a transaction before the provider call, and to claim a persisted request key up front so a duplicate request is rejected. If the call fails afterward, the reservation is rolled back. A later pass found that rollback was missing on some failure paths, and I fixed that too.

## 4. Redelivery handled with a processing lease

A pipeline triggered by a third-party webhook was not idempotent when the trigger was redelivered, so the same work could run twice. Separately, my payment webhook deduplicated on a hash of the raw request body, after verifying the request's HMAC signature. The payment provider (LemonSqueezy) documents no per-delivery event id, so a retry serialized slightly differently would have bypassed the dedup and could have credited a top-up twice.

For the pipeline I added a transactional processing lease with an expiry time: the first delivery takes it inside a transaction, and later deliveries see an unexpired lease, or a record already in a finished state, and stop. If the first delivery crashes, the lease expires and a redelivery can take over. For the webhook I keyed one-shot order events on the event name plus the order id, which I judged safe because I treat an order as a one-shot object. Subscription events keep the body hash, because a subscription id recurs across real lifecycle events and keying on it would drop genuine state changes.

The webhook also had no protection against out-of-order delivery: the subscription handlers overwrote state unconditionally, so a late older event could replace newer state. I considered a queue for ordering, found that the managed task queue only orders on a best-effort basis, and shipped a smaller guard instead. A transaction compares the provider's own last-updated timestamp on the incoming event with the stored one and ignores strictly older events. Equal timestamps are processed, and an event with no usable timestamp is processed as before, since being unable to compare is not evidence that an event is stale. That is a fail-open path, and I accepted it only because the request is signed.

## 5. Stale writes and the same shape elsewhere

Two editors could both pass a staleness check and overwrite each other. I fixed this with a revision token re-checked inside the final write transaction. Other write paths with the same gap got the same treatment.

The common shape across the review: stop trusting a client-supplied value, move the authoritative check inside a transaction, and fail closed on mismatch. The quota reservation, the processing lease and the revision token each became a reusable primitive instead of a one-off patch.

## What changed in my process

Fixed findings get a short decision record, and a written rule says a missing field must deny and never widen access. Role checks go through one allowlist helper. Each review gets a follow-up pass scoped to a different bug class than the one just found, and I test as a real low-privilege user in the running app, which is how pattern 1 turned up.
