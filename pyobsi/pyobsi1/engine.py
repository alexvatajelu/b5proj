"""
engine.py
The investigation engine. Runs in a background thread.

Given a list of seed subjects, it:
  1. Discovers related subjects BFS-style up to `depth` hops.
  2. Scores connections between every new subject and all known subjects.
  3. Logs everything via a callback.
  4. Respects a threading.Event for clean cancellation.
  5. Returns the updated reference_data dict when done.
"""

import threading
from typing import Callable
from llm_functions import find_related_subjects, get_connection
from state import (
    add_item,
    all_items,
    get_cached_connection,
    cache_connection,
)


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
) -> dict:
    """
    Run the full investigation loop.

    Args:
        seeds:          Seed subject names (already cleaned/title-cased).
        depth:          How many BFS hops to expand outward.
        threshold:      Minimum connection score to cache (and later link in vault).
        max_per_hop:    Max new subjects discovered per subject per hop.
        use_web:        Pass to LLM functions for web context.
        context:        Investigation context string for the LLM.
        reference_data: The live reference dict (mutated in place).
        log:            Thread-safe logging callback  log("message").
        set_progress:   Progress callback  set_progress(current, total).
        stop_event:     Set this to request a clean stop.

    Returns:
        The (mutated) reference_data dict.
    """

    # ── Seed the initial subjects ────────────────────────────────────────────
    for name in seeds:
        if add_item(reference_data, name, source="manual"):
            log(f"  + Added seed: {name}")

    frontier = list(seeds)           # subjects to expand this hop
    all_known = set(all_items(reference_data))

    # ── BFS loop ─────────────────────────────────────────────────────────────
    for hop in range(1, depth + 1):
        if stop_event.is_set():
            log("⚠ Stopped by user.")
            break
        if not frontier:
            log("  Nothing left to expand.")
            break

        log(f"\n── Depth {hop}/{depth} — expanding {len(frontier)} subject(s) ──")
        next_frontier = []

        for subject in frontier:
            if stop_event.is_set():
                break

            log(f"\n  🔍 Discovering around: {subject}")
            related = find_related_subjects(
                subject=subject,
                context=context,
                max_results=max_per_hop,
                min_relevance=threshold * 0.8,  # slightly looser for discovery
                use_web=use_web,
            )

            if not related:
                log(f"     (no related subjects found)")
                continue

            for r in related:
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

    # ── Score connections ─────────────────────────────────────────────────────
    known_list = all_items(reference_data)
    pairs = [
        (a, b)
        for i, a in enumerate(known_list)
        for b in known_list[i + 1:]
        if get_cached_connection(reference_data, a, b) is None
    ]

    if pairs:
        log(f"\n── Scoring {len(pairs)} connection pair(s) ──")
        for idx, (a, b) in enumerate(pairs, 1):
            if stop_event.is_set():
                log("⚠ Stopped by user.")
                break

            set_progress(idx, len(pairs))
            log(f"  [{idx}/{len(pairs)}] {a}  ↔  {b}")

            result = get_connection(
                subject_a=a,
                subject_b=b,
                context=context,
                use_web=use_web,
            )

            if result is None:
                log(f"     (failed — skipping)")
                continue

            score = result["score"]
            ctype = result["connection_type"]
            note  = result["note"]

            if score >= threshold:
                cache_connection(reference_data, a, b, result)
                log(f"     ✓ {ctype} ({score:.2f}): {note}")
            else:
                # Cache it anyway so we don't re-query, just mark as weak
                result_to_cache = dict(result)
                cache_connection(reference_data, a, b, result_to_cache)
                log(f"     – weak ({score:.2f}), below threshold")
    else:
        log("\n── All pairs already cached — nothing to score ──")

    set_progress(0, 0)
    log("\n✓ Investigation complete.")
    return reference_data
