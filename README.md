# ProofOfContribution — farming-resistant developer reputation

**Contract:** [**`0xc52A69cBeb9666648e39ad083b1135610b63928D`**](https://explorer-bradbury.genlayer.com/address/0xc52A69cBeb9666648e39ad083b1135610b63928D) on GenLayer Bradbury Testnet (chain 4221)
**Deployed size:** 15,678 bytes — identical to `contracts/proof_of_contribution.py` in this repo.

Developers earn non-transferable on-chain reputation from work an AI validator
committee actually reads. Reputation is keyed to the developer's own address, so
it cannot be transferred.

---

## The rejection this version answers

> callers can credit themselves for unverified, repeatedly submitted artifacts
> using self-chosen rubrics, so the recorded reputation is straightforward to
> farm. A qualifying version needs verifiable contribution ownership, stable
> artifact commitments, fixed evaluation rules, and replay protection.

Each requirement, and what closes it:

| Requirement | Implementation |
|---|---|
| **Verifiable contribution ownership** | `review_contribution` takes `declared_author`, which must be a well-formed address, must equal the caller, and must match the author the artifact itself declares during consensus. A caller cannot credit another address. |
| **Stable artifact commitments** | `artifact_commit` stores a SHA-256 of `artifact_key + verified author` on-chain, so each credit is auditable. `_artifact_key` normalises scheme/host/path so trivial URL variants cannot create a second commitment. |
| **Fixed evaluation rules** | Rubrics are defined **in the contract** (`RUBRICS`: `general`, `technical`, `docs`). The caller selects one by name; free-form rubric text is rejected. `get_rubrics()` exposes them. |
| **Replay protection** | `artifact_owner` records which address an artifact was credited to. Resubmitting the same artifact — under a fresh `review_id` or a URL variant — is refused. One credit per artifact, ever. |

The declared author is also bound into consensus alongside the rating, so it is
not something a leader can assert unilaterally.

---

## Verified on-chain

`node test_poc.mjs` → **7/7 assertions pass.**

| Test | Result |
|---|---|
| Contract exposes fixed rubrics | PASS — `docs, general, technical` |
| Self-chosen rubric rejected | PASS — not recorded |
| Cannot credit a different address than the caller | PASS — rejected |
| Malformed `declared_author` rejected | PASS — rejected |
| Same artifact cannot be credited twice | PASS — refused |
| Reputation reflects recorded reviews only | PASS — `total_reviews=1`, `score=1 reviews=1 rank=NEWCOMER` |
| Same artifact under a new review_id refused | PASS — refused, `total_reviews` still 1 |

The last two matter together: legitimate work **is** credited, while every
farming vector is refused. A build where all submissions are rejected would pass
the same assertions vacuously — this one does not.

---

## Known limitation

`declared_author` is caller-supplied and cross-checked against the artifact's own
declared author. It is **not** a cryptographic signature: the Bradbury runner
exposes `Keccak256` but no `ecrecover`, so address recovery from a signature is
not available on this network. Ownership is therefore "the caller asserts it and
the artifact corroborates it" rather than "the caller proved it with a key".
Stated plainly rather than presented as signature verification.

---

## Contract layout

- `contracts/proof_of_contribution.py` — the contract
- `test_poc.mjs` — on-chain farming-resistance suite
- `deploy.mjs` — deploy script
- `render.yaml`, `server/` — relay backend for the frontend write path

Runner: `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` (Bradbury).
