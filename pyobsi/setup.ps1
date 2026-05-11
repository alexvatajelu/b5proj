# setup.ps1
# Run this once on any new device to get everything working.
# Usage: right-click > "Run with PowerShell", or: powershell -ExecutionPolicy Bypass -File setup.ps1

Write-Host ""
Write-Host "=== b5proj setup ===" -ForegroundColor Cyan

# ── 1. Conda environment ──────────────────────────────────────────────────────
Write-Host ""
Write-Host ">> Setting up conda environment from environment.yml..." -ForegroundColor Yellow

$condaExists = Get-Command conda -ErrorAction SilentlyContinue
if (-not $condaExists) {
    Write-Host "   ERROR: conda not found. Install Miniconda or Anaconda first." -ForegroundColor Red
    Write-Host "   https://docs.conda.io/en/latest/miniconda.html"
    exit 1
}

# Check if env already exists
$envExists = conda env list | Select-String "obsillm_env"
if ($envExists) {
    Write-Host "   Environment 'obsillm_env' already exists — updating..." -ForegroundColor Gray
    conda env update -f environment.yml --prune
} else {
    Write-Host "   Creating environment 'obsillm_env'..."
    conda env create -f environment.yml
}

Write-Host "   Conda environment ready." -ForegroundColor Green

# ── 2. Ollama ─────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host ">> Checking Ollama..." -ForegroundColor Yellow

$ollamaExists = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollamaExists) {
    Write-Host "   ERROR: ollama not found. Install it from https://ollama.com/download" -ForegroundColor Red
    Write-Host "   After installing, re-run this script."
    exit 1
}

# Check if model is already present
$modelExists = ollama list 2>$null | Select-String "llama3.1:8b"
if ($modelExists) {
    Write-Host "   Model 'llama3.1:8b' already present — skipping pull." -ForegroundColor Gray
} else {
    Write-Host "   Pulling llama3.1:8b (approx 4.7GB, this will take a while)..."
    ollama pull llama3.1:8b
    if ($LASTEXITCODE -ne 0) {
        Write-Host "   ERROR: ollama pull failed. Make sure Ollama is running (ollama serve)." -ForegroundColor Red
        exit 1
    }
    Write-Host "   Model downloaded." -ForegroundColor Green
}

# ── 3. Done ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=== Setup complete! ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "To activate the environment:"
Write-Host "  conda activate obsillm_env"
Write-Host ""
Write-Host "To start Ollama (if not already running as a service):"
Write-Host "  ollama serve"
Write-Host ""
Write-Host "To test the LLM functions:"
Write-Host "  python pyobsi1/test_llm_functions.py"
Write-Host ""
