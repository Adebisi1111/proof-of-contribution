# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""ProofOfContribution — AI-verified developer reputation from real work.

A developer submits a link to their public documentation or pull request. An AI
validator committee independently reads the work and rates it against a
predefined rubric, returning a numeric rating from 1 to 5. The ratings are
aggregated into the developer's permanent on-chain reputation profile: a running
score, a review count, and a rank tier derived from the average rating.

Reputation is earned from work that validators actually read, not granted by a
manual reviewer — so it bypasses reviewer favouritism. Every review is recorded
on-chain with its rubric, so any score can be traced back to the artifact that
produced it.

Consensus uses gl.vm.run_nondet with a leader/validator pair. The leader fetches
the artifact and rates it; each validator INDEPENDENTLY fetches the same
artifact and re-rates it, agreeing only if it reproduces the leader's rating.
A leader that inflates a rating diverges from what validators independently
compute, so the round does not commit. Rating is a 1-5 integer, so comparison is
exact and there is no fuzzy score for a leader to drift on.

This deliberately does NOT use gl.eq_principle.strict_eq over an LLM output:
strict_eq does not enforce cross-validator equality for non-deterministic
results on this network (verified on-chain).

Storage uses parallel TreeMap keyed by address with scalar values — no
@allow_storage dataclass, which this GenVM build rejects at deploy time
(verified by bisect).

