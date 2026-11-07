# Tamper-evident version chain: runnable demo (hash v2 + external anchor)

A small demo of a hash-linked version chain stored in Firestore, and of exactly what it does and does not detect. All data is invented. It runs only against the Firestore emulator and refuses to start if `FIRESTORE_EMULATOR_HOST` is unset. It is an independent, simplified reimplementation of the design, not the real code.

Design (hash version 2): each row stores `body`, `authorId`, `authorName`, `createdAtMs` (integer milliseconds, never a Firestore Timestamp or Date), `state`, `reason` (absent or empty becomes `null`), `decisionId`, `ordinal`, `prevHash`, `hashVersion: 2`, and `sealHash`, `sealedBy`, `sealedAtMs` (`null` unless sealed). `hash = sha256("demo-chain/v2" + "\n" + stableStringify(envelope))`, where the envelope is exactly those fields and `stableStringify` is JSON with recursively sorted keys. The prefix and newline separate the domain from the payload. Rows are create-only, keyed by zero-padded ordinal (`decisions/demo-0/versions/000001`), appended in a transaction that reads the latest row.

`verifyChain` checks: contiguous ordinals; first row has null `prevHash`; each `prevHash` equals the previous row's hash; each hash recomputes (dispatching on the row's hash version; v1 rows still verify under the old body-only rule `sha256(stableStringify(body) + (prevHash ?? ""))`); for v2 rows the stored `decisionId` and `ordinal` match where the row lives; a v1 row after a v2 row is rejected as a downgrade.

External anchor: an in-process fake store standing in for a Cloud Storage bucket with a locked retention policy. Appending a row also writes a create-only entry keyed `decisionId/ordinal-hash` (a second create with the same key is refused). The store is not part of Firestore, and the tampering scenarios never touch it. The anchored verifier additionally reports an anchor whose ordinal is missing from the chain (tail deletion), an anchor whose hash differs from the row (rewrite), and, informationally, rows with no anchor (`unanchored`).

## Run

Versions used: Node v22.22.1, npm 9.2.0, firebase-tools 15.24.0, firebase-admin 13.10.0, OpenJDK 25.0.4.1 (needed by the emulator).

```sh
npm install
# terminal 1
firebase emulators:start --only firestore --project demo-chain
# terminal 2 (the emulator listened on 127.0.0.1:8080)
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node demo.mjs
```

The output below was produced with `NODE_NO_WARNINGS=1` set only to hide a Node `punycode` deprecation notice from a dependency. Without `FIRESTORE_EMULATOR_HOST` the script exits with code 2 and prints `Refusing to run: FIRESTORE_EMULATOR_HOST is not set (emulator only).` (checked). The emulator leaves `firestore-debug.log` in the directory; delete it (it is also in `.gitignore`).

## Output (verbatim, from the run on 2026-11-04)

