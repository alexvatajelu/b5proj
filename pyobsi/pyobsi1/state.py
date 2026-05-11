"""
state.py
Manages the reference JSON file — the persistent cache of all items and
connections the system has ever analysed.

Reference file structure:
{
  "items": {
    "CIA": {
      "source": "manual",        # "manual" or "discovered"
      "added": "2026-05-11T..."
    }
  },
  "connections": {
    "CIA|KGB": {
      "score": 0.88,
      "note": "Both were primary Cold War intelligence agencies...",
      "connection_type": "oppositional",
      "timestamp": "2026-05-11T..."
    }
  }
}
"""

import json
import os
from datetime import datetime

DEFAULT_REFERENCE = {"items": {}, "connections": {}}


def load_reference(path: str) -> dict:
    """Load reference file from disk. Returns empty structure if file doesn't exist."""
    if not os.path.exists(path):
        return {"items": {}, "connections": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        # Ensure both keys exist in case of a partial/old file
        data.setdefault("items", {})
        data.setdefault("connections", {})
        return data
    except (json.JSONDecodeError, OSError) as e:
        print(f"[state] Could not load reference file: {e}. Starting fresh.")
        return {"items": {}, "connections": {}}


def save_reference(path: str, data: dict) -> None:
    """Write reference data to disk, creating parent directories if needed."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# ── Items ─────────────────────────────────────────────────────────────────────

def add_item(data: dict, name: str, source: str = "manual") -> bool:
    """
    Add an item to the reference. Returns True if it was newly added.
    Preserves existing items (won't overwrite source/added).
    """
    if name not in data["items"]:
        data["items"][name] = {
            "source": source,
            "added": datetime.now().isoformat(timespec="seconds"),
        }
        return True
    return False


def all_items(data: dict) -> list[str]:
    """Return all known item names."""
    return list(data["items"].keys())


# ── Connections ───────────────────────────────────────────────────────────────

def _connection_key(a: str, b: str) -> str:
    """Canonical sorted key so (A|B) == (B|A)."""
    return "|".join(sorted([a, b]))


def get_cached_connection(data: dict, a: str, b: str) -> dict | None:
    """Return cached connection result, or None if not yet analysed."""
    key = _connection_key(a, b)
    return data["connections"].get(key)


def cache_connection(data: dict, a: str, b: str, result: dict) -> None:
    """
    Store a connection result. result should have: score, note, connection_type.
    Adds a timestamp automatically.
    """
    key = _connection_key(a, b)
    data["connections"][key] = {
        "score":           result["score"],
        "note":            result["note"],
        "connection_type": result["connection_type"],
        "timestamp":       datetime.now().isoformat(timespec="seconds"),
    }


def connections_for_item(data: dict, name: str, min_score: float = 0.0) -> list[dict]:
    """
    Return all connections involving a given item, filtered by min_score.
    Each dict has: other (str), score, note, connection_type.
    """
    results = []
    for key, conn in data["connections"].items():
        parts = key.split("|", 1)
        if len(parts) != 2:
            continue
        a, b = parts
        if name in (a, b):
            other = b if a == name else a
            if conn["score"] >= min_score:
                results.append({
                    "other":           other,
                    "score":           conn["score"],
                    "note":            conn["note"],
                    "connection_type": conn["connection_type"],
                })
    results.sort(key=lambda x: x["score"], reverse=True)
    return results


def summary(data: dict) -> str:
    """Human-readable summary of what's in the reference file."""
    n_items = len(data["items"])
    n_conn  = len(data["connections"])
    manual  = sum(1 for v in data["items"].values() if v.get("source") == "manual")
    disc    = n_items - manual
    return (
        f"{n_items} items ({manual} manual, {disc} discovered), "
        f"{n_conn} connections analysed"
    )
