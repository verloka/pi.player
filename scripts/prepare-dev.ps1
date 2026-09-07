param([string]$DataPath = '', [switch]$SkipFrontend, [switch]$Reinstall)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
if (!$DataPath) { $DataPath = $env:PiPlayer__DataPath }
if (!$DataPath) { $DataPath = Join-Path $root 'artifacts/dev-data' }
$env:PiPlayer__DataPath = [IO.Path]::GetFullPath($DataPath)
$env:ASPNETCORE_ENVIRONMENT = 'Development'
New-Item -ItemType Directory -Force -Path $env:PiPlayer__DataPath | Out-Null
function Check-DevExit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed ($LASTEXITCODE)" } }
Push-Location $root
try {
  Push-Location src/PiPlayer.Web
  try {
    $lockHash = (Get-FileHash package-lock.json -Algorithm SHA256).Hash
    $stamp = Join-Path $root 'artifacts/dev-npm-lock.txt'
    if ($Reinstall -or !(Test-Path node_modules/@angular/build) -or !(Test-Path $stamp) -or (Get-Content $stamp -Raw).Trim() -ne $lockHash) {
      npm ci; Check-DevExit 'npm ci'
      New-Item -ItemType Directory -Force (Split-Path $stamp -Parent) | Out-Null
      Set-Content -LiteralPath $stamp -Value $lockHash
    }
  } finally { Pop-Location }
  # Aspire serves the UI from the Angular dev server. wwwroot is only needed to open the backend port directly.
  if (!$SkipFrontend) {
    Push-Location src/PiPlayer.Web
    try { npm run build -- --configuration development; Check-DevExit 'Angular debug build' } finally { Pop-Location }
    $webroot = Join-Path $root 'src/PiPlayer.Server/wwwroot'
    New-Item -ItemType Directory -Force -Path $webroot | Out-Null
    Copy-Item -Path (Join-Path $root 'src/PiPlayer.Web/dist/pi-player/browser/*') -Destination $webroot -Recurse -Force
  }
  dotnet build src/PiPlayer.AppHost -c Debug; Check-DevExit 'Aspire build'
  Write-Host 'Debug ready. Aspire runs the backend on http://localhost:5000 and the Angular dev server on http://localhost:4200.'
  Write-Host 'Pages: http://localhost:4200/admin (control panel) and http://localhost:4200/screen (player). No login: the appliance has no accounts.'
  Write-Host "Local data: $env:PiPlayer__DataPath"
} finally { Pop-Location }
