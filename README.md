# engineering-notes

A tamper-evident audit trail anchored outside the database. A Rust desktop signer that signs with your certificate without the server ever seeing the key, with 89 tests behind it. A privilege bug that let any user flip a paid-plan flag, reproduced and fixed. An invoice-extraction pipeline measured from 48.8% to 82.6% field accuracy on hand-labeled pages, where the fields it marks high confidence were right 183 times out of 185, and the benchmark leak I caught along the way. These are write-ups of what I built, what broke and how I found out, with much more to come.

I'm Igor José Soto Bondiman, a backend and security-minded software engineer, and I run my own company, Veritas Systems. I'm open to freelance and full-time work: igorbondiman@veritas-systems.tech

Every note says what it proves and what it doesn't. Where I haven't measured or tested something, I say "I don't know" instead of making something up.

## Why this exists

I have learned a lot throughout my career. I like to build things, and sometimes they break, and then I find out why and fix them. I would have loved to have had a mentor guiding me, so I'm writing down what I learned for whoever might read it, whether a recruiter, a client or another engineer. If any of it is useful to you, feel free to learn from my mistakes. The other reason is plain: nobody can know my work if I don't show it.

The notes so far come from my own two products, Acta Ordia (a decision-ledger app) and IvaFácil (a tax assistant for Paraguay), both pre-launch. Nothing here discloses client or employer details. If a note ever draws on work I did for someone else, I will keep it general and ask permission where needed. The signer's source is public: [acta-ordia-signer](https://github.com/Veritas-Systems-Tech/acta-ordia-signer).

## Where to start

The [column-grants reproduction](security/column-grants-vs-rls.md) (runnable) or the [tamper-evidence design](design/tamper-evident-version-history.md). Last updated November 2026.

## Entries

**Design**

- [How tamper-evident version history works in a decision ledger](design/tamper-evident-version-history.md): How an audit trail can show that records were edited, and where it stops.
- [A tamper-evident version chain you can run](demos/version-chain/README.md): A Firestore-emulator demo of the hash chain: 14 tamper scenarios, which ones the chain catches, which need the external anchor, and the one that nothing catches.
- [Signing on the user's machine so the private key never reaches my server](design/local-pki-signer.md): A desktop helper that signs documents with a Brazilian digital certificate without the server ever seeing the key.
- [What 89 tests on a local signer prove, and what they don't](design/what-the-signer-tests-prove.md): What the signer's test suite covers, group by group, and where it stops.

**Security**

- [RLS filters rows, not columns: a profile flag any user could flip](security/column-grants-vs-rls.md): Why row-level security alone left a paid-plan flag writable by any user, and how I proved and fixed it. Includes a [runnable reproduction](security/column-grants-vs-rls.sql).
- [Five authorization and concurrency patterns I found in my own multi-tenant Firebase app](security/firebase-audit-patterns.md): Access-control and race-condition mistakes in a multi-tenant app, and the fixes.
- [A fix that checked only its target, and grants that drifted back](security/grant-drift-and-fix-regressions.md): Why I stopped trusting "fixed" without a live check.

**LLM**

- [Measuring an invoice-extraction pipeline, and the leak that fooled me](llm/measuring-an-extraction-pipeline.md): A small benchmark, how accurate the fields are that the pipeline marks high confidence, and the data leak that made an earlier number meaningless.
- [Four fine-tuning attempts that lost, and what moved accuracy instead](llm/fine-tuning-lost-prompts-won.md): Why fine-tuning an OCR model failed four times, the geometry bug that was the real problem, and how prompt wording changed a vision model's accuracy.
- [Letting an LLM draft meeting minutes without trusting it](llm/letting-an-llm-draft-minutes.md): How a meeting-to-minutes feature keeps the model's output auditable, and the quota-refund hole I found in my own code.

## Also

[What I'm reading](reading.md)

## License

MIT