No funds are held or moved: the reputation record is the artifact, and the rank
is non-transferable because it is keyed to the developer's own address.
"""

import json
import re
from datetime import datetime, timezone

from genlayer import *


# Rubric the validators rate against. Plain ints at module level — class-level
# u256 constants are not preserved in GenVM.
MAX_RATING = 5
MIN_RATING = 1


def _extract_text(raw_html: str) -> str:
    text = re.sub(r"<script[^>]*>.*?</script>", "", raw_html, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
    paragraphs = re.findall(r"<p[^>]*>(.*?)</p>", text, flags=re.DOTALL | re.IGNORECASE)
    text = " ".join(paragraphs) if paragraphs else re.sub(r"<[^>]+>", " ", text)
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")):
        text = text.replace(a, b)
    return re.sub(r"\s+", " ", text).strip()


def _fetch_artifact(url: str) -> str:
    response = gl.nondet.web.request(url, method="GET")
    body = response.body if hasattr(response, "body") else (
        response.get("body", "") if isinstance(response, dict) else str(response))
    raw = body.decode("utf-8", errors="replace") if isinstance(body, bytes) else str(body)
    return _extract_text(raw)[:8000]


def _parse_rating(raw: str) -> int:
    """Extract a 1-5 integer rating from the LLM response."""
    raw = re.sub(r"```json\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"```\s*", "", raw)
    match = re.search(r"\{.*\}", raw, flags=re.DOTALL)
    if match:
        raw = match.group()
    try:
        data = json.loads(raw)
        r = data.get("rating", None)
        if r is not None:
            n = int(round(float(r)))
            if MIN_RATING <= n <= MAX_RATING:
                return n
    except (json.JSONDecodeError, KeyError, ValueError, TypeError):
        pass
    # fall back to the first standalone 1-5 digit in the text
    m = re.search(r"\b([1-5])\b", raw)
    if m:
        return int(m.group(1))
    return 0


def _rate(artifact_text: str, rubric: str) -> dict:
    """Rate one artifact against the rubric. Returns {"rating": 1-5, 0 if unusable}."""
    prompt = (
        "You are a meticulous open-source contribution reviewer. Rate the "
        "submitted work against the rubric below.\n\n"
        f"RUBRIC:\n{rubric}\n\n"
        f"SUBMITTED WORK:\n{artifact_text}\n\n"
        "Rate the work on the rubric's scale, from 1 (poor) to 5 (excellent). "
        "Judge depth, clarity, spelling, and quality against the rubric — not "
        "against your own preferences.\n\n"
        "Respond with ONLY a valid JSON object in this exact format:\n"
        '{"rating": 4}\n\n'
        "The rating MUST be a single integer from 1 to 5.\n"
        "Do NOT include any text outside the JSON object."
    )
    return {"rating": _parse_rating(gl.nondet.exec_prompt(prompt).strip())}


class ProofOfContribution(gl.Contract):
    """AI-verified developer reputation: validator committee rates submitted
    work, ratings aggregate into a permanent non-transferable rank."""

    # reputation profiles, keyed by developer address
    rep_score: TreeMap[str, u256]         # sum of all ratings
    rep_reviews: TreeMap[str, u256]       # number of reviews
    rep_best: TreeMap[str, u256]          # highest single rating earned
    dev_count: u256 = u256(0)

    # review records, keyed by review_id
    rev_dev: TreeMap[str, str]
    rev_url: TreeMap[str, str]
    rev_rubric: TreeMap[str, str]
    rev_rating: TreeMap[str, u256]
    rev_created: TreeMap[str, u256]
    rev_count: u256 = u256(0)

    def __init__(self):
        self.dev_count = u256(0)
        self.rev_count = u256(0)

    def _now(self) -> int:
        return int(datetime.now(timezone.utc).timestamp())

    def _consensus_rating(self, target_url: str, rubric: str) -> int:
        """One independent leader/validator round producing a 1-5 rating."""
        url = target_url
        r = rubric

        def leader_fn() -> dict:
            return _rate(_fetch_artifact(url), r)

        def validator_fn(leader_res) -> bool:
            if not isinstance(leader_res, gl.vm.Return):
                return False
            mine = _rate(_fetch_artifact(url), r)
            return mine.get("rating") == leader_res.calldata.get("rating")

        result = gl.vm.run_nondet(leader_fn, validator_fn)
        data = result.calldata if hasattr(result, "calldata") else result
        n = int(data.get("rating", 0))
        return n if MIN_RATING <= n <= MAX_RATING else 0

    @gl.public.write
    def review_contribution(self, review_id: str, artifact_url: str, rubric: str) -> str:
        """Submit work for review. The rating is credited to the caller."""
        if not review_id:
            raise gl.vm.UserError("review_id required")
        if self.rev_dev.get(review_id, None) is not None:
            raise gl.vm.UserError(f"Review {review_id} already exists")
        if not artifact_url.startswith(("http://", "https://")):
            raise gl.vm.UserError("artifact_url must be http(s)")
        if not rubric.strip():
            raise gl.vm.UserError("rubric required")

        target_url = artifact_url
        target_rubric = rubric

        rating = self._consensus_rating(target_url, target_rubric)
        if rating < MIN_RATING:
            raise gl.vm.UserError("No consensus rating: validators could not agree")

        dev = str(gl.message.sender_address)
        is_new = self.rep_reviews.get(dev, None) is None

        self.rev_dev[review_id] = dev
        self.rev_url[review_id] = artifact_url
        self.rev_rubric[review_id] = rubric
        self.rev_rating[review_id] = u256(rating)
        self.rev_created[review_id] = u256(self._now())
        self.rev_count += u256(1)

        prev_score = int(self.rep_score.get(dev, u256(0)))
        prev_reviews = int(self.rep_reviews.get(dev, u256(0)))
        prev_best = int(self.rep_best.get(dev, u256(0)))

        self.rep_score[dev] = u256(prev_score + rating)
        self.rep_reviews[dev] = u256(prev_reviews + 1)
        self.rep_best[dev] = u256(rating if rating > prev_best else prev_best)
        if is_new:
            self.dev_count += u256(1)
        return str(rating)

    @gl.public.view
    def get_reputation(self, dev: str) -> dict:
        dev = str(dev)
        if self.rep_reviews.get(dev, None) is None:
            return {"exists": False}
        score = int(self.rep_score[dev])
        reviews = int(self.rep_reviews[dev])
        best = int(self.rep_best[dev])
        # integer average, scaled x100 to avoid floats in GenVM
        # (a float field causes 'float' object has no attribute 'to_bytes')
        avg_x100 = (score * 100) // reviews if reviews > 0 else 0
        return {
            "exists": True,
            "dev": dev,
            "score": score,
            "reviews": reviews,
            "best": best,
            "avg_x100": avg_x100,
            "rank": self._rank(avg_x100, reviews),
        }

    def _rank(self, avg_x100: int, reviews: int) -> str:
        """Tier from average rating, gated on a minimum review count so a single
        lucky 5 cannot mint a top rank."""
        if reviews < 3:
            return "NEWCOMER"
        if avg_x100 >= 450:
            return "LEGEND"
        if avg_x100 >= 350:
            return "EXPERT"
        if avg_x100 >= 250:
            return "CONTRIBUTOR"
        return "NOVICE"

    @gl.public.view
    def get_review(self, review_id: str) -> dict:
        review_id = str(review_id)
        if self.rev_dev.get(review_id, None) is None:
            return {"exists": False}
        return {
            "exists": True,
            "review_id": review_id,
            "dev": self.rev_dev[review_id],
            "url": self.rev_url[review_id],
            "rubric": self.rev_rubric[review_id],
            "rating": int(self.rev_rating[review_id]),
            "created_at": int(self.rev_created[review_id]),
        }

    @gl.public.view
    def total_developers(self) -> u256:
        return self.dev_count

    @gl.public.view
    def total_reviews(self) -> u256:
        return self.rev_count

    @gl.public.view
    def now(self) -> str:
        return datetime.now(timezone.utc).isoformat()
