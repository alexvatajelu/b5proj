"""
dedup.py
Subject name normalisation and fuzzy deduplication.

Prevents the same real-world entity from appearing under multiple names
(e.g. "CIA", "C.I.A.", "Central Intelligence Agency") and inflating the
O(n²) connection-scoring workload.

Public API
----------
find_canonical(name, known, threshold)   → str | None
deduplicate_discovered(discovered, all_known, threshold)
                                         → (kept, merges)
"""

import re
from difflib import SequenceMatcher


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

# Words that carry little discriminating weight — stripped before comparison
_STOP_WORDS = {
    "the", "a", "an", "of", "and", "in", "for", "on", "at", "to",
    "agency", "organization", "organisation", "institute", "bureau",
    "department", "committee", "office", "service", "ministry",
    "operation", "project", "program", "programme",
}

# Known abbreviation → expanded form.  Keep this sparse — fuzzy matching
# handles most cases without an exhaustive dictionary.
_EXPANSIONS: dict[str, str] = {
    "cia":   "central intelligence agency",
    "kgb":   "committee state security",
    "fbi":   "federal bureau investigation",
    "nsa":   "national security agency",
    "mi6":   "secret intelligence service",
    "mi5":   "security service",
    "gru":   "main intelligence directorate",
    "nato":  "north atlantic treaty organization",
    "un":    "united nations",
    "eu":    "european union",
    "us":    "united states",
    "uk":    "united kingdom",
    "ussr":  "soviet union",
}


def _normalize(name: str) -> str:
    """
    Produce a canonical comparison form:
      1. Lower-case
      2. Remove punctuation (hyphens → space, dots stripped, etc.)
      3. Collapse whitespace
      4. Expand known abbreviations
      5. Remove low-signal stop words
    """
    s = name.lower()

    # Turn hyphens / slashes into spaces, strip other punctuation
    s = re.sub(r"[-/]", " ", s)
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", " ", s).strip()

    # Single-word abbreviation expansion
    if s in _EXPANSIONS:
        s = _EXPANSIONS[s]

    # Remove stop words
    tokens = [t for t in s.split() if t not in _STOP_WORDS]
    return " ".join(tokens) if tokens else s


def _similarity(a: str, b: str) -> float:
    """
    Combined similarity score:
      - SequenceMatcher ratio on normalised strings (handles typos / word order)
      - Bonus for exact-token set overlap (catches "KGB" vs "KGB Russia" etc.)

    Returns a float in [0.0, 1.0].
    """
    na, nb = _normalize(a), _normalize(b)

    ratio = SequenceMatcher(None, na, nb).ratio()

    # Jaccard-style token overlap bonus (helps short names like "CIA" ↔ "CIA Russia")
    ta, tb = set(na.split()), set(nb.split())
    if ta and tb:
        overlap = len(ta & tb) / len(ta | tb)
        ratio = max(ratio, overlap)

    return ratio


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def find_canonical(
    name: str,
    known: list[str],
    threshold: float = 0.82,
) -> str | None:
    """
    Check whether `name` is a near-duplicate of anything in `known`.

    Args:
        name:      The candidate name to check.
        known:     List of already-accepted names to compare against.
        threshold: Similarity score (0–1) required to declare a match.
                   0.82 works well in practice: catches abbreviation variants
                   and minor typos while avoiding false positives between
                   genuinely distinct subjects.

    Returns:
        The matching canonical name from `known`, or None if no match.
    """
    best_score, best_match = 0.0, None
    for k in known:
        s = _similarity(name, k)
        if s > best_score:
            best_score, best_match = s, k
    return best_match if best_score >= threshold else None


def deduplicate_discovered(
    discovered: list[dict],
    all_known: set[str],
    threshold: float = 0.82,
) -> tuple[list[dict], list[tuple[str, str]]]:
    """
    Filter a batch of newly-discovered subjects, collapsing any that are
    fuzzy-duplicates of already-known items or of each other.

    Subjects are expected to come in relevance-descending order (as returned
    by find_related_subjects).  When two candidates would merge, the one
    encountered first (higher relevance) wins as the canonical form.

    Args:
        discovered: List of subject dicts with at least a "name" key.
        all_known:  Set of names already present in reference_data.
        threshold:  Similarity threshold forwarded to find_canonical().

    Returns:
        kept:   Subjects that are genuinely new and non-duplicate.
        merges: List of (alias, canonical) pairs that were collapsed,
                useful for logging.
    """
    merges: list[tuple[str, str]] = []
    kept:   list[dict]            = []

    # Working reference: all known items PLUS those we've already accepted
    # from this batch (so intra-batch duplicates are also caught).
    seen: list[str] = list(all_known)

    for subj in discovered:
        name  = subj["name"]
        canon = find_canonical(name, seen, threshold)

        if canon is not None and canon != name:
            # Near-duplicate found — record the merge and skip
            merges.append((name, canon))
        else:
            kept.append(subj)
            seen.append(name)   # add to reference so later items dedup against it

    return kept, merges
