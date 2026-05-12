"""
ollama_client.py
Thin wrapper around the Ollama local API.
Assumes Ollama is running on localhost:11434 with llama3.1:8b pulled.

RTX 2080 8 GB tuning
--------------------
llama3.1:8b Q4_K_M occupies ≈ 4.7 GB VRAM.  The remaining ≈ 3.3 GB is
available for the KV cache and batch buffers.

Key settings (adjust in OLLAMA_OPTIONS below):

  num_ctx   — Context window in tokens.  2048 is ample for the prompts
              used here and keeps KV-cache pressure low.  Only raise this
              if you're injecting very long web snippets.

  num_batch — Prompt-evaluation batch size.  512 is a safe default on 8 GB;
              raise to 1024 if you have headroom for faster prompt ingestion.

  num_predict — Max new tokens to generate.  512 is generous for JSON
                responses; trim to 256 if responses are consistently short
                to save a few tokens of latency.

  temperature / top_p — Low temperature (0.2) makes JSON output more
                        deterministic and reduces parse failures.

Ollama environment variables (set before `ollama serve`):

  OLLAMA_NUM_PARALLEL=1   — Keep at 1 on 8 GB.  The model alone uses 4.7 GB;
                            two concurrent instances would exceed VRAM.

  OLLAMA_FLASH_ATTENTION=1 — Enable Flash Attention if your Ollama build
                             supports it; reduces KV-cache memory and can
                             give a 10–20 % speed boost.
"""

import json
import requests
from typing import Optional

OLLAMA_URL    = "http://localhost:11434/api/generate"

DEFAULT_MODEL = "llama3.1:8b"
OLLAMA_OPTIONS = {
    "temperature":  0.2,    # Low = more deterministic JSON; reduce parse failures
    "top_p":        0.9,
    "num_predict":  512,    # Max tokens in response (JSON payloads are short)
    "num_ctx":      2048,   # Context window — 2048 is plenty; saves VRAM vs 4096
    "num_batch":    512,    # Prompt eval batch size — safe on 8 GB
}
'''
DEFAULT_MODEL = "qwen2.5:3b"
OLLAMA_OPTIONS = {
    "temperature":  0.15,
    "top_p":        0.9,
    "num_predict":  256,
    "num_ctx":      2048,
    "num_batch":    512,
}
'''

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
        expect_json: If True, appends a JSON reminder and sets format="json".

    Returns:
        Raw response string from the model.

    Raises:
        ConnectionError: If Ollama is not reachable.
        RuntimeError:    If the API returns an error status.
    """
    if expect_json:
        prompt = (
            prompt.strip()
            + "\n\nRespond ONLY with valid JSON. No explanation, no markdown, no code fences."
        )

    payload: dict = {
        "model":   model,
        "prompt":  prompt,
        "stream":  False,
        "options": OLLAMA_OPTIONS,
    }

    if system:
        payload["system"] = system

    if expect_json:
        payload["format"] = "json"   # Ollama built-in JSON mode (Llama 3.1 supports this)

    try:
        response = requests.post(OLLAMA_URL, json=payload, timeout=120)
    except requests.exceptions.ConnectionError:
        raise ConnectionError(
            "Could not reach Ollama. Make sure it's running: `ollama serve`\n"
            "Tip: set OLLAMA_FLASH_ATTENTION=1 before serving for better performance."
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
    # Strip accidental markdown fences if the model ignores the instruction
    cleaned = raw.strip().lstrip("```json").lstrip("```").rstrip("```").strip()

    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        if retry_prompt:
            print("[ollama_client] JSON parse failed — retrying with stricter prompt…")
            retry_raw     = query_ollama(retry_prompt, expect_json=True)
            retry_cleaned = retry_raw.strip().lstrip("```json").lstrip("```").rstrip("```").strip()
            try:
                return json.loads(retry_cleaned)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"JSON parse failed after retry.\nRaw: {retry_raw}\nError: {e}"
                )
        raise ValueError(f"JSON parse failed.\nRaw response: {raw}")
