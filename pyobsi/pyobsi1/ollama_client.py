"""
ollama_client.py
Thin wrapper around the Ollama local API.
Assumes Ollama is running on localhost:11434 with llama3.1:8b-instruct-q4_K_M pulled.
"""

import json
import requests
from typing import Optional

OLLAMA_URL = "http://localhost:11434/api/generate"
DEFAULT_MODEL = "llama3.1:8b"

# Ollama model options — tune these for your hardware
OLLAMA_OPTIONS = {
    "temperature": 0.2,       # Low = more deterministic JSON output
    "top_p": 0.9,
    "num_predict": 512,        # Max tokens in response
    "num_ctx": 4096,           # Context window
}


def query_ollama(
    prompt: str,
    system: Optional[str] = None,
    model: str = DEFAULT_MODEL,
    expect_json: bool = True,
) -> str:
    """
    Send a prompt to Ollama and return the response text.

    Args:
        prompt:      The user prompt.
        system:      Optional system message.
        model:       Ollama model string.
        expect_json: If True, appends a JSON reminder and sets format.

    Returns:
        Raw response string from the model.

    Raises:
        ConnectionError: If Ollama is not reachable.
        RuntimeError:    If the API returns an error status.
    """
    if expect_json:
        prompt = prompt.strip() + "\n\nRespond ONLY with valid JSON. No explanation, no markdown, no code fences."

    payload = {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "options": OLLAMA_OPTIONS,
    }

    if system:
        payload["system"] = system

    if expect_json:
        payload["format"] = "json"  # Ollama's built-in JSON mode (Llama 3.1 supports this)

    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=120)
    except requests.exceptions.ConnectionError:
        raise ConnectionError(
            "Could not reach Ollama. Make sure it's running: `ollama serve`"
        )

    if response.status_code != 200:
        raise RuntimeError(
            f"Ollama returned status {response.status_code}: {response.text}"
        )

    data = response.json()
    return data.get("response", "").strip()


def parse_json_response(raw: str, retry_prompt: Optional[str] = None) -> dict:
    """
    Parse a JSON string from the model response, with one retry on failure.

    Args:
        raw:          Raw string returned by the model.
        retry_prompt: If provided and first parse fails, re-queries with this prompt.

    Returns:
        Parsed dict.

    Raises:
        ValueError: If JSON cannot be parsed after retrying.
    """
    # Strip accidental markdown fences if model ignores the instruction
    cleaned = raw.strip().lstrip("```json").lstrip("```").rstrip("```").strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        if retry_prompt:
            print("[ollama_client] JSON parse failed, retrying with stricter prompt...")
            retry_raw = query_ollama(retry_prompt, expect_json=True)
            retry_cleaned = retry_raw.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
            try:
                return json.loads(retry_cleaned)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"JSON parse failed after retry.\nRaw response: {retry_raw}\nError: {e}"
                )
        raise ValueError(
            f"JSON parse failed.\nRaw response: {raw}"
        )
