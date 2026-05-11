"""
llm_functions.py

The two core LLM processing functions:

  find_related_subjects(subject, context, max_results, min_relevance)
      → Finds and rates subjects related to a central subject.

  get_connection(subject_a, subject_b, context)
      → Rates the strength of and describes the direct connection between two subjects.

Both use Ollama (Llama 3.1 8B Q4) + optional DuckDuckGo web context.
"""

from ollama_client import query_ollama, parse_json_response
from web_search import search_subject, search_connection


# ---------------------------------------------------------------------------
# Schema reference (for prompts and for callers)
# ---------------------------------------------------------------------------
#
# find_related_subjects returns:
# {
#   "subjects": [
#     {
#       "name":      str,   — subject name, title-cased
#       "relevance": float, — 0.0–1.0
#       "reason":    str    — one sentence explaining the relationship
#     },
#     ...
#   ]
# }
#
# get_connection returns:
# {
#   "score":           float, — 0.0–1.0 connection strength
#   "note":            str,   — one sentence describing the direct connection
#   "connection_type": str    — one of: causal, thematic, temporal, associative, oppositional, hierarchical
# }
# ---------------------------------------------------------------------------


SYSTEM_PROMPT = (
    "You are an analytical research assistant helping to map relationships between subjects "
    "for investigative research. Be precise, factual, and concise. "
    "Always respond with valid JSON matching the exact schema requested."
)


def find_related_subjects(
    subject: str,
    context: str = "",
    max_results: int = 8,
    min_relevance: float = 0.5,
    use_web: bool = True,
) -> list[dict]:
    """
    Find and rate subjects related to a central subject.

    Args:
        subject:        The central subject to search around.
        context:        Optional free-text description of the investigation context,
                        e.g. "Cold War espionage investigation". Helps ground the LLM.
        max_results:    Maximum number of related subjects to return (before filtering).
        min_relevance:  Minimum relevance score (0.0–1.0) to include in results.
        use_web:        Whether to fetch web context before querying the LLM.

    Returns:
        List of subject dicts with keys: name, relevance, reason.
        Sorted by relevance descending. Filtered to >= min_relevance.
        Returns [] on total failure.
    """
    # 1. Gather web context
    web_context = ""
    if use_web:
        extra = context if context else "overview significance"
        web_context = search_subject(subject, extra_terms=extra, max_results=4)

    # 2. Build prompt
    context_block = f"\nInvestigation context: {context}" if context else ""
    web_block = f"\n\n{web_context}" if web_context else ""

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

    # 3. Query LLM
    try:
        raw = query_ollama(prompt, system=SYSTEM_PROMPT, expect_json=True)
        parsed = parse_json_response(raw, retry_prompt=retry_prompt)
    except (ValueError, RuntimeError, ConnectionError) as e:
        print(f"[find_related_subjects] Failed for '{subject}': {e}")
        return []

    # 4. Validate and filter
    subjects = parsed.get("subjects", [])
    validated = []
    for item in subjects:
        name = str(item.get("name", "")).strip()
        reason = str(item.get("reason", "")).strip()
        try:
            relevance = float(item.get("relevance", 0.0))
            relevance = max(0.0, min(1.0, relevance))  # clamp to [0, 1]
        except (TypeError, ValueError):
            relevance = 0.0

        if not name:
            continue
        if relevance < min_relevance:
            continue

        validated.append({
            "name":      name,
            "relevance": relevance,
            "reason":    reason,
        })

    # 5. Sort by relevance and return
    validated.sort(key=lambda x: x["relevance"], reverse=True)
    return validated


# ---------------------------------------------------------------------------


VALID_CONNECTION_TYPES = {
    "causal", "thematic", "temporal", "associative", "oppositional", "hierarchical"
}


def get_connection(
    subject_a: str,
    subject_b: str,
    context: str = "",
    use_web: bool = True,
) -> dict | None:
    """
    Rate the strength of and describe the direct connection between two subjects.

    Args:
        subject_a:  First subject.
        subject_b:  Second subject.
        context:    Optional free-text investigation context.
        use_web:    Whether to fetch web context before querying the LLM.

    Returns:
        Dict with keys: score (float), note (str), connection_type (str).
        Returns None on total failure.

    Connection types:
        causal       — one directly caused or enabled the other
        thematic     — share a common theme, domain, or ideology
        temporal     — linked by timing or sequence of events
        associative  — linked through a shared third party or circumstance
        oppositional — directly opposed, conflicting, or adversarial
        hierarchical — one contains, controls, or is a subpart of the other
    """
    # 1. Gather web context
    web_context = ""
    if use_web:
        web_context = search_connection(subject_a, subject_b, max_results=4)

    # 2. Build prompt
    context_block = f"\nInvestigation context: {context}" if context else ""
    web_block = f"\n\n{web_context}" if web_context else ""

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

    # 3. Query LLM
    try:
        raw = query_ollama(prompt, system=SYSTEM_PROMPT, expect_json=True)
        parsed = parse_json_response(raw, retry_prompt=retry_prompt)
    except (ValueError, RuntimeError, ConnectionError) as e:
        print(f"[get_connection] Failed for '{subject_a}' | '{subject_b}': {e}")
        return None

    # 4. Validate fields
    try:
        score = float(parsed.get("score", 0.0))
        score = max(0.0, min(1.0, score))
    except (TypeError, ValueError):
        score = 0.0

    note = str(parsed.get("note", "")).strip()
    connection_type = str(parsed.get("connection_type", "associative")).strip().lower()

    if connection_type not in VALID_CONNECTION_TYPES:
        connection_type = "associative"  # safe fallback

    return {
        "score":           score,
        "note":            note,
        "connection_type": connection_type,
    }
