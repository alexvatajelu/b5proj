"""
parse_to_csv.py
---------------
Parses the operation log text file into a CSV.

Usage:
    python parse_to_csv.py input.txt output.csv

If no arguments are given it defaults to:
    input  -> operations.txt  (in the same folder)
    output -> operations.csv  (in the same folder)
"""

import re
import csv
import sys
from pathlib import Path

# ── Column headers ──────────────────────────────────────────────────────────
HEADERS = [
    "Location",
    "Date",
    "Duration",
    "Operation Type",
    "Officers Deployed",
    "Rate",
    "Total Stops",
    "Searches (No Further Action)",
    "Searches (Arrested)",
    "Searches (Col4)",
    "Searches (Col5)",
    "Hit Rate %",
    "Outcome A",
    "Outcome B",
    "Outcome C",
    "Footfall / Value",
]

# ── Regex anchored on the date field ────────────────────────────────────────
RECORD_RE = re.compile(
    r"(\d{2}/\d{2}/\d{2})\s+"                              # date
    r"(\d+\s*h(?:r)?\s*\d+\s*m)\s+"                        # duration
    r"(Crime Hotspot|Event\s*-?\s*PSO|CNI\s+PSO)\s+"       # operation type
    r"(\d+)\s+"                                             # officers deployed
    r"([\d.]+)\s+"                                          # rate (0.64)
    r"(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+"           # stop counts
    r"([\d.]+%)\s+"                                         # hit rate
    r"(\d+)\s+(\d+)\s+(\d+)\s+"                            # outcome cols
    r"([\d,]+)"                                             # footfall / value
)


def parse(input_path: Path) -> list[dict]:
    raw = input_path.read_text(encoding="utf-8")

    # Collapse line-breaks and extra spaces into a single space so that
    # multi-line location names become single-line strings.
    text = re.sub(r"[ \t]*\n[ \t]*", " ", raw)
    text = re.sub(r" {2,}", " ", text).strip()

    matches = list(RECORD_RE.finditer(text))
    if not matches:
        raise ValueError("No records found – check that the input file matches the expected format.")

    rows = []
    for i, m in enumerate(matches):
        # The location is the text between the end of the previous record
        # and the start of this record's date.
        prev_end = matches[i - 1].end() if i > 0 else 0
        location = text[prev_end : m.start()].strip()
        # Strip any leading/trailing punctuation or digits left over
        location = re.sub(r"^[\d,\s]+", "", location).strip()

        rows.append({
            "Location":                   location,
            "Date":                       m.group(1),
            "Duration":                   re.sub(r"\s+", "", m.group(2)),  # "4h47m"
            "Operation Type":             re.sub(r"\s+", " ", m.group(3)).strip(),
            "Officers Deployed":          m.group(4),
            "Rate":                       m.group(5),
            "Total Stops":                m.group(6),
            "Searches (No Further Action)": m.group(7),
            "Searches (Arrested)":        m.group(8),
            "Searches (Col4)":            m.group(9),
            "Searches (Col5)":            m.group(10),
            "Hit Rate %":                 m.group(11),
            "Outcome A":                  m.group(12),
            "Outcome B":                  m.group(13),
            "Outcome C":                  m.group(14),
            "Footfall / Value":           m.group(15).replace(",", ""),
        })

    return rows


def main():
    input_path  = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("operations.txt")
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("operations.csv")

    if not input_path.exists():
        print(f"Error: cannot find input file '{input_path}'")
        sys.exit(1)

    rows = parse(input_path)

    with output_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=HEADERS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Done! Wrote {len(rows)} rows to '{output_path}'")


if __name__ == "__main__":
    main()