```
[0 baseline]
    chain-only: OK (5 rows)
    anchored:   OK (5 rows, 0 unanchored)
    second create with the same anchor key refused: yes
[A edit body]
    chain-only: BROKEN at row 3: hash mismatch (v2)
    anchored:   BROKEN at row 3: hash mismatch (v2)
[B edit body + row hash]
    chain-only: BROKEN at row 4: prevHash mismatch
    anchored:   BROKEN at row 4: prevHash mismatch
[C edit + rehash all later]
    chain-only: OK (5 rows)
    anchored:   BROKEN at row 3: 3 anchor problem(s): anchor hash differs from row (rewrite)
[D delete newest row]
    chain-only: OK (4 rows)
    anchored:   BROKEN at row 5: 1 anchor problem(s): anchored ordinal missing from chain (tail deletion)
[E edit author name]
    chain-only: BROKEN at row 2: hash mismatch (v2)
    anchored:   BROKEN at row 2: hash mismatch (v2)
[E2 edit created time]
    chain-only: BROKEN at row 2: hash mismatch (v2)
    anchored:   BROKEN at row 2: hash mismatch (v2)
[F delete middle row]
    chain-only: BROKEN at row 4: non-contiguous ordinals
    anchored:   BROKEN at row 4: non-contiguous ordinals
[H copy v2 chain, other id]
    chain-only: BROKEN at row 1: row belongs to another decision
    anchored:   BROKEN at row 1: row belongs to another decision [5 unanchored]
[H' copy v1 chain, other id]
    chain-only: OK (3 rows)
    anchored:   OK (3 rows, 3 unanchored)
[I swap rows 2 and 3]
    chain-only: BROKEN at row 2: ordinal does not match row id
    anchored:   BROKEN at row 2: ordinal does not match row id
[I2 renumber row 5 to 7]
    chain-only: BROKEN at row 7: non-contiguous ordinals
    anchored:   BROKEN at row 7: non-contiguous ordinals [1 unanchored]
[J admin controls DB + anchors]
    chain-only: OK (5 rows)
    anchored:   OK (5 rows, 0 unanchored)
[K v1 row after v2 row]
    chain-only: BROKEN at row 6: downgrade: v1 row after a v2 row
    anchored:   BROKEN at row 6: downgrade: v1 row after a v2 row [1 unanchored]

[G] Firestore round trip (hash computed in memory before write vs. recomputed after read)
  undefined (default settings)             hash matches after read: n/a  write rejected: Value for argument "data" is not a valid Firestore document. Cannot us
  undefined (ignoreUndefinedProperties)    hash matches after read: NO   stored as {"a":1}
  Date -> Timestamp                        hash matches after read: NO   stored as {"a":1,"when":"Timestamp(1767323045)"}
  Timestamp value                          hash matches after read: yes  stored as {"a":1,"when":"Timestamp(1767323045)"}
  ISO string date                          hash matches after read: yes  stored as {"a":1,"when":"2026-01-02T03:04:05.000Z"}
  integer 5                                hash matches after read: yes  stored as {"n":5}
  double 5.0 (same JS number)              hash matches after read: yes  stored as {"n":5}
  double 0.1                               hash matches after read: yes  stored as {"n":0.1}
  big 2**53 + 2                            hash matches after read: yes  stored as {"n":9007199254740994}
  negative zero                            hash matches after read: yes  stored as {"n":0}
  v2 envelope, createdAtMs integer         hash matches after read: yes  stored as {"createdAtMs":1767323045123}
  v2 envelope, created as Date             hash matches after read: NO   stored as {"createdAtMs":"Timestamp(1767323045)"}
  v2 envelope, created as Timestamp        hash matches after read: yes  stored as {"createdAtMs":"Timestamp(1767323045)"}

scenario                           | chain exp   | chain actual   | anch exp    | anch actual    | match
-----------------------------------+-------------+----------------+-------------+----------------+------
0 baseline                         | OK          | OK             | OK          | OK             | yes  
A edit body                        | BROKEN @3   | BROKEN @3      | BROKEN @3   | BROKEN @3      | yes  
B edit body + row hash             | BROKEN @4   | BROKEN @4      | BROKEN @4   | BROKEN @4      | yes  
C edit + rehash all later          | OK          | OK             | BROKEN @3   | BROKEN @3      | yes  
D delete newest row                | OK          | OK             | BROKEN @5   | BROKEN @5      | yes  
E edit author name                 | BROKEN @2   | BROKEN @2      | BROKEN @2   | BROKEN @2      | yes  
E2 edit created time               | BROKEN @2   | BROKEN @2      | BROKEN @2   | BROKEN @2      | yes  
F delete middle row                | BROKEN @4   | BROKEN @4      | BROKEN @4   | BROKEN @4      | yes  
H copy v2 chain, other id          | BROKEN @1   | BROKEN @1      | BROKEN @1   | BROKEN @1      | yes  
H' copy v1 chain, other id         | OK          | OK             | OK          | OK             | yes  
I swap rows 2 and 3                | BROKEN @2   | BROKEN @2      | BROKEN @2   | BROKEN @2      | yes  
I2 renumber row 5 to 7             | BROKEN @7   | BROKEN @7      | BROKEN @7   | BROKEN @7      | yes  
J admin controls DB + anchors      | OK          | OK             | OK          | OK             | yes  
K v1 row after v2 row              | BROKEN @6   | BROKEN @6      | BROKEN @6   | BROKEN @6      | yes  

14/14 scenarios matched expectation
```

Expected values in the table were written into the script before running it. All 14 matched.

## Reading the results

