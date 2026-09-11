param([string]$Version = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
if (!$Version) {
  $Version = '2.1.0-build.' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '.' + [Guid]::NewGuid().ToString('N').Substring(0,6)
}
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') { throw 'Invalid release version' }
$releaseName = "pi-player-$Version-linux-arm64"
$releaseRoot = Join-Path $root "publish/$releaseName"
$archive = Join-Path $root "artifacts/$releaseName.tar.gz"
foreach ($outputPath in @($releaseRoot, $archive, "$archive.sha256")) {
  if (Test-Path -LiteralPath $outputPath) { throw "Release output already exists: $outputPath. Omit -Version to generate a unique release, or use a new version." }
}
function Check-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed ($LASTEXITCODE)" } }
Push-Location $root
try {
  $sdk = dotnet --version; Check-Exit 'dotnet'
  $node = node --version; Check-Exit 'Node'
  $npm = npm --version; Check-Exit 'npm'
  if ($sdk -notmatch '^10\.0\.4' -or $node -ne 'v22.22.2' -or $npm -ne '10.9.7') { throw 'Required: .NET 10.0.400 feature band, Node 22.22.2, npm 10.9.7 (see global.json and package.json)' }
  Push-Location src/PiPlayer.Web
  try {
    npm ci; Check-Exit 'npm ci'
    npm test; Check-Exit 'frontend tests'
    npm run build; Check-Exit 'frontend build'
  } finally { Pop-Location }
  $browser = Join-Path $root 'src/PiPlayer.Web/dist/pi-player/browser'
  if (!(Test-Path -LiteralPath (Join-Path $browser 'index.html'))) { throw 'Angular browser index.html is missing' }
  $webroot = [IO.Path]::GetFullPath((Join-Path $root 'src/PiPlayer.Server/wwwroot'))
  $workspaceRoot = [IO.Path]::GetFullPath($root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  if (!$webroot.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($webroot) -ne 'wwwroot') { throw 'Unexpected webroot' }
  if ((Test-Path -LiteralPath $webroot) -and (Get-Item -LiteralPath $webroot).Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Generated webroot must not be a symlink/junction' }
  # Only generated webroot contents are removed; user data is outside this directory.
  if (Test-Path -LiteralPath $webroot) { Get-ChildItem -LiteralPath $webroot -Force | Remove-Item -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $webroot | Out-Null
  Copy-Item -Path (Join-Path $browser '*') -Destination $webroot -Recurse
  dotnet restore PiPlayer.sln --locked-mode; Check-Exit 'locked restore'
  dotnet test PiPlayer.sln -c Release --logger 'trx;LogFileName=backend.trx' --results-directory artifacts/test-results; Check-Exit 'backend tests'
  dotnet publish src/PiPlayer.Server/PiPlayer.Server.csproj -c Release -r linux-arm64 --self-contained true -p:PublishTrimmed=false -o $releaseRoot; Check-Exit 'ARM64 publish'
  Copy-Item -LiteralPath scripts -Destination $releaseRoot -Recurse
  Copy-Item -LiteralPath docs -Destination $releaseRoot -Recurse
  Copy-Item -LiteralPath README.md,IMPLEMENTATION-STATUS.md -Destination $releaseRoot
  # Runtime data, credentials, browser profiles and development configuration never enter releases.
  $forbidden = Get-ChildItem -LiteralPath $releaseRoot -Recurse -Force | Where-Object { $_.Name -in @('data','admin-password.json','appsettings.Development.json','appsettings.Production.json','chromium-profile') }
  if ($forbidden) { throw 'Unexpected private or machine-specific files in release' }
  @{ version=$Version; rid='linux-arm64'; selfContained=$true; sdk=$sdk; node=$node; npm=$npm; builtAtUtc=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $releaseRoot 'release.json') -Encoding utf8
  # Path.GetRelativePath is unavailable in Windows PowerShell 5.1 (.NET Framework).
  $releasePrefix = [IO.Path]::GetFullPath($releaseRoot) + [IO.Path]::DirectorySeparatorChar
  $manifest = foreach ($file in Get-ChildItem -LiteralPath $releaseRoot -Recurse -File | Sort-Object FullName) {
    if (!$file.FullName.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "File outside release directory: $($file.FullName)" }
    $relative = $file.FullName.Substring($releasePrefix.Length).Replace('\','/')
    '{0}  {1}' -f (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(), $relative
  }
  [IO.File]::WriteAllLines((Join-Path $releaseRoot 'SHA256SUMS'), $manifest, [Text.UTF8Encoding]::new($false))
  New-Item -ItemType Directory -Force -Path (Split-Path $archive -Parent) | Out-Null
  tar -czf $archive -C (Split-Path $releaseRoot -Parent) $releaseName; Check-Exit 'archive'
  $checksum = '{0}  {1}' -f (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant(), [IO.Path]::GetFileName($archive)
  [IO.File]::WriteAllText("$archive.sha256", "$checksum`n", [Text.UTF8Encoding]::new($false))
  Write-Output "Release ready: $archive"
  Write-Output $checksum
} finally { Pop-Location }
