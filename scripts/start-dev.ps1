param([string]$DataPath = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'prepare-dev.ps1') -DataPath $DataPath -SkipFrontend
Push-Location $root
try {
  Remove-Item Env:ASPNETCORE_URLS -ErrorAction SilentlyContinue
  dotnet run --project src/PiPlayer.AppHost
  if ($LASTEXITCODE -ne 0) { throw "Development server exited with code $LASTEXITCODE" }
} finally { Pop-Location }
