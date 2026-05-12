"""
pull_model.py
Downloads an Ollama model via the HTTP API — no CLI required.
Run this once after opening the Ollama desktop app:
    python pull_model.py
"""

import json
import requests

OLLAMA_BASE = "http://localhost:11434"
MODEL = "llama3.1:8b"
#MODEL = "qwen2.5:3b"


def pull_model(model: str = MODEL) -> None:
    print(f"Pulling model '{model}' from Ollama...")
    print("(This is ~4.7GB — go make a coffee)\n")

    try:
        response = requests.post(
            f"{OLLAMA_BASE}/api/pull",
            json={"name": model},
            stream=True,
            timeout=600,  # 10 min timeout for large downloads
        )
    except requests.exceptions.ConnectionError:
        print(
            "ERROR: Could not reach Ollama.\n"
            "Make sure the Ollama desktop app is open and running."
        )
        return

    if response.status_code != 200:
        print(f"ERROR: Ollama returned status {response.status_code}: {response.text}")
        return

    # Ollama streams progress as newline-delimited JSON
    last_status = ""
    for line in response.iter_lines():
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue

        status = data.get("status", "")

        # Print layer-level progress without spamming every byte update
        if status != last_status:
            if "total" in data and "completed" in data:
                total = data["total"]
                completed = data["completed"]
                pct = (completed / total * 100) if total else 0
                print(f"  {status}: {pct:.1f}%", end="\r")
            else:
                print(f"  {status}")
            last_status = status

    print(f"\nDone. Model '{model}' is ready.")


def check_model_present(model: str = MODEL) -> bool:
    """Returns True if the model is already downloaded."""
    try:
        response = requests.get(f"{OLLAMA_BASE}/api/tags", timeout=10)
        if response.status_code != 200:
            return False
        models = response.json().get("models", [])
        return any(m.get("name", "").startswith(model) for m in models)
    except requests.exceptions.ConnectionError:
        return False


if __name__ == "__main__":
    if check_model_present(MODEL):
        print(f"Model '{MODEL}' is already present — nothing to do.")
    else:
        pull_model(MODEL)
