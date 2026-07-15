# Reset only the Windows-local WhatsApp auth profile used by windows-start-bot.ps1.
# This does NOT touch the VPS `.wwebjs_auth` profile.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\ops\windows-reset-local-wa-auth.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

$auth = Join-Path $root '.wwebjs_auth_local'
$cache = Join-Path $root '.wwebjs_cache'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (Test-Path $auth) {
  $backup = Join-Path $root ".wwebjs_auth_local.old.$stamp"
  Move-Item -Path $auth -Destination $backup
  Write-Host "Moved local auth to $backup" -ForegroundColor Yellow
} else {
  Write-Host 'No .wwebjs_auth_local directory found.' -ForegroundColor DarkGray
}

if (Test-Path $cache) {
  Remove-Item -Path $cache -Recurse -Force
  Write-Host 'Removed .wwebjs_cache' -ForegroundColor Yellow
}

Write-Host 'Done. Next local start will require linking again.' -ForegroundColor Green
