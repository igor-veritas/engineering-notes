# Signing on the user's machine so the private key never reaches my server

*Design note for [`acta-ordia-signer`](https://github.com/Veritas-Systems-Tech/acta-ordia-signer), the local signer for Acta Ordia, my decision-ledger product. Status: implemented and covered by 89 automated tests, which use a self-signed certificate as a stand-in. It has not been run against a real ICP-Brasil certificate. The tagged-message change shipped as v0.3.0 together with the matching backend, because the new signer rejects the old digest-only requests and there is no compatibility mode.*

## What ICP-Brasil and A1 are

ICP-Brasil is Brazil's public-key infrastructure: accredited authorities issue digital certificates to people and companies. An A1 certificate is one of those certificates delivered as a password-protected file (`.p12` or `.pfx`) that lives on the owner's computer.

## Why the key must not be uploaded

The private key inside that file is the identity. Whoever holds it and the password can sign as that person. I decided early that my backend would never hold users' signing keys, so that a breach of my server cannot exfiltrate them, and because I did not want that trust relationship at all. So the backend never receives the key or the password, and the design keeps them on the user's machine. The signer is a small open-source desktop app (Rust and Tauri), so anyone can read what touches that material.

## Why a local signer at all

I needed ICP-Brasil signing and had three options: pay a third-party signer (not viable for a product that had not launched), send users to a service like DocuSign (breaks the in-app flow and adds friction), or build a helper that uses the user's own certificate. I built the helper. I used Tauri for the local window and the packaging, so I did not have to write native UI for each operating system. A3 hardware tokens are deferred. The same protocol would apply with a different local key source.

## Why Tauri and Rust

The signer has to open a password-protected certificate file and use the private key inside it on the user's own machine, so I wanted a language that works close to the system and can handle certificates properly. Rust is a good fit for that. Other languages could have done the job, but Tauri's backend is written in Rust, so choosing Tauri meant the window, the packaging and the signing code are all one language, and that was far easier than bridging two.

Tauri and Rust together are also lightweight and efficient, which suits a small helper that sits in the tray and should cost the user almost nothing. They give me direct control over memory too. A Python helper with Tkinter, for example, would have been easier to write, but it would be heavier to ship and run, and I would not have the same control over memory. The price of what I chose is that I have to know what I am doing. Rust's compiler catches a lot, but it does not stop me from leaking memory or from keeping sensitive data alive longer than I meant to, and that matters more in a program that holds an unlocked private key. In a language with a garbage collector some of that would be handled for me. Here I have to handle it myself.

Tauri also comes with its own auto-updater, which saved me a lot of time. I did not have to build update delivery and signing of the updates myself, and a security tool that users never update is a problem of its own.

Two reasons are personal. I like Rust, and I wanted a real project in it to learn it properly. And I come from a background in C and C++, so a systems language felt familiar from the start.

## How the work is divided

PAdES signatures do not sign the document's hash directly. They sign a small structure of signed attributes. It typically holds the content type, the document hash, a reference to the signer's certificate and, under ICP-Brasil policies, a signature-policy identifier. The certificate reference is why the backend needs the certificate chain before it can build the structure, and it also ties each digest to one certificate. The signer has to be handed the hash of that exact structure, not of the PDF.

1. The backend freezes the document and opens a short-lived signing session.
2. The web app asks the signer, on localhost, to prepare. The user picks a `.p12` and types the password into a small local window. The signer shows a confirmation with the document title and the identity about to sign, keeps the unlocked key in memory only, and returns just the public certificate chain.
3. The web app sends that chain to the backend. The backend builds the signed attributes and returns their SHA-256 digest, plus an Ed25519 signature over a tagged message that contains the digest (layout below).
4. The web app passes the digest and that signature to the signer. The signer rebuilds the tagged message from the fields it received and checks the Ed25519 signature against a public key compiled into it. It also rejects an expired message and one whose certificate fingerprint differs from the certificate the user unlocked. Only then does it sign the digest with the user's key, drop the key, and return the signature bytes.
5. The backend inserts that signature into the CMS structure and builds the final PAdES signature in the PDF.

The signer only ever receives a digest of the PDF, and the backend never receives the key or the password.

```text
signer.sign(session_id, fingerprint, expires_at, digest, backend_sig):
    msg = prefix("acta-ordia-signer/v1") || session_id || fingerprint || expires_at || digest
    if !ed25519_verify(EMBEDDED_PUBLIC_KEY, msg, backend_sig): reject
    if now > expires_at + 60s: reject
    if fingerprint != sha256(unlocked_leaf_cert): reject
    out = rsa_sign(unlocked_key, digest_info(sha256, digest))   # RSA, PKCS#1 v1.5; ECDSA certificates are not handled
    evict(unlocked_key)
    return out
```

An Origin check stops malicious web pages, because browsers cannot spoof it. It does not stop other programs on the machine, which can call a localhost port and set any header they like. Without the signature check, the signer would sign whatever digest it was handed, which makes it a signing oracle for any local program. Forging the backend's signature needs the backend's private key.

The signed message uses length-prefixed fields so no two different inputs encode to the same bytes: the domain prefix with its version, the session id, the SHA-256 of the leaf certificate, an expiry in unix seconds, and the digest. The backend sets the expiry to two minutes, and the signer allows 60 seconds of clock skew.

## What the server checks

`verifyPkiSignature` checks that the signature is consistent with the exact signed bytes, so tampering is detected. It also checks the certificate chain against a bundled snapshot (taken 2026-10-29) of 181 certificates published by ITI, the federal agency that operates the ICP-Brasil root authority. When signing is prepared, the backend also checks that the certificate is inside its validity period; the signing time itself is asserted by the backend. It does not check revocation (OCSP or CRL), key usage, or certificate policy, and the bundle does not refresh itself. Because of the missing checks, the UI says "Signature valid" and not "Verified".

## Limits

- Never run against a real ICP-Brasil certificate or a real signing session. I do not know that the backend accepts what the signer produces. The mechanism was tested with a self-signed certificate standing in for a real one.
- What you see is not fully what you sign. The signer shows the document title and the certificate identity, and it never sees the PDF. The title is supplied by whoever calls the local API and is not covered by the Ed25519 signature, so the dialog is not authenticated against the backend. The check proves the digest came from my backend, not that the user meant to sign it. A compromised backend could get a signature on any digest it chose, so the user still has to trust my backend for what is being signed. I intend to design this properly, so that the user does not have to trust the backend blindly: for example by letting the signer see the PDF itself, or by some other means that lets it check what it is about to sign.
- The signed message binds the digest to a session id, a certificate and an expiry, so a captured pair cannot be used with another certificate and goes stale after about three minutes. It has no nonce, so within that window the signer would sign the same digest twice if a local program replayed it while the key is unlocked. The signer does not know the session is still open on the backend, and it relies on its local clock for expiry. The public key is compiled into the signer, so rotating the backend key means shipping a new signer release. The protocol changed incompatibly when I added this, so signer and backend must be updated in order, and a version field makes a new signer refuse an old backend with a clear error. The fingerprint check at the unlock step is covered by unit tests only, not by a run with a real certificate.
- No GUI click-through on macOS or Windows. Builds and headless tests run in CI on all three.
- No revocation checking, no signature timestamp and no revocation evidence, so validity after the certificate expires cannot be demonstrated, and builds are not signed with an OS code-signing certificate, because that certificate costs money and the product has not launched.
- The key is held in memory and never written to disk by the app. I make no claim about swap or memory dumps, and malware on the user's machine that can read the `.p12` and capture the password defeats the design.
- I make no claim about the legal validity of any signature it produces.
- Crash reporting to a separate Sentry project is on by default, with a tray-menu switch to turn it off, a line about it in the first-run notification, and a README section. Handled errors send only static error codes, never error text, passphrases, certificate bytes or document titles. Panics are reported automatically with a backtrace. Before anything is sent, the machine's hostname is dropped and the panic message is replaced by a fixed string, because a forced-panic check showed that Sentry attaches the hostname on its own even with default personal data off, and a panic message goes out verbatim. I ran that check with a small program built on the same Sentry crate and settings, not by running the signer itself. Reports still carry the operating system and kernel version, the CPU architecture and the Rust version. A panic during the short start-up window before the saved preference loads would report even for a user who had opted out. I accept that because the window is very small, though I have not measured it. Repeated invalid-signature events are limited to one report per ten minutes. Default-on is a choice I made, and an opt-in default would be the more conservative one.
