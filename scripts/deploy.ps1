param(
  [Parameter(Mandatory)][string]$PiHost,
  [Parameter(Mandatory)][string]$SshUser,
  [string]$Archive = '',
  [ValidateRange(1,65535)][int]$Port = 22,
  [string]$IdentityFile = '',
  [switch]$Install,
  [string]$LanAddress = '',
  [string]$LanCidr = '',
  [string]$DataPath = '',
  [string]$ExpectedMount = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path $PSScriptRoot -Parent
if ($PiHost -notmatch '^[A-Za-z0-9][A-Za-z0-9.-]*$' -or $SshUser -notmatch '^[a-z_][a-z0-9_-]*$') { throw 'Use a plain hostname/IP and SSH username.' }
if ($Install -and ($LanAddress -notmatch '^\d{1,3}(\.\d{1,3}){3}$' -or $LanCidr -notmatch '^\d{1,3}(\.\d{1,3}){3}/\d{1,2}$')) { throw '-Install requires -LanAddress and -LanCidr.' }
if (!$Install -and ($LanAddress -or $LanCidr -or $DataPath -or $ExpectedMount)) { throw 'Machine configuration arguments require -Install.' }
foreach ($path in @($DataPath,$ExpectedMount)) { if ($path -and $path -notmatch '^/[A-Za-z0-9._/-]+$') { throw 'Use an absolute Linux data/mount path without spaces.' } }
if (!$Archive) {
  $version = '2.1.0-deploy.' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmss') + '.' + [Guid]::NewGuid().ToString('N').Substring(0,6)
  & (Join-Path $PSScriptRoot 'publish-linux-arm64.ps1') -Version $version
  $Archive = Join-Path $root "artifacts/pi-player-$version-linux-arm64.tar.gz"
}
$resolved = (Resolve-Path -LiteralPath $Archive).Path
if (!(Test-Path -LiteralPath "$resolved.sha256")) { throw 'Archive checksum file is missing.' }
$expected = ((Get-Content -LiteralPath "$resolved.sha256" -Raw) -split '\s+')[0]
if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash -ne $expected) { throw 'Archive checksum mismatch.' }
$fileName = [IO.Path]::GetFileName($resolved)
if ($fileName -notmatch '^pi-player-[A-Za-z0-9.-]+-linux-arm64\.tar\.gz$') { throw 'Unexpected archive filename.' }
$remote = "$SshUser@$PiHost"
$sshOptions = @('-p', "$Port", '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4')
$scpOptions = @('-P', "$Port", '-o', 'ConnectTimeout=15')
if ($IdentityFile) {
  $key = (Resolve-Path -LiteralPath $IdentityFile).Path
  $sshOptions += @('-i', $key); $scpOptions += @('-i', $key)
}
$staging = '/tmp/pi-player-release-' + [Guid]::NewGuid().ToString('N')
ssh @sshOptions $remote "mkdir -m 700 '$staging'"
if ($LASTEXITCODE) { throw 'Cannot create SSH staging directory' }
# Upload this checkout's helper, also supporting existing release archives.
scp @scpOptions -- $resolved (Join-Path $PSScriptRoot 'update-systemd.sh') (Join-Path $PSScriptRoot 'restart-kiosk-browser.py') "${remote}:$staging/"
if ($LASTEXITCODE) { throw 'Upload failed; installed service was not changed.' }
$installArgs = ''
if ($Install) {
  $installArgs = " --install --lan-address '$LanAddress' --lan-cidr '$LanCidr'"
  if ($DataPath) { $installArgs += " --data-path '$DataPath'" }
  if ($ExpectedMount) { $installArgs += " --expected-mount '$ExpectedMount'" }
}
# A remote PTY allows sudo and the first-install password prompt. No passwords in argv.
ssh @sshOptions -t $remote "sudo bash '$staging/update-systemd.sh' --archive '$staging/$fileName' --sha256 '$expected'$installArgs"
if ($LASTEXITCODE) { throw 'Deployment failed. Read the remote rollback/readiness result above. Staging was preserved for diagnosis.' }
Write-Output "Deployment complete on $remote. pi-player.service is running and ready."
