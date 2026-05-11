"""
web_search.py
Lightweight DuckDuckGo search wrapper.
Install dependency: pip install duckduckgo-search
"""

from ddgs import DDGS
from typing import Optional


def search_web(query: str, max_results: int = 4, snippet_max_chars: int = 220) -> list[dict]:
    """
    Search DuckDuckGo and return trimmed result snippets.

    Args:
        query:             Search query string.
        max_results:       Number of results to fetch.
        snippet_max_chars: Truncate each snippet to this length to keep prompts lean.

    Returns:
        List of dicts: [{"title": ..., "snippet": ..., "url": ...}, ...]
        Returns empty list on failure rather than raising, so the LLM functions
        can still run without web context.
    """
    try:
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=max_results))
    except Exception as e:
        print(f"[web_search] Search failed for '{query}': {e}")
        return []

    results = []
    for r in raw:
        snippet = (r.get("body") or "").strip()
        if len(snippet) > snippet_max_chars:
            snippet = snippet[:snippet_max_chars].rsplit(" ", 1)[0] + "…"
        results.append({
            "title":   (r.get("title") or "").strip(),
            "snippet": snippet,
            "url":     (r.get("href") or "").strip(),
        })

    return results


def format_snippets_for_prompt(results: list[dict]) -> str:
    """
    Format search results into a compact block for injection into a prompt.

    Args:
        results: Output from search_web().

    Returns:
        A plain-text block, or an empty string if no results.
    """
    if not results:
        return ""

    lines = ["[Web context]"]
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}: {r['snippet']}")

    return "\n".join(lines)


def search_subject(subject: str, extra_terms: str = "", max_results: int = 4) -> str:
    """
    Convenience function: search for a subject and return a formatted prompt block.

    Args:
        subject:     The subject to search for.
        extra_terms: Optional additional search terms (e.g. "history", "significance").
        max_results: Number of results to fetch.

    Returns:
        Formatted string ready to inject into a prompt.
    """
    query = f"{subject} {extra_terms}".strip()
    results = search_web(query, max_results=max_results)
    return format_snippets_for_prompt(results)


def search_connection(subject_a: str, subject_b: str, max_results: int = 4) -> str:
    """
    Convenience function: search for the relationship between two subjects.

    Args:
        subject_a: First subject.
        subject_b: Second subject.
        max_results: Number of results to fetch.

    Returns:
        Formatted string ready to inject into a prompt.
    """
    query = f"{subject_a} {subject_b} connection relationship"
    results = search_web(query, max_results=max_results)
    return format_snippets_for_prompt(results)
