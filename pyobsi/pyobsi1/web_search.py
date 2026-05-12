"""
web_search.py
Web context fetching for LLM prompts.

Provider priority
-----------------
1. Wikipedia REST API  — fast (~200 ms), no rate limits, no API key.
                         Best for well-known subjects.
2. DuckDuckGo (DDGS)  — fallback when Wikipedia has no article.
                         Slower (5–10 s) and rate-limited; used sparingly.

Public API (unchanged from previous version)
--------------------------------------------
search_subject(subject, extra_terms, max_results)   → str
search_connection(subject_a, subject_b, max_results) → str  ← now a no-op
                                                              (see engine.py)

The search_connection function is kept for backwards compatibility but the
engine no longer calls it — it builds connection context by combining the
two subjects' individual contexts from its subject-level cache instead,
which eliminates all O(n²) web requests during connection scoring.
"""

import re
import requests
from typing import Optional

# ── Wikipedia REST API ────────────────────────────────────────────────────────

_WIKI_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/{}"
_WIKI_SEARCH_URL  = "https://en.wikipedia.org/w/api.php"
_WIKI_TIMEOUT     = 6      # seconds — Wikipedia is fast; fail quickly if down
_SNIPPET_MAX      = 280    # characters per snippet injected into prompt


def _wiki_summary(title: str) -> Optional[str]:
    """
    Fetch the Wikipedia summary for an exact article title.
    Returns the extract string or None on any failure.
    """
    try:
        url  = _WIKI_SUMMARY_URL.format(requests.utils.quote(title, safe=""))
        resp = requests.get(url, timeout=_WIKI_TIMEOUT, headers={"User-Agent": "obsillm/1.0"})
        if resp.status_code != 200:
            return None
        data    = resp.json()
        extract = data.get("extract", "").strip()
        return extract if extract else None
    except Exception:
        return None


def _wiki_search(query: str, max_results: int = 3) -> list[dict]:
    """
    Search Wikipedia and return article snippets.
    Uses the opensearch API for title matching + summary for the best hit.
    Returns [{title, snippet}] or [] on failure.
    """
    try:
        # OpenSearch for candidate titles
        resp = requests.get(
            _WIKI_SEARCH_URL,
            params={
                "action":      "opensearch",
                "search":      query,
                "limit":       max_results,
                "namespace":   0,
                "format":      "json",
                "redirects":   "resolve",
            },
            timeout=_WIKI_TIMEOUT,
            headers={"User-Agent": "obsillm/1.0"},
        )
        if resp.status_code != 200:
            return []

        _, titles, snippets, _ = resp.json()
    except Exception:
        return []

    results = []
    for title, snippet in zip(titles, snippets):
        # Prefer full summary over the thin opensearch snippet when available
        summary = _wiki_summary(title)
        text    = summary if summary else snippet.strip()
        if not text:
            continue
        # Trim to prompt-budget
        if len(text) > _SNIPPET_MAX:
            text = text[:_SNIPPET_MAX].rsplit(" ", 1)[0] + "…"
        results.append({"title": title, "snippet": text})
        if len(results) >= max_results:
            break

    return results


# ── DuckDuckGo fallback ───────────────────────────────────────────────────────

def _ddgs_search(query: str, max_results: int = 3) -> list[dict]:
    """
    DuckDuckGo search — used only when Wikipedia has no usable result.
    Returns [{title, snippet, url}] or [] on any failure.
    """
    try:
        from ddgs import DDGS
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=max_results))
    except Exception as e:
        print(f"[web_search] DDGS fallback failed for '{query}': {e}")
        return []

    results = []
    for r in raw:
        snippet = (r.get("body") or "").strip()
        if len(snippet) > _SNIPPET_MAX:
            snippet = snippet[:_SNIPPET_MAX].rsplit(" ", 1)[0] + "…"
        results.append({
            "title":   (r.get("title") or "").strip(),
            "snippet": snippet,
            "url":     (r.get("href") or "").strip(),
        })
    return results


# ── Shared formatting ─────────────────────────────────────────────────────────

def _format_for_prompt(results: list[dict], label: str = "Web context") -> str:
    """Format a list of result dicts into a compact prompt block."""
    if not results:
        return ""
    lines = [f"[{label}]"]
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}: {r['snippet']}")
    return "\n".join(lines)


# ── Public API ────────────────────────────────────────────────────────────────

def search_web(query: str, max_results: int = 3, snippet_max_chars: int = _SNIPPET_MAX) -> list[dict]:
    """
    Search for a query, trying Wikipedia first then DDGS as fallback.
    Returns [{title, snippet}] or [] on total failure.
    """
    results = _wiki_search(query, max_results=max_results)
    if not results:
        results = _ddgs_search(query, max_results=max_results)
    return results


def search_subject(subject: str, extra_terms: str = "", max_results: int = 3) -> str:
    """
    Fetch web context for a single subject.

    Strategy:
      1. Try Wikipedia directly on the subject name (fast, accurate).
      2. If that misses, try Wikipedia search with extra_terms.
      3. If still empty, fall back to DDGS (slow, last resort).

    Returns a formatted string ready to inject into a prompt.
    """
    # Fast path: direct Wikipedia article lookup
    summary = _wiki_summary(subject)
    if summary:
        if len(summary) > _SNIPPET_MAX:
            summary = summary[:_SNIPPET_MAX].rsplit(" ", 1)[0] + "…"
        return _format_for_prompt([{"title": subject, "snippet": summary}], label="Wikipedia")

    # Wikipedia search with context terms
    query   = f"{subject} {extra_terms}".strip()
    results = _wiki_search(query, max_results=max_results)
    if results:
        return _format_for_prompt(results, label="Wikipedia")

    # DDGS fallback
    results = _ddgs_search(query, max_results=max_results)
    return _format_for_prompt(results, label="Web context")


def search_connection(subject_a: str, subject_b: str, max_results: int = 3) -> str:
    """
    Kept for backwards compatibility.

    NOTE: The engine no longer calls this.  It builds connection context by
    combining two subjects' individual cached contexts, which eliminates all
    O(n²) web requests.  This function is retained so that standalone calls
    (e.g. test_llm_functions.py) still work.
    """
    query   = f"{subject_a} {subject_b} connection relationship"
    results = search_web(query, max_results=max_results)
    return _format_for_prompt(results)


def format_snippets_for_prompt(results: list[dict]) -> str:
    """Backwards-compatible alias for _format_for_prompt."""
    return _format_for_prompt(results)
