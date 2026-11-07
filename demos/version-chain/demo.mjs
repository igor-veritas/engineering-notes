// Tamper-evident version chain demo (hash v2 + fake external anchor). Invented data only. Emulator only.
import { createHash } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error("Refusing to run: FIRESTORE_EMULATOR_HOST is not set (emulator only).");
  process.exit(2);
}
const PROJECT = "demo-chain";
const app = initializeApp({ projectId: PROJECT });
const db = getFirestore(app);

// ---- chain primitives -------------------------------------------------
function stableStringify(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  return "null";
}
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const pad = (n) => String(n).padStart(6, "0");
const versions = (docId) => db.collection("decisions").doc(docId).collection("versions");

// hash v1 (legacy, body only): kept frozen so old rows keep verifying
const linkHash = (body, prev) => sha256(stableStringify(body) + (prev ?? ""));

// hash v2: domain prefix + newline + canonical JSON of an envelope that covers metadata and position
const DOMAIN = "demo-chain/v2";
function envelopeOf(r) {
  return {
    body: r.body,
    authorId: r.authorId,
    authorName: r.authorName,
    createdAtMs: r.createdAtMs, // integer ms, never a Timestamp/Date
    state: r.state,
    reason: r.reason ? r.reason : null,
    decisionId: r.decisionId,
    ordinal: r.ordinal,
    prevHash: r.prevHash ?? null,
    hashVersion: 2,
    sealHash: r.sealHash ?? null,
    sealedBy: r.sealedBy ?? null,
    sealedAtMs: r.sealedAtMs ?? null,
  };
}
const v2Hash = (envelope) => sha256(DOMAIN + "\n" + stableStringify(envelope));

