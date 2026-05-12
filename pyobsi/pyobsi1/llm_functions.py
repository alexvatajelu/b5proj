"""
llm_functions.py

The two core LLM processing functions:

  find_related_subjects(subject, context, max_results, min_relevance, use_web)
      → Finds and rates subjects related to a central subject.

  get_connection(subject_a, subject_b, context, use_web)
      → Rates the strength of and describes the direct connection between two subjects.

Both use Ollama (Llama 3.1 8B Q4) + optional DuckDuckGo web context.

Parallelisation note
--------------------
Web fetching and LLM inference are deliberately separated into distinct
functions so that the engine can pre-fetch all web contexts in a thread
pool (IO-bound) and then run LLM calls serially (GPU-bound):

  fetch_web_for_subject(subject, context, use_web)   → str
  fetch_web_for_connection(a, b, use_web)            → str

  find_related_subjects_with_context(subject, context, web_context, ...)
  get_connection_with_context(subject_a, subject_b, context, web_context)

The original all-in-one signatures are kept as thin wrappers for
backwards compatibility / standalone use.
"""

from ollama_client import query_ollama, parse_json_response
from web_search import search_subject, search_connection


# ---------------------------------------------------------------------------
# Schema reference (for prompts and callers)
# ---------------------------------------------------------------------------
#
# find_related_subjects / find_related_subjects_with_context return:
# [
#   {
#     "name":      str,   — subject name, title-cased
#     "relevance": float, — 0.0–1.0
#     "reason":    str    — one sentence explaining the relationship
#   },
#   ...
# ]
#
# get_connection / get_connection_with_context return:
# {
#   "score":           float, — 0.0–1.0 connection strength
#   "note":            str,   — one sentence describing the direct connection
#   "connection_type": str    — causal | thematic | temporal |
#                               associative | oppositional | hierarchical
# }
# ---------------------------------------------------------------------------


SYSTEM_PROMPT = (
    "You are an analytical research assistant helping to map relationships between subjects "
    "for investigative research. Be precise, factual, and concise. "
    "Always respond with valid JSON matching the exact schema requested."
)

VALID_CONNECTION_TYPES = {
    "causal", "thematic", "temporal", "associative", "oppositional", "hierarchical"
}


# ===========================================================================
# Web-fetch helpers  (IO-bound — safe to call from a thread pool)
# ===========================================================================

def fetch_web_for_subject(
    subject: str,
    context: str = "",
    use_web: bool = True,
) -> str:
    """
    Return a formatted web-context string for a single subject,
    or "" when use_web is False or the search fails.

    This is the IO half of find_related_subjects, extracted so that the
    engine can pre-fetch many subjects concurrently before any LLM call.
    """
    if not use_web:
        return ""
    extra = context if context else "overview significance"
    return search_subject(subject, extra_terms=extra, max_results=4)


def fetch_web_for_connection(
    subject_a: str,
    subject_b: str,
    use_web: bool = True,
) -> str:
    """
    Return a formatted web-context string for a subject pair,
    or "" when use_web is False or the search fails.

    This is the IO half of get_connection, extracted for the same reason.
    """
    if not use_web:
        return ""
    return search_connection(subject_a, subject_b, max_results=4)


# ===========================================================================
# Core LLM functions  (GPU-bound — run serially against Ollama)
# ===========================================================================

def find_related_subjects_with_context(
    subject: str,
    context: str = "",
    web_context: str = "",
    max_results: int = 8,
    min_relevance: float = 0.5,
) -> list[dict]:
    """
    Find and rate subjects related to a central subject using a pre-fetched
    web context string (may be empty).

    Prefer this over find_related_subjects() when the web fetch has already
    been done in a thread pool — it skips the IO step entirely.

    Args:
        subject:       The central subject to search around.
        context:       Optional free-text investigation context.
        web_context:   Pre-fetched web snippet block (from fetch_web_for_subject).
        max_results:   Maximum number of related subjects to return.
        min_relevance: Minimum relevance score (0.0–1.0) to include.

    Returns:
        List of dicts: [{name, relevance, reason}], sorted by relevance desc.
        Returns [] on total failure.
    """
    context_block = f"\nInvestigation context: {context}" if context else ""
    web_block     = f"\n\n{web_context}" if web_context else ""

    prompt = f"""You are mapping subjects for an investigation.
Central subject: "{subject}"{context_block}{web_block}

Task: Identify up to {max_results} subjects that are directly or closely related to "{subject}".
Include people, organisations, events, concepts, locations, or documents — whatever is genuinely relevant.

For each subject return:
  - "name": the subject name (title-cased, concise)
  - "relevance": a float from 0.0 to 1.0 indicating how strongly related it is to "{subject}"
  - "reason": one sentence explaining the specific relationship

Return this JSON schema exactly:
{{
  "subjects": [
    {{"name": "...", "relevance": 0.0, "reason": "..."}}
  ]
}}"""

    retry_prompt = f"""Return ONLY a JSON object with a "subjects" array.
Each element must have "name" (string), "relevance" (float 0.0-1.0), and "reason" (string).
Subject: "{subject}". List {max_results} related subjects."""

    try:
        raw    = query_ollama(prompt, system=SYSTEM_PROMPT, expect_json=True)
        parsed = parse_json_response(raw, retry_prompt=retry_prompt)
    except (ValueError, RuntimeError, ConnectionError) as e:
        print(f"[find_related_subjects] Failed for '{subject}': {e}")
        return []

    subjects  = parsed.get("subjects", [])
    validated = []
    for item in subjects:
        name   = str(item.get("name", "")).strip()
        reason = str(item.get("reason", "")).strip()
        try:
            relevance = float(item.get("relevance", 0.0))
            relevance = max(0.0, min(1.0, relevance))
        except (TypeError, ValueError):
            relevance = 0.0

        if not name or relevance < min_relevance:
            continue

        validated.append({"name": name, "relevance": relevance, "reason": reason})

    validated.sort(key=lambda x: x["relevance"], reverse=True)
    return validated