- A, B, E, E2, F, H, I, I2, K are caught by the chain itself, so the anchored verifier agrees. A is caught at the edited row; B (body edited and that row's hash recomputed) one row later, via the next row's `prevHash`; F as a gap in ordinals.
- E and E2 are new: editing the author name or the stored created time now changes the envelope, so the hash no longer recomputes. Under v1 both were undetected.
- H: a v2 chain copied under another decision id fails because every row carries its `decisionId`, which is inside the hash. H' shows the contrast: a v1 chain copied the same way verifies as OK, because a v1 hash covers only the body and the previous hash, so v1 would not catch it. In H' the copy is also `unanchored`, which is informational and does not fail the check.
- I swaps the contents of rows 2 and 3 (caught: ordinal does not match where the row lives). I2 renumbers row 5 to 7 (caught: ordinals not contiguous).
- K: a v1 row appended after v2 rows, with a correctly computed v1 hash, is rejected as a downgrade. A v1 hash covers only the body, so accepting it would let metadata be forged on that row.
- C is caught only by the anchored verifier. Someone who edits a body and recomputes every later hash produces a chain that the chain-only verifier accepts (OK), but the anchors recorded at append time no longer match the rewritten hashes, so the anchored verifier reports BROKEN at row 3.
- D is likewise caught only by the anchored verifier: the chain-only verifier sees a shorter, consistent chain (OK, 4 rows); the anchored one finds an anchor for ordinal 5 with no row (tail deletion).
- J is NOT caught, and this is the limit: an actor who controls both Firestore and the anchor store can rewrite the rows and replace every anchor, and both verifiers say OK. The demo does this with an `adminWipe` method that a locked retention policy would forbid in reality, but the point stands for anyone who can control both places, or who can stop anchoring in the first place.

### Scenario G: Firestore round trip

Compared the hash computed on the in-memory value before writing with the hash recomputed from the value read back.

- `undefined` is a real hazard. By default the Admin SDK rejects the write. With `ignoreUndefinedProperties: true` the key is dropped on write, but `stableStringify` renders `undefined` as `null` while the read-back object has no key, so the hash does NOT match.
- A JS `Date` is a real hazard. It is stored as a Firestore Timestamp and read back as a `Timestamp` object, so the hash does NOT match. This is the reason v2 stores `createdAtMs` as an integer: the "v2 envelope, createdAtMs integer" line matches after the round trip, and the "created as Date" line does not.
- A `Timestamp` value matched, but only by accident: `stableStringify` hashes the SDK's private `_seconds`/`_nanoseconds` fields, which is fragile across SDK versions. Integers and ISO strings avoid the issue.
- Integer vs double showed no hazard with these types: in JavaScript `5` and `5.0` are the same number, `0.1` round-trips, `2**53 + 2` round-trips, and `-0` stringifies as `0` both ways. Non-JS clients, where an integer/double distinction could matter, are not exercised.

## What is still not caught

- **Someone who controls both the database and the anchor store (J).** Nothing in the chain or the anchors distinguishes a rewrite that replaced both. In reality a locked retention policy on the bucket forbids deleting or replacing anchors, which is the barrier this demo cannot show. That lock protects existing anchors only, not future anchoring: someone with full control can stop anchoring new rows (so they end up `unanchored`) and rewrite or truncate going forward.
- **Rows with no anchor.** `unanchored` is informational. A row that was never anchored, for any reason, is protected only by the chain, so a tail deletion or full rewrite of such rows behaves like C and D with no anchor to catch it.
- **v1 rows.** The hash covers only the body, so metadata on v1 rows stays forgeable (the old E result still applies to them), and a v1 chain copied elsewhere verifies (H'). The demo does not migrate or re-hash v1 rows.
- **Fields outside the envelope.** Anything stored on a row but not in the envelope can change without detection (the demo has no such fields; a real row may, for example encryption metadata).
- **Detection only when a verification runs.** Neither verifier prevents anything, and neither runs on its own.

## What this does not show

- Not the real code and no production data: this is an independent, simplified reimplementation of the described design with invented documents.
- The anchor store is a fake in-process map, not a bucket. A real bucket's retention lock is not exercised; create-only is enforced by my code, and the delete-and-recreate in J works only because the fake has an `adminWipe` that a real locked bucket would not offer.
- SHA-256 is unkeyed. Anyone who can read the algorithm can recompute a valid chain; the anchor, not a secret, is what catches C.
- Someone who controls both the database and the bucket defeats the whole scheme (J).
- Fields outside the envelope, such as encryption metadata, are not covered by the hash and are not tested.
- Emulator only: it says nothing about real Firestore security rules, IAM, or audit logging, which is where access control for these rows actually lives.
- No concurrency testing of the transactional append, and the anchor is written after the transaction commits rather than from a retried trigger, so a failed anchor write is not modelled.
