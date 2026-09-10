#Requires -Version 5.1
<#
.SYNOPSIS
  Force-install a CUDA build of torch/torchaudio and verify CUDA availability.
.DESCRIPTION
  Upgrades pip first (old pip 23.0.x mis-parses wheel metadata), then tries
  several PyTorch CUDA wheel indexes in order and stops at the first one that
  yields torch.cuda.is_available() == True.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\fix-torch.ps1
#>
param(
    [string]$VenvPath = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ParentRoot = Split-Path -Parent $ProjectRoot

if (-not $VenvPath) {
    $parentVenv = Join-Path $ParentRoot ".venv"
    $innerVenv  = Join-Path $ProjectRoot ".venv"
    if (Test-Path (Join-Path $parentVenv "Scripts\python.exe")) { $VenvPath = $parentVenv }
    elseif (Test-Path (Join-Path $innerVenv "Scripts\python.exe")) { $VenvPath = $innerVenv }
}

$py  = Join-Path $VenvPath "Scripts\python.exe"
$pip = Join-Path $VenvPath "Scripts\pip.exe"
if (-not (Test-Path $pip)) { throw "pip not found under $VenvPath" }

Write-Host "==> upgrade pip (fixes wheel metadata parsing in old pip)" -ForegroundColor Cyan
& $py -m pip install --upgrade pip

$ok = $false
foreach ($i in @("cu128","cu130","cu126","cu124")) {
    Write-Host "=== trying https://download.pytorch.org/whl/$i ===" -ForegroundColor Cyan
    & $pip install --force-reinstall torch torchaudio --index-url "https://download.pytorch.org/whl/$i"
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "install failed for $i"
        continue
    }
    $r = (& $py -c "import torch; print(torch.__version__, torch.cuda.is_available())").Trim()
    Write-Host "result: $r"
    if ($r -match "True") {
        Write-Host "OK: $i works" -ForegroundColor Green
        $ok = $true
        break
    }
}

if (-not $ok) {
    Write-Warning "No CUDA index produced a working torch build. Paste the output above to diagnose."
}
