"""
geocode_locations.py
--------------------
Reads unique locations from your operations CSV, compares against an existing
lookup table, and geocodes any new locations using Nominatim (OpenStreetMap).
New results are appended to the lookup table.

Usage:
    python geocode_locations.py

Configuration:
    Edit the CONFIG block below to match your file names and column names.

Requirements:
    pip install requests
"""

import csv
import time
import requests
from pathlib import Path

# ── CONFIG ───────────────────────────────────────────────────────────────────

OPERATIONS_CSV  = "2025lfr.csv"      # your parsed operations file
LOOKUP_CSV      = "locations_lookup.csv" # lookup table (created if it doesn't exist)
LOCATION_COLUMN = "Location"            # column name in operations CSV

# Nominatim asks that you identify your app in the User-Agent header.
# Replace with your name or project name — it's just a courtesy header.
USER_AGENT = "my-operations-mapper/1.0"

# Adding ", London, UK" helps Nominatim disambiguate (e.g. "Stratford Broadway"
# rather than one in another country). Adjust if your data isn't London-based.
SEARCH_SUFFIX = ", London, UK"

# Seconds to wait between requests — Nominatim's usage policy requires >= 1s.
REQUEST_DELAY = 1.1

# ── LOOKUP TABLE HELPERS ─────────────────────────────────────────────────────

LOOKUP_HEADERS = ["location_raw", "display_name", "latitude", "longitude", "nominatim_full_address"]


def load_lookup(path: Path) -> dict[str, dict]:
    """Return existing lookup as {location_raw: row_dict}."""
    if not path.exists():
        return {}
    with path.open(encoding="utf-8") as f:
        return {row["location_raw"]: row for row in csv.DictReader(f)}


def append_to_lookup(path: Path, rows: list[dict]) -> None:
    """Append new rows to the lookup CSV, creating it with headers if needed."""
    write_header = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=LOOKUP_HEADERS)
        if write_header:
            writer.writeheader()
        writer.writerows(rows)


# ── OPERATIONS CSV HELPERS ───────────────────────────────────────────────────

def load_unique_locations(path: Path, column: str) -> list[str]:
    """Return a deduplicated, sorted list of locations from the operations CSV."""
    if not path.exists():
        raise FileNotFoundError(f"Operations file not found: '{path}'")
    with path.open(encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        raise ValueError("Operations CSV is empty.")
    if column not in rows[0]:
        available = ", ".join(rows[0].keys())
        raise ValueError(f"Column '{column}' not found. Available columns: {available}")
    seen = set()
    locations = []
    for row in rows:
        loc = row[column].strip()
        if loc and loc not in seen:
            seen.add(loc)
            locations.append(loc)
    return sorted(locations)


# ── GEOCODING ────────────────────────────────────────────────────────────────

def geocode(location: str) -> dict | None:
    """
    Query Nominatim for a location. Returns a result dict or None if not found.
    Falls back to searching without the suffix if the suffixed query fails.
    """
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    for query in [location + SEARCH_SUFFIX, location]:
        try:
            resp = session.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": query, "format": "json", "limit": 1},
                timeout=10,
            )
            resp.raise_for_status()
            results = resp.json()
            if results:
                r = results[0]
                return {
                    "latitude":               r["lat"],
                    "longitude":              r["lon"],
                    "nominatim_full_address": r.get("display_name", ""),
                }
        except requests.RequestException as e:
            print(f"  ⚠ Network error for '{query}': {e}")
        time.sleep(REQUEST_DELAY)

    return None


# ── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    ops_path    = Path(OPERATIONS_CSV)
    lookup_path = Path(LOOKUP_CSV)

    print(f"Loading locations from '{ops_path}'...")
    all_locations = load_unique_locations(ops_path, LOCATION_COLUMN)
    print(f"  Found {len(all_locations)} unique locations.")

    existing = load_lookup(lookup_path)
    print(f"  {len(existing)} already in lookup table.")

    to_geocode = [loc for loc in all_locations if loc not in existing]
    print(f"  {len(to_geocode)} new location(s) to geocode.\n")

    if not to_geocode:
        print("Nothing to do — lookup table is already up to date.")
        return

    new_rows  = []
    not_found = []

    for i, location in enumerate(to_geocode, start=1):
        print(f"[{i}/{len(to_geocode)}] Geocoding: {location!r}", end=" ... ")
        result = geocode(location)

        if result:
            print(f"✓  {result['latitude']}, {result['longitude']}")
            new_rows.append({
                "location_raw":            location,
                "display_name":            location,   # edit manually if you want a tidier name
                "latitude":                result["latitude"],
                "longitude":               result["longitude"],
                "nominatim_full_address":  result["nominatim_full_address"],
            })
        else:
            print("✗  NOT FOUND")
            not_found.append(location)
            # Write a blank row so you can fill it in manually
            new_rows.append({
                "location_raw":           location,
                "display_name":           location,
                "latitude":               "",
                "longitude":              "",
                "nominatim_full_address": "NOT FOUND — fill in manually",
            })

        time.sleep(REQUEST_DELAY)

    append_to_lookup(lookup_path, new_rows)

    print(f"\nDone! Added {len(new_rows)} row(s) to '{lookup_path}'.")
    if not_found:
        print(f"\n⚠ {len(not_found)} location(s) not found — blank rows added for manual fill-in:")
        for loc in not_found:
            print(f"   • {loc}")


if __name__ == "__main__":
    main()
