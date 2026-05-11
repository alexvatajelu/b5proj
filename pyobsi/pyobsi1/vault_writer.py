"""
vault_writer.py
Writes Obsidian-format .md files into a target folder.
One file per item. Only writes links where connection score >= min_score.

Output format for each Subject.md:

  # Subject

  ## Connections
  - [[Other Subject]] — thematic (0.82): Both relate to Cold War intelligence.
  - [[Another]] — causal (0.71): Subject directly enabled Another's formation.

  ---
  *Discovered via: manual | Added: 2026-05-11*
"""

import os
import re
from state import connections_for_item, all_items


# Map connection types to a short symbol for quick visual scanning
CONNECTION_SYMBOLS = {
    "causal":       "→",
    "thematic":     "≈",
    "temporal":     "⏱",
    "associative":  "↔",
    "oppositional": "✕",
    "hierarchical": "⊃",
}


def _safe_filename(name: str) -> str:
    """
    Convert a subject name to a safe filename.
    Obsidian uses the filename (without .md) as the display name in [[links]],
    so we preserve case and only strip characters that are invalid in Windows paths.
    """
    # Remove characters Windows/Mac filesystems reject
    return re.sub(r'[\\/:*?"<>|]', "_", name).strip()


def write_vault(
    vault_dir: str,
    reference_data: dict,
    min_score: float = 0.5,
    overwrite: bool = True,
) -> list[str]:
    """
    Write one .md file per item in reference_data into vault_dir.

    Args:
        vault_dir:      Path to the Obsidian folder to write into.
        reference_data: The full reference dict from state.py.
        min_score:      Only include connections at or above this score.
        overwrite:      If False, skip files that already exist.

    Returns:
        List of file paths written.
    """
    os.makedirs(vault_dir, exist_ok=True)
    written = []

    for item_name, item_meta in reference_data["items"].items():
        path = os.path.join(vault_dir, _safe_filename(item_name) + ".md")

        if not overwrite and os.path.exists(path):
            continue

        content = _build_md(item_name, item_meta, reference_data, min_score)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        written.append(path)

    return written


def write_single(
    vault_dir: str,
    item_name: str,
    item_meta: dict,
    reference_data: dict,
    min_score: float = 0.5,
) -> str:
    """Write (or overwrite) the .md file for a single item. Returns the path."""
    os.makedirs(vault_dir, exist_ok=True)
    path = os.path.join(vault_dir, _safe_filename(item_name) + ".md")
    content = _build_md(item_name, item_meta, reference_data, min_score)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def _build_md(
    name: str,
    meta: dict,
    reference_data: dict,
    min_score: float,
) -> str:
    """Build the markdown string for a single item."""
    conns = connections_for_item(reference_data, name, min_score=min_score)

    lines = [f"# {name}", ""]

    if conns:
        lines.append("## Connections")
        lines.append("")
        for c in conns:
            symbol = CONNECTION_SYMBOLS.get(c["connection_type"], "·")
            score_pct = int(c["score"] * 100)
            note = c["note"].rstrip(".")
            lines.append(
                f"- [[{c['other']}]] {symbol} *{c['connection_type']}* ({score_pct}%): {note}."
            )
        lines.append("")
    else:
        lines.append("*No connections above threshold yet.*")
        lines.append("")

    # Metadata footer
    lines.append("---")
    source = meta.get("source", "unknown")
    added  = meta.get("added", "")[:10]  # date only
    lines.append(f"*Source: {source} · Added: {added}*")
    lines.append("")

    return "\n".join(lines)
