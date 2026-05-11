#!/bin/bash
# setup.sh
# Run this once on any new Mac/Linux device to get everything working.
# Usage: chmod +x setup.sh && ./setup.sh

set -e  # Exit on any error

echo ""
echo "=== b5proj setup ==="

# ── 1. Conda environment ──────────────────────────────────────────────────────
echo ""
echo ">> Setting up conda environment from environment.yml..."

if ! command -v conda &> /dev/null; then
    echo "   ERROR: conda not found. Install Miniconda or Anaconda first."
    echo "   https://docs.conda.io/en/latest/miniconda.html"
    exit 1
fi

# Initialise conda for this shell session (in case it isn't already)
eval "$(conda shell.bash hook)"

if conda env list | grep -q "obsillm_env"; then
    echo "   Environment 'obsillm_env' already exists — updating..."
    conda env update -f environment.yml --prune
else
    echo "   Creating environment 'obsillm_env'..."
    conda env create -f environment.yml
fi

echo "   Conda environment ready."

# ── 2. Ollama ─────────────────────────────────────────────────────────────────
echo ""
echo ">> Checking Ollama..."

# No CLI needed — the Python code and pull_model.py talk to Ollama purely over
# HTTP (localhost:11434). The desktop app runs that server automatically.

# Check if the Ollama server is reachable
OLLAMA_UP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:11434 2>/dev/null || echo "000")

if [ "$OLLAMA_UP" = "000" ]; then
    echo ""
    echo "   ┌─────────────────────────────────────────────────────┐"
    echo "   │  ACTION REQUIRED: Ollama is not running.            │"
    echo "   │  Please open the Ollama desktop app, then press     │"
    echo "   │  Enter to continue...                               │"
    echo "   └─────────────────────────────────────────────────────┘"
    read -r

    # Re-check after user opens the app
    OLLAMA_UP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:11434 2>/dev/null || echo "000")
    if [ "$OLLAMA_UP" = "000" ]; then
        echo "   ERROR: Still can't reach Ollama. Make sure the app is open and try again."
        exit 1
    fi
fi

echo "   Ollama server is running."
echo "   Checking for model 'llama3.1:8b'..."
conda run -n obsillm_env python pull_model.py

# ── 3. Done ───────────────────────────────────────────────────────────────────
echo ""
echo "=== Setup complete! ==="
echo ""
echo "To activate the environment:"
echo "  conda activate obsillm_env"
echo ""
echo "NOTE: Make sure the Ollama desktop app is open before running the project."
echo ""
echo "To test the LLM functions:"
echo "  python pyobsi1/test_llm_functions.py"
echo ""
