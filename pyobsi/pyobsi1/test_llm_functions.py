"""
test_llm_functions.py
Quick sanity check for find_related_subjects and get_connection.
Run this after `ollama serve` and `ollama pull llama3.1:8b-instruct-q4_K_M`.
"""

import json
from llm_functions import find_related_subjects, get_connection


def print_json(data):
    print(json.dumps(data, indent=2))


if __name__ == "__main__":

    CONTEXT = "Cold War espionage investigation"

    # -----------------------------------------------------------------------
    print("\n" + "="*60)
    print("TEST 1 — find_related_subjects")
    print("="*60)
    print(f"Subject: 'CIA'  |  Context: '{CONTEXT}'\n")

    related = find_related_subjects(
        subject="CIA",
        context=CONTEXT,
        max_results=6,
        min_relevance=0.5,
        use_web=True,
    )

    if related:
        print(f"Found {len(related)} related subjects:\n")
        print_json(related)
    else:
        print("No results returned.")

    # -----------------------------------------------------------------------
    print("\n" + "="*60)
    print("TEST 2 — get_connection")
    print("="*60)
    print(f"Subject A: 'CIA'  |  Subject B: 'KGB'  |  Context: '{CONTEXT}'\n")

    connection = get_connection(
        subject_a="CIA",
        subject_b="KGB",
        context=CONTEXT,
        use_web=True,
    )

    if connection:
        print("Connection result:\n")
        print_json(connection)
    else:
        print("No connection result returned.")

    # -----------------------------------------------------------------------
    print("\n" + "="*60)
    print("TEST 3 — get_connection (expected low score)")
    print("="*60)
    print("Subject A: 'CIA'  |  Subject B: 'Impressionist painting'\n")

    weak = get_connection(
        subject_a="CIA",
        subject_b="Impressionist painting",
        use_web=False,  # no web needed for an obvious weak link
    )

    if weak:
        print("Connection result:\n")
        print_json(weak)