// ---- fake external anchor store ----------------------------------------
// Stands in for a Cloud Storage bucket with a locked retention policy. In-process, NOT Firestore.
// The real lock is not exercised: create-only is enforced here by code, and adminWipe() exists
// only so scenario J can show what happens if someone could bypass it.
class FakeAnchorStore {
  #m = new Map();
  create(key, value) {
    if (this.#m.has(key)) throw new Error(`anchor exists (create-only): ${key}`);
    this.#m.set(key, value);
  }
  list(prefix) {
    return [...this.#m.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, ...value }));
  }
  adminWipe(prefix) {
    for (const k of [...this.#m.keys()]) if (k.startsWith(prefix)) this.#m.delete(k);
  }
}
const anchors = new FakeAnchorStore();
const anchorKey = (decisionId, ordinal, hash) => `${decisionId}/${pad(ordinal)}-${hash}`;

async function append(docId, body, meta) {
  const col = versions(docId);
  const row = await db.runTransaction(async (tx) => {
    const latest = await tx.get(col.orderBy("ordinal", "desc").limit(1));
    const last = latest.empty ? null : latest.docs[0].data();
    const ordinal = last ? last.ordinal + 1 : 1;
    const r = {
      ordinal, decisionId: docId, body, prevHash: last ? last.hash : null,
      authorId: meta.authorId, authorName: meta.authorName, createdAtMs: Date.now(),
      state: meta.state, reason: meta.reason ?? null, hashVersion: 2,
      sealHash: meta.sealHash ?? null, sealedBy: meta.sealedBy ?? null, sealedAtMs: meta.sealedAtMs ?? null,
    };
    r.hash = v2Hash(envelopeOf(r));
    tx.create(col.doc(pad(ordinal)), r); // create-only
    return r;
  });
  // After commit (the real system does this from a create trigger): create-only anchor
  anchors.create(anchorKey(docId, row.ordinal, row.hash), { decisionId: docId, ordinal: row.ordinal, hash: row.hash });
  return row.ordinal;
}

// Legacy v1 writer (no hashVersion, no decisionId, no anchor), used for K and the H comparison
async function appendV1(docId, body, meta) {
  const col = versions(docId);
  return db.runTransaction(async (tx) => {
    const latest = await tx.get(col.orderBy("ordinal", "desc").limit(1));
    const last = latest.empty ? null : latest.docs[0].data();
    const ordinal = last ? last.ordinal + 1 : 1;
    const prevHash = last ? last.hash : null;
    tx.create(col.doc(pad(ordinal)), { ordinal, body, prevHash, hash: linkHash(body, prevHash), authorId: meta.authorId, authorName: meta.authorName, createdAtMs: Date.now(), state: meta.state, reason: meta.reason ?? null });
    return ordinal;
  });
}

const loadRows = async (docId) => (await versions(docId).orderBy("ordinal").get()).docs.map((d) => ({ id: d.id, ...d.data() }));

// Chain-only verifier. Checks: contiguous ordinals; first prevHash null; prevHash == previous hash;
// hash recomputes (per-row version dispatch); v2 rows: decisionId and ordinal match where the row lives;
// a v1 row after a v2 row is a downgrade and is rejected.
function verifyChain(docId, rows) {
  let prev = null;
  let seenV2 = false;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const bad = (why) => ({ ok: false, row: r.ordinal, why });
    if (i > 0 && r.ordinal !== prev.ordinal + 1) return bad("non-contiguous ordinals");
    if (i === 0 && (r.prevHash ?? null) !== null) return bad("first row prevHash not null");
    if (i > 0 && r.prevHash !== prev.hash) return bad("prevHash mismatch");
    if (r.hashVersion === undefined) {
      if (seenV2) return bad("downgrade: v1 row after a v2 row");
      if (linkHash(r.body, r.prevHash ?? null) !== r.hash) return bad("hash mismatch (v1)");
    } else if (r.hashVersion === 2) {
      seenV2 = true;
      if (r.decisionId !== docId) return bad("row belongs to another decision");
      if (r.id !== pad(r.ordinal)) return bad("ordinal does not match row id");
      if (v2Hash(envelopeOf(r)) !== r.hash) return bad("hash mismatch (v2)");
    } else return bad("unknown hashVersion");
    prev = r;
  }
  return { ok: true, rows: rows.length };
}

// Anchored verifier: chain result plus anchor comparison. Unanchored rows are informational only.
function verifyAnchored(docId, rows) {
  const chain = verifyChain(docId, rows);
  const byOrdinal = new Map(rows.map((r) => [r.ordinal, r]));
  const found = anchors.list(`${docId}/`);
  const problems = [];
  for (const a of found) {
    const r = byOrdinal.get(a.ordinal);
    if (!r) problems.push({ ordinal: a.ordinal, why: "anchored ordinal missing from chain (tail deletion)" });
    else if (r.hash !== a.hash) problems.push({ ordinal: a.ordinal, why: "anchor hash differs from row (rewrite)" });
  }
  problems.sort((x, y) => x.ordinal - y.ordinal);
  const anchoredOrdinals = new Set(found.map((a) => a.ordinal));
  const unanchored = rows.filter((r) => !anchoredOrdinals.has(r.ordinal)).length;
  if (!chain.ok) return { ok: false, row: chain.row, why: chain.why, unanchored, problems };
  if (problems.length) return { ok: false, row: problems[0].ordinal, why: `${problems.length} anchor problem(s): ${problems[0].why}`, unanchored, problems };
  return { ok: true, rows: rows.length, unanchored, problems };
}

// ---- helpers ------------------------------------------------------------
async function wipe(docId) {
  const s = await versions(docId).get();
  await Promise.all(s.docs.map((d) => d.ref.delete()));
}
const bodyOf = (i) => ({ title: "Adopt queue-based retries", text: `Draft revision ${i}`, tags: ["demo", `r${i}`], nested: { b: i, a: [1, 2] } });
async function fresh(docId) {
  await wipe(docId);
  for (let i = 1; i <= 5; i++) {
    const sealed = i === 5;
    await append(docId, bodyOf(i), {
      authorId: "u-alice", authorName: "Alice Example", state: sealed ? "final" : "draft", reason: `edit ${i}`,
      ...(sealed ? { sealHash: sha256("demo-seal"), sealedBy: "u-alice", sealedAtMs: Date.now() } : {}),
    });
  }
}
async function freshV1(docId, n) {
  await wipe(docId);
  for (let i = 1; i <= n; i++) await appendV1(docId, bodyOf(i), { authorId: "u-alice", authorName: "Alice Example", state: "draft", reason: `edit ${i}` });
}
const ref = (docId, n) => versions(docId).doc(pad(n));
const fmt = (v) => (v.ok ? "OK" : `BROKEN @${v.row}`);
const detail = (v) => (v.ok ? `OK (${v.rows} rows${v.unanchored !== undefined ? `, ${v.unanchored} unanchored` : ""})` : `BROKEN at row ${v.row}: ${v.why}${v.unanchored ? ` [${v.unanchored} unanchored]` : ""}`);
const results = [];
// check(): runs both verifiers on the current Firestore state; the anchor store is never touched by tampering
async function check(name, docId, expChain, expAnch) {
  const rows = await loadRows(docId);
  const c = verifyChain(docId, rows);
  const a = verifyAnchored(docId, rows);
  results.push({ name, expChain, actChain: fmt(c), expAnch, actAnch: fmt(a), match: fmt(c) === expChain && fmt(a) === expAnch });
  console.log(`[${name}]\n    chain-only: ${detail(c)}\n    anchored:   ${detail(a)}`);
}

// ---- scenarios ---------------------------------------------------------
await fresh("demo-0");
await check("0 baseline", "demo-0", "OK", "OK");
{
  const key = anchors.list("demo-0/")[0].key;
  let refused = false;
  try { anchors.create(key, {}); } catch { refused = true; }
  console.log(`    second create with the same anchor key refused: ${refused ? "yes" : "NO"}`);
}

await fresh("demo-A");
await ref("demo-A", 3).update({ "body.text": "TAMPERED" });
await check("A edit body", "demo-A", "BROKEN @3", "BROKEN @3");

await fresh("demo-B");
{
  const r = (await ref("demo-B", 3).get()).data();
  const body = { ...r.body, text: "TAMPERED" };
  await ref("demo-B", 3).update({ body, hash: v2Hash(envelopeOf({ ...r, body })) });
}
await check("B edit body + row hash", "demo-B", "BROKEN @4", "BROKEN @4");

await fresh("demo-C");
{
  const rows = await loadRows("demo-C");
  let prev = null;
  for (const r of rows) {
    const next = { ...r, prevHash: prev, body: r.ordinal === 3 ? { ...r.body, text: "TAMPERED" } : r.body };
    next.hash = v2Hash(envelopeOf(next));
    await ref("demo-C", r.ordinal).update({ body: next.body, prevHash: prev, hash: next.hash });
    prev = next.hash;
  }
}
await check("C edit + rehash all later", "demo-C", "OK", "BROKEN @3");

await fresh("demo-D");
await ref("demo-D", 5).delete();
await check("D delete newest row", "demo-D", "OK", "BROKEN @5");

await fresh("demo-E");
await ref("demo-E", 2).update({ authorName: "Mallory Example" });
await check("E edit author name", "demo-E", "BROKEN @2", "BROKEN @2");

await fresh("demo-E2");
await ref("demo-E2", 2).update({ createdAtMs: (await ref("demo-E2", 2).get()).data().createdAtMs + 86_400_000 });
await check("E2 edit created time", "demo-E2", "BROKEN @2", "BROKEN @2");

await fresh("demo-F");
await ref("demo-F", 3).delete();
await check("F delete middle row", "demo-F", "BROKEN @4", "BROKEN @4");

await fresh("demo-H-src");
await wipe("demo-H-copy");
for (const r of await loadRows("demo-H-src")) {
  const { id, ...data } = r;
  await ref("demo-H-copy", r.ordinal).set(data);
}
await check("H copy v2 chain, other id", "demo-H-copy", "BROKEN @1", "BROKEN @1");

await freshV1("demo-H1-src", 3);
await wipe("demo-H1-copy");
for (const r of await loadRows("demo-H1-src")) {
  const { id, ...data } = r;
  await ref("demo-H1-copy", r.ordinal).set(data);
}
await check("H' copy v1 chain, other id", "demo-H1-copy", "OK", "OK");

await fresh("demo-I");
{
  const a = (await ref("demo-I", 2).get()).data();
  const b = (await ref("demo-I", 3).get()).data();
  await ref("demo-I", 2).set(b);
  await ref("demo-I", 3).set(a);
}
await check("I swap rows 2 and 3", "demo-I", "BROKEN @2", "BROKEN @2");

await fresh("demo-I2");
await ref("demo-I2", 5).update({ ordinal: 7 });
await check("I2 renumber row 5 to 7", "demo-I2", "BROKEN @7", "BROKEN @7");

await fresh("demo-J");
{
  const rows = await loadRows("demo-J");
  let prev = null;
  for (const r of rows) {
    const next = { ...r, prevHash: prev, body: r.ordinal === 3 ? { ...r.body, text: "TAMPERED" } : r.body, authorName: r.ordinal === 3 ? "Mallory Example" : r.authorName };
    next.hash = v2Hash(envelopeOf(next));
    await ref("demo-J", r.ordinal).update({ body: next.body, authorName: next.authorName, prevHash: prev, hash: next.hash });
    prev = next.hash;
  }
  // Whoever also controls the anchor store deletes and recreates every anchor (a locked retention policy forbids this in reality)
  anchors.adminWipe("demo-J/");
  for (const r of await loadRows("demo-J")) anchors.create(anchorKey("demo-J", r.ordinal, r.hash), { decisionId: "demo-J", ordinal: r.ordinal, hash: r.hash });
}
await check("J admin controls DB + anchors", "demo-J", "OK", "OK");

await fresh("demo-K");
{
  const last = (await ref("demo-K", 5).get()).data();
  const body = bodyOf(6);
  await ref("demo-K", 6).set({ ordinal: 6, body, prevHash: last.hash, hash: linkHash(body, last.hash), authorId: "u-alice", authorName: "Alice Example", createdAtMs: Date.now(), state: "draft", reason: "forged v1" });
}
await check("K v1 row after v2 row", "demo-K", "BROKEN @6", "BROKEN @6");

// ---- G: Firestore round trip ----------------------------------------
console.log("\n[G] Firestore round trip (hash computed in memory before write vs. recomputed after read)");
const appLenient = initializeApp({ projectId: PROJECT }, "lenient");
const dbLenient = getFirestore(appLenient);
dbLenient.settings({ ignoreUndefinedProperties: true });

async function roundTrip(label, firestore, body, hashFn = (b) => linkHash(b, null)) {
  const col = firestore.collection("roundtrip");
  const id = label.replace(/\W+/g, "-");
  const before = hashFn(body);
  try {
    await col.doc(id).set({ body });
  } catch (e) {
    return { label, outcome: `write rejected: ${String(e.message).split("\n")[0].slice(0, 70)}`, match: "n/a" };
  }
  const back = (await col.doc(id).get()).data().body;
  const after = hashFn(back);
  return { label, outcome: `stored as ${JSON.stringify(back.createdAtMs !== undefined ? { createdAtMs: back.createdAtMs } : back, (k, v) => (v && v._seconds !== undefined ? `Timestamp(${v._seconds})` : v))}`, match: before === after ? "yes" : "NO" };
}
const g = [];
g.push(await roundTrip("undefined (default settings)", db, { a: 1, b: undefined }));
g.push(await roundTrip("undefined (ignoreUndefinedProperties)", dbLenient, { a: 1, b: undefined }));
g.push(await roundTrip("Date -> Timestamp", db, { a: 1, when: new Date("2026-01-02T03:04:05.000Z") }));
g.push(await roundTrip("Timestamp value", db, { a: 1, when: Timestamp.fromMillis(1767323045000) }));
g.push(await roundTrip("ISO string date", db, { a: 1, when: "2026-01-02T03:04:05.000Z" }));
g.push(await roundTrip("integer 5", db, { n: 5 }));
g.push(await roundTrip("double 5.0 (same JS number)", db, { n: 5.0 }));
g.push(await roundTrip("double 0.1", db, { n: 0.1 }));
g.push(await roundTrip("big 2**53 + 2", db, { n: 2 ** 53 + 2 }));
g.push(await roundTrip("negative zero", db, { n: -0 }));
{
  const base = { body: bodyOf(1), authorId: "u-alice", authorName: "Alice Example", state: "draft", reason: "edit 1", decisionId: "demo-G", ordinal: 1, prevHash: null, hashVersion: 2, sealHash: null, sealedBy: null, sealedAtMs: null };
  const h2 = (e) => v2Hash(e);
  g.push(await roundTrip("v2 envelope, createdAtMs integer", db, { ...base, createdAtMs: 1767323045123 }, h2));
  g.push(await roundTrip("v2 envelope, created as Date", db, { ...base, createdAtMs: new Date(1767323045123) }, h2));
  g.push(await roundTrip("v2 envelope, created as Timestamp", db, { ...base, createdAtMs: Timestamp.fromMillis(1767323045123) }, h2));
}
for (const r of g) console.log(`  ${r.label.padEnd(40)} hash matches after read: ${String(r.match).padEnd(4)} ${r.outcome}`);

// ---- table ---------------------------------------------------------------
const w = [34, 11, 14, 11, 14, 5];
const row = (a) => a.map((c, i) => String(c).padEnd(w[i])).join(" | ");
console.log("\n" + row(["scenario", "chain exp", "chain actual", "anch exp", "anch actual", "match"]));
console.log(w.map((n) => "-".repeat(n)).join("-+-"));
for (const r of results) console.log(row([r.name, r.expChain, r.actChain, r.expAnch, r.actAnch, r.match ? "yes" : "NO"]));
console.log(`\n${results.filter((r) => r.match).length}/${results.length} scenarios matched expectation`);
process.exit(0);
