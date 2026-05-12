"""
engine.py
The investigation engine. Runs in a background thread.

Given a list of seed subjects, it:
  1. Discovers related subjects BFS-style up to `depth` hops.
  2. Deduplicates discovered subjects against all known names (fuzzy match).
  3. Scores connections between every new subject and all known subjects.
  4. Logs everything via a callback.
  5. Respects a threading.Event for clean cancellation.
  6. Returns the updated reference_data dict when done.

Web search optimisation — O(n) not O(n²)
-----------------------------------------
The previous design issued one web search per connection *pair*, giving
O(n²) DuckDuckGo requests.  With 50 subjects that's 1,225 searches; at
5-10 s each (even with 8 parallel workers) this dominated runtime.

Fix: maintain a subject-level web-context cache populated during BFS.
For connection scoring the engine *combines* the two subjects' individual
cached contexts rather than issuing a new search.  This means:

  BFS phase  — O(n) searches, run in parallel (unchanged, already fast)
  Score phase — 0 additional web searches

Any seed subjects that were never expanded in BFS have their contexts
fetched in one extra O(seeds) parallel batch before scoring begins.

Parallelisation summary
-----------------------
  IO  (web fetch) — ThreadPoolExecutor, up to _WEB_WORKERS concurrent
  GPU (LLM calls) — strictly serial; Ollama queues on a single GPU anyway
"""

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable

from llm_functions import (
    find_related_subjects_with_context,
    get_connection_with_context,
    fetch_web_for_subject,
)
from state import (
    add_item,
    all_items,
    get_cached_connection,
    cache_connection,
)
from dedup import deduplicate_discovered


_WEB_WORKERS = 8   # parallel threads for IO — does not affect LLM calls


# ── Web-fetch helpers ─────────────────────────────────────────────────────────

def _prefetch_subject_contexts(
    subjects: list[str],
    context: str,
    use_web: bool,
) -> dict[str, str]:
    """
    Fetch web context for every subject in parallel.
    Returns {subject_name: web_context_string}.
    """
    if not use_web or not subjects:
        return {s: "" for s in subjects}

    results: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=_WEB_WORKERS) as pool:
        fut_map = {
            pool.submit(fetch_web_for_subject, s, context, use_web): s
            for s in subjects
        }
        for fut in as_completed(fut_map):
            s = fut_map[fut]
            try:
                results[s] = fut.result()
            except Exception as e:
                print(f"[engine] Web fetch failed for '{s}': {e}")
                results[s] = ""
    return results


def _build_connection_context(
    a: str,
    b: str,
    subject_cache: dict[str, str],
) -> str:
    """
    Build a web-context block for a pair by combining the two subjects'
    individually cached contexts.  No additional web request needed.

    If a subject has no cached context (e.g. it was a seed never expanded),
    its slot is simply omitted.
    """
    ctx_a = subject_cache.get(a, "").strip()
    ctx_b = subject_cache.get(b, "").strip()

    parts = []
    if ctx_a:
        parts.append(f"[Context: {a}]\n{ctx_a}")
    if ctx_b:
        parts.append(f"[Context: {b}]\n{ctx_b}")

    return "\n\n".join(parts)


# ── Main engine ───────────────────────────────────────────────────────────────

