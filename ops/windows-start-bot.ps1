# Start the DADA Ledger Bot on this Windows PC instead of the VPS.
#
# Use when WhatsApp allows this PC's normal web.whatsapp.com to link, but the
# VPS/headless browser cannot link. This keeps a separate local WhatsApp auth
# directory so it does not touch the VPS `.wwebjs_auth` state.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\ops\windows-start-bot.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

function Find-Chrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  foreach ($p in $candidates) {
    if ($p -and (Test-Path $p)) { return $p }
  }
  return $null
}

$chrome = Find-Chrome
if (-not $chrome) {
  throw 'Chrome/Edge was not found. Install Google Chrome, or set CHROME_EXECUTABLE_PATH before running this script.'
}

# Shell env wins over .env because dotenv does not override existing variables.
$env:PUPPETEER_HEADLESS = 'false'
$env:CHROME_EXECUTABLE_PATH = $chrome
$env:WA_AUTH_DIR = '.wwebjs_auth_local'

# Local PC can scan the visible browser QR; disabling pairing-code avoids the
# flaky requestPairingCode path that often says "cannot link new devices".
$env:WA_PAIR_NUMBER = ''

Write-Host "Starting DADA bot locally with visible browser:" -ForegroundColor Cyan
Write-Host "  Chrome:      $chrome"
Write-Host "  WA_AUTH_DIR: $env:WA_AUTH_DIR"
Write-Host "  Group ID:    $env:WHATSAPP_GROUP_ID (empty here means .env value is used)"
Write-Host ''
Write-Host 'Keep this PowerShell window open. Stop with Ctrl+C.' -ForegroundColor Yellow
Write-Host 'If a QR appears in the browser window, scan it from the bot phone.' -ForegroundColor Yellow

npm.cmd run start
