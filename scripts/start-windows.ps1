#Requires -Version 5.1
<#
.SYNOPSIS
  Launch speech-to-speech on Windows.
.DESCRIPTION
  - default LLM: DeepSeek via chat-completions (set $env:OPENAI_API_KEY first)
  - default TTS: kokoro (fits 4GB VRAM); qwen3 auto-adds torch backend + cpu
  - run scripts\setup-windows.ps1 first
.EXAMPLE
  .\scripts\start-windows.ps1
  .\scripts\start-windows.ps1 -Local
  .\scripts\start-windows.ps1 -Model deepseek-reasoner
#>
param(
    [switch]$Local,
    [string]$Model = "deepseek-chat",
    [string]$Tts = "kokoro",
    [string]$LlmBackend = "chat-completions",
    [string]$BaseUrl = "https://api.deepseek.com",
    [string]$VenvPath = ""
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ParentRoot = Split-Path -Parent $ProjectRoot

# locate venv (same order as setup-windows.ps1)
if (-not $VenvPath) {
    $parentVenv = Join-Path $ParentRoot ".venv"
    $innerVenv  = Join-Path $ProjectRoot ".venv"
    if (Test-Path (Join-Path $parentVenv "Scripts\python.exe")) {
        $VenvPath = $parentVenv
    } elseif (Test-Path (Join-Path $innerVenv "Scripts\python.exe")) {
        $VenvPath = $innerVenv
    }
}

$cli = Join-Path $VenvPath "Scripts\speech-to-speech.exe"
if (-not (Test-Path $cli)) {
    throw "speech-to-speech.exe not found under $VenvPath\Scripts ; run scripts\setup-windows.ps1 first"
}

if (-not $env:OPENAI_API_KEY) {
    Write-Warning "OPENAI_API_KEY is not set; the cloud LLM will fail."
}

$command = if ($Local) { "local" } else { "serve" }
$cliArgs = @($command, "--tts", $Tts, "--llm_backend", $LlmBackend, "--model_name", $Model)
if ($BaseUrl) {
    $cliArgs += @("--responses_api_base_url", $BaseUrl)
}
# Do not send OpenAI-specific reasoning fields to non-OpenAI providers (DeepSeek).
# Note: use trailing '=' to pass an empty value (PowerShell 5.1 drops a bare empty-string arg).
$cliArgs += @("--responses_api_reasoning_effort=", "--responses_api_disable_thinking", "false")
if ($Tts -eq "qwen3") {
    # Windows has no ggml backend; 4GB VRAM -> run on CPU to avoid OOM
    $cliArgs += @("--qwen3_tts_backend", "torch", "--qwen3_tts_device", "cpu")
}

Write-Host "launch: speech-to-speech $($cliArgs -join ' ')" -ForegroundColor Cyan
& $cli @cliArgs
