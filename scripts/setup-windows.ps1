#Requires -Version 5.1
<#
.SYNOPSIS
  One-shot setup for speech-to-speech on Windows with CUDA.
.DESCRIPTION
  Order matters: upgrade pip, install the project, THEN force-install a CUDA
  build of torch last (otherwise the project install pulls a CPU torch wheel
  from PyPI and overwrites the CUDA one).
  - venv lookup order: -VenvPath > parent .venv > project .venv > create new
  - CUDA index: cu128 by default (matching torch/torchaudio pair); see fix-torch.ps1
  - TTS extra: kokoro (light, fits a 4GB GPU)
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows.ps1
#>
param(
    [string]$VenvPath = "",
    [string]$Extras = "kokoro"
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ParentRoot = Split-Path -Parent $ProjectRoot

Write-Host "==> [1/4] Locate virtual environment" -ForegroundColor Cyan
if (-not $VenvPath) {
    $parentVenv = Join-Path $ParentRoot ".venv"
    $innerVenv  = Join-Path $ProjectRoot ".venv"
    if (Test-Path (Join-Path $parentVenv "Scripts\python.exe")) {
        $VenvPath = $parentVenv
    } elseif (Test-Path (Join-Path $innerVenv "Scripts\python.exe")) {
        $VenvPath = $innerVenv
    }
}

$py  = Join-Path $VenvPath "Scripts\python.exe"
$pip = Join-Path $VenvPath "Scripts\pip.exe"

if ($VenvPath -and (Test-Path $py)) {
    Write-Host "  reuse existing venv: $VenvPath"
} else {
    $venvDir = Join-Path $ParentRoot ".venv"
    Write-Host "  venv not found, creating $venvDir ..."
    python -m venv $venvDir
    $VenvPath = $venvDir
    $py  = Join-Path $VenvPath "Scripts\python.exe"
    $pip = Join-Path $VenvPath "Scripts\pip.exe"
    if (-not (Test-Path $py)) { throw "failed to create venv" }
}
& $py --version

Write-Host "==> [2/4] Upgrade pip, then install project (extras: $Extras)" -ForegroundColor Cyan
& $py -m pip install --upgrade pip
Push-Location $ProjectRoot
try {
    & $pip install -e ".[$Extras]"
} finally {
    Pop-Location
}

Write-Host "==> [3/4] Force-install a CUDA torch build (last, so nothing overwrites it)" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "fix-torch.ps1") -VenvPath $VenvPath

Write-Host "==> [4/4] Verify" -ForegroundColor Cyan
& $py -c "import torch; print('torch          =', torch.__version__); print('cuda_available =', torch.cuda.is_available())"

Write-Host ""
Write-Host "Setup complete. Next:" -ForegroundColor Green
Write-Host "  set OPENAI_API_KEY=your_deepseek_key   (cmd)"
Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1"
