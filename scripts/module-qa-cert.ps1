[CmdletBinding()]
param(
  [string]$Hostname = 'image.openopc.test',
  [string]$OutputDirectory = '.local/module-qa-certs',
  [switch]$UpdateHosts
)

$ErrorActionPreference = 'Stop'

if ($Hostname -notmatch '^[a-z0-9][a-z0-9-\.]*\.openopc\.test$' -or $Hostname.Contains(':')) {
  throw 'Hostname must be a named *.openopc.test host without a port.'
}

$mkcert = Get-Command mkcert -ErrorAction SilentlyContinue
if (-not $mkcert) {
  throw 'mkcert is required. Install it from https://github.com/FiloSottile/mkcert, then rerun this script.'
}

$resolvedOutput = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $OutputDirectory))
New-Item -ItemType Directory -Force -Path $resolvedOutput | Out-Null
$certPath = Join-Path $resolvedOutput "$Hostname.pem"
$keyPath = Join-Path $resolvedOutput "$Hostname-key.pem"

& $mkcert.Source -install
& $mkcert.Source -cert-file $certPath -key-file $keyPath $Hostname

if ($UpdateHosts) {
  $hostsPath = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  $entry = "127.0.0.1`t$Hostname"
  $existing = Get-Content -LiteralPath $hostsPath -ErrorAction Stop
  if (-not ($existing -contains $entry) -and -not ($existing -match "^\s*127\.0\.0\.1\s+$([regex]::Escape($Hostname))\s*$")) {
    Add-Content -LiteralPath $hostsPath -Value $entry
  }
}

Write-Output "Certificate: $certPath"
Write-Output "Private key: $keyPath"
Write-Output "Origin: https://$Hostname"
if (-not $UpdateHosts) {
  Write-Output 'Hosts file unchanged. Rerun with -UpdateHosts from an elevated PowerShell only when needed.'
}