def get_connection_with_context(
    subject_a: str,
    subject_b: str,
    context: str = "",
    web_context: str = "",
) -> dict | None:
    """
    Rate the strength of and describe the direct connection between two subjects
    using a pre-fetched web context string (may be empty).

    Prefer this over get_connection() when the web fetch has already been done
    in a thread pool — it skips the IO step entirely.

    Args:
        subject_a:   First subject.
        subject_b:   Second subject.
        context:     Optional free-text investigation context.
        web_context: Pre-fetched web snippet block (from fetch_web_for_connection).

    Returns:
        Dict with keys: score (float), note (str), connection_type (str).
        Returns None on total failure.
    """
    context_block = f"\nInvestigation context: {context}" if context else ""
    web_block     = f"\n\n{web_context}" if web_context else ""

    prompt = f"""You are analysing the direct connection between two subjects for an investigation.
Subject A: "{subject_a}"
Subject B: "{subject_b}"{context_block}{web_block}

Task: Evaluate the direct connection between these two subjects.

Score the connection strength from 0.0 to 1.0:
  1.0 = direct, well-documented, central connection
  0.7 = clear and significant connection
  0.5 = moderate or indirect connection
  0.3 = loose or tenuous connection
  0.0 = no meaningful connection

Choose the connection_type that best describes the primary link:
  causal, thematic, temporal, associative, oppositional, hierarchical

Return this JSON schema exactly:
{{
  "score": 0.0,
  "note": "One sentence describing the specific direct connection.",
  "connection_type": "thematic"
}}"""

    retry_prompt = f"""Return ONLY a JSON object with:
  "score" (float 0.0-1.0),
  "note" (string, one sentence),
  "connection_type" (one of: causal, thematic, temporal, associative, oppositional, hierarchical).
Subjects: "{subject_a}" and "{subject_b}"."""

    try:
        raw    = query_ollama(prompt, system=SYSTEM_PROMPT, expect_json=True)
        parsed = parse_json_response(raw, retry_prompt=retry_prompt)
    except (ValueError, RuntimeError, ConnectionError) as e:
        print(f"[get_connection] Failed for '{subject_a}' | '{subject_b}': {e}")
        return None

    try:
        score = float(parsed.get("score", 0.0))
        score = max(0.0, min(1.0, score))
    except (TypeError, ValueError):
        score = 0.0

    note            = str(parsed.get("note", "")).strip()
    connection_type = str(parsed.get("connection_type", "associative")).strip().lower()

    if connection_type not in VALID_CONNECTION_TYPES:
        connection_type = "associative"

    return {"score": score, "note": note, "connection_type": connection_type}


# ===========================================================================
# Original all-in-one wrappers (backwards compatible)
# ===========================================================================

def find_related_subjects(
    subject: str,
    context: str = "",
    max_results: int = 8,
    min_relevance: float = 0.5,
    use_web: bool = True,
) -> list[dict]:
    """
    All-in-one convenience wrapper: fetch web context then query LLM.
    Use find_related_subjects_with_context() for parallelised callers.
    """
    web_context = fetch_web_for_subject(subject, context, use_web)
    return find_related_subjects_with_context(
        subject=subject,
        context=context,
        web_context=web_context,
        max_results=max_results,
        min_relevance=min_relevance,
    )


def get_connection(
    subject_a: str,
    subject_b: str,
    context: str = "",
    use_web: bool = True,
) -> dict | None:
    """
    All-in-one convenience wrapper: fetch web context then query LLM.
    Use get_connection_with_context() for parallelised callers.
    """
    web_context = fetch_web_for_connection(subject_a, subject_b, use_web)
    return get_connection_with_context(
        subject_a=subject_a,
        subject_b=subject_b,
        context=context,
        web_context=web_context,
    )