def run_investigation(
    seeds: list[str],
    depth: int,
    threshold: float,
    max_per_hop: int,
    use_web: bool,
    context: str,
    reference_data: dict,
    log: Callable[[str], None],
    set_progress: Callable[[int, int], None],
    stop_event: threading.Event,
    dedup_threshold: float = 0.82,
) -> dict:
    """
    Run the full investigation loop.

    Args:
        seeds:           Seed subject names (already cleaned/title-cased).
        depth:           How many BFS hops to expand outward.
        threshold:       Minimum connection score to flag as strong.
        max_per_hop:     Max new subjects discovered per subject per hop.
        use_web:         Whether to use web context at all.
        context:         Investigation context string for the LLM.
        reference_data:  The live reference dict (mutated in place).
        log:             Thread-safe logging callback.
        set_progress:    Progress callback  set_progress(current, total).
        stop_event:      Set this to request a clean stop.
        dedup_threshold: Fuzzy similarity threshold for subject merging (0-1).

    Returns:
        The (mutated) reference_data dict.
    """

    # subject_web_cache persists across all BFS hops and is reused during
    # connection scoring — this is what eliminates the O(n²) search problem.
    subject_web_cache: dict[str, str] = {}

    # ── Seed the initial subjects ─────────────────────────────────────────────
    for name in seeds:
        if add_item(reference_data, name, source="manual"):
            log(f"  + Added seed: {name}")

    frontier  = list(seeds)
    all_known = set(all_items(reference_data))

    # ── BFS loop ──────────────────────────────────────────────────────────────
    for hop in range(1, depth + 1):
        if stop_event.is_set():
            log("⚠ Stopped by user.")
            break
        if not frontier:
            log("  Nothing left to expand.")
            break

        log(f"\n── Depth {hop}/{depth} — expanding {len(frontier)} subject(s) ──")

        # Phase A — IO: parallel web fetch for entire frontier
        if use_web:
            log(f"   ⟳ Fetching web context for {len(frontier)} subject(s)…")
            new_ctx = _prefetch_subject_contexts(frontier, context, use_web)
            subject_web_cache.update(new_ctx)
            log(f"   ✓ Web fetch done.")

        # Phase B — GPU: serial LLM discovery using cached web context
        next_frontier: list[str] = []

        for subject in frontier:
            if stop_event.is_set():
                break

            log(f"\n  🔍 Discovering around: {subject}")
            related = find_related_subjects_with_context(
                subject=subject,
                context=context,
                web_context=subject_web_cache.get(subject, ""),
                max_results=max_per_hop,
                min_relevance=threshold * 0.8,
            )

            if not related:
                log(f"     (no related subjects found)")
                continue

            # Dedup: remove near-duplicates of already-known subjects
            kept, merges = deduplicate_discovered(related, all_known, threshold=dedup_threshold)

            for alias, canon in merges:
                log(f"     ~ '{alias}' merged → '{canon}' (duplicate)")

            for r in kept:
                name = r["name"]
                rel  = r["relevance"]
                if name in all_known:
                    log(f"     · {name} ({rel:.2f}) — already known")
                    continue
                add_item(reference_data, name, source="discovered")
                all_known.add(name)
                next_frontier.append(name)
                log(f"     + {name} ({rel:.2f}): {r['reason']}")

        frontier = next_frontier

    # ── Connection scoring ────────────────────────────────────────────────────
    known_list = all_items(reference_data)
    pairs = [
        (a, b)
        for i, a in enumerate(known_list)
        for b in known_list[i + 1:]
        if get_cached_connection(reference_data, a, b) is None
    ]

    if not pairs:
        log("\n── All pairs already cached — nothing to score ──")
        set_progress(0, 0)
        log("\n✓ Investigation complete.")
        return reference_data

    log(f"\n── Scoring {len(pairs)} connection pair(s) ──")

    # Fetch web context for any subjects not already in cache
    # (seeds that depth=0 never expanded, or very first run with seeds only)
    if use_web:
        uncached = [s for s in known_list if s not in subject_web_cache]
        if uncached:
            log(f"   ⟳ Fetching web context for {len(uncached)} uncached subject(s)…")
            new_ctx = _prefetch_subject_contexts(uncached, context, use_web)
            subject_web_cache.update(new_ctx)
        log(f"   ✓ All subject contexts ready. Scoring {len(pairs)} pairs with cached context…")
    else:
        log(f"   Scoring {len(pairs)} pairs (web disabled)…")

    # Serial LLM calls — combine cached subject contexts, no new searches
    for idx, (a, b) in enumerate(pairs, 1):
        if stop_event.is_set():
            log("⚠ Stopped by user.")
            break

        set_progress(idx, len(pairs))
        log(f"  [{idx}/{len(pairs)}] {a}  ↔  {b}")

        web_ctx = _build_connection_context(a, b, subject_web_cache)

        result = get_connection_with_context(
            subject_a=a,
            subject_b=b,
            context=context,
            web_context=web_ctx,
        )

        if result is None:
            log(f"     (failed — skipping)")
            continue

        score = result["score"]
        ctype = result["connection_type"]
        note  = result["note"]

        cache_connection(reference_data, a, b, result)

        if score >= threshold:
            log(f"     ✓ {ctype} ({score:.2f}): {note}")
        else:
            log(f"     – weak ({score:.2f}), below threshold")

    set_progress(0, 0)
    log("\n✓ Investigation complete.")
    return reference_data
