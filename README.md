# ProofOfContribution — AI-Verified Developer Reputation

A GenLayer Project where open-source developers earn **non-transferable on-chain
reputation ranks** from work that AI validators actually read — not from manual
reviewer approval.

**Contract (Bradbury, chain 4221):** `0x218E6256B0ED02F0Bb5155E5Ae93219168c4c32f`
**Explorer:** https://explorer-bradbury.genlayer.com/address/0x218E6256B0ED02F0Bb5155E5Ae93219168c4c32f
**Live app:** https://adebisi1111.github.io/proof-of-contribution/

---

## The problem

Open-source reputation is usually gatekept by human reviewers — biased,
inconsistent, and a bottleneck. A developer's actual contribution quality rarely
enters the record in a verifiable way.

## What it does

A developer submits a link to their public documentation or pull request, plus a
rubric. An AI validator committee independently reads the work and rates it 1–5
against that rubric. The rating is aggregated into the developer's permanent
on-chain profile: running score, review count, best rating, average, and a rank
tier. Reputation is keyed to the developer's own address, so it is
**non-transferable** by construction.

Rank tiers: `NEWCOMER` (< 3 reviews) → `NOVICE` → `CONTRIBUTOR` → `EXPERT` →
`LEGEND`. The tier is gated on a minimum review count so a single lucky 5 cannot
mint a top rank.

## How consensus is used

```python
def leader_fn() -> dict:
    return _rate(_fetch_artifact(url), rubric)        # leader rates

def validator_fn(leader_res) -> bool:
    if not isinstance(leader_res, gl.vm.Return):
        return False
    mine = _rate(_fetch_artifact(url), rubric)        # validator INDEPENDENTLY re-rates
    return mine.get("rating") == leader_res.calldata.get("rating")

result = gl.vm.run_nondet(leader_fn, validator_fn)
```

The leader fetches the artifact and rates it; **each validator independently
fetches the same artifact and re-rates it**, agreeing only if it reproduces the
leader's rating. A leader that inflates a rating diverges from what validators
independently compute, so the round does not commit.

Rating is an exact **integer 1–5**, so consensus comparison is exact — there is
no fuzzy score for a leader to drift on.

This deliberately does **not** use `gl.eq_principle.strict_eq` over an LLM
output: `strict_eq` does not enforce cross-validator equality for
non-deterministic results on this network (verified on-chain — a value that
changes every execution committed under `AGREE`).

## The app

A vanilla JS frontend on GitHub Pages:
- **Submit Work** — enter an artifact URL, a review ID, and pick a rubric; signs
  the review through MetaMask
- **My Profile** — connected wallet's score, reviews, average, and rank badge
- **Look Up Dev** — query any address's reputation
- Live network stats (total developers, total reviews)

Reads work without a wallet; writes go through the browser wallet. `rpc-fix.js`
patches `window.fetch` before `genlayer-js` loads, converting viem's string
JSON-RPC `id` to the integer GenLayer's RPC requires — without it every
transaction approval fails with a parse error.

## State model

Parallel `TreeMap[str, scalar]` maps keyed by address or review id — no
`@allow_storage` dataclass, which this GenVM build rejects at deploy time
(verified by bisect).

- `rep_score`, `rep_reviews`, `rep_best` keyed by developer address; `dev_count`
- `rev_dev`, `rev_url`, `rev_rubric`, `rev_rating`, `rev_created` keyed by
  review id; `rev_count`

## Verification (on-chain, read back from Bradbury)

**Test suite: 18 assertions, all passing** (`test_poc.mjs`).

| Group | Assertions | Result |
|---|---|---|
| Review + profile | 9 | PASS — rating, score, reviews, best, avg_x100, rank all correct |
| Accumulation | 5 | PASS — 3 reviews sum correctly, rank upgrades, counters correct |
| Duplicate rejected | 1 | PASS — `FINISHED_WITH_ERROR`, no overwrite |
| Rigged leader | 3 | PASS — `DISAGREE` on every round, `total_reviews: 0` |

Adversarial case: a variant whose leader fabricates a rating of 5 was rejected
with `DISAGREE` on every round and committed nothing.

## Why no funds are held

The reputation record is the artifact. The value-moving primitives (`gl.pay`,
`emit_transfer`) do not settle on this network (verified on-chain with a minimal
payable probe that returned `FINISHED_WITH_ERROR` with zero executions), and a
non-monetary reputation primitive does not need them.

## Contract layout

- `contracts/proof_of_contribution.py` — the contract (Bradbury pattern:
  `from genlayer import *`, `gl.Contract`, `gl.vm.run_nondet`)
- `deploy.mjs` — deploy script with retry on transient 0-byte stores
- `test_poc.mjs` — on-chain test suite, 18 assertions
- `public/index.html`, `public/rpc-fix.js` — the frontend

## Deploy / test

```bash
DEPLOY_PK=0x<key> node deploy.mjs          # deploy to Bradbury
DEPLOY_PK=0x<key> node test_poc.mjs        # run the on-chain suite
```
