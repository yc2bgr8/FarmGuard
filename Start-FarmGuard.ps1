param([switch]$Rebuild, [switch]$NoDesktop, [int]$Port = 3111, [int]$DebugPort = 0)
$ErrorActionPreference = 'Stop'
$projectRoot = Join-Path $PSScriptRoot 'app'
$profileRoot = Join-Path $PSScriptRoot '.profile'
$logDir = Join-Path $PSScriptRoot 'logs'
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Path $profileRoot,$logDir -Force | Out-Null
$env:FARMGUARD_DATA_DIR = Join-Path $PSScriptRoot 'data'
$env:FARMGUARD_DESKTOP_PROFILE = Join-Path $profileRoot 'electron'
$env:WEB_HOST = '127.0.0.1'
$env:WEB_PORT = [string]$Port
$env:FARMGUARD_SERVER_URL = 'http://127.0.0.1:' + $Port
$env:FARMGUARD_RENDERER_URL = $env:FARMGUARD_SERVER_URL + '/farmguard'
$env:MINICLAW_ASSISTANT_NAME = 'FarmGuard'
$env:TZ = 'Asia/Shanghai'
Remove-Item -LiteralPath Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'))) {
    & npm ci
    if ($LASTEXITCODE -ne 0) { throw 'FarmGuard dependency installation failed.' }
}
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'web\node_modules\react'))) {
    & npm --prefix web ci
    if ($LASTEXITCODE -ne 0) { throw 'FarmGuard web dependency installation failed.' }
}
if (!(Test-Path -LiteralPath (Join-Path $projectRoot 'container\agent-runner\node_modules'))) {
    & npm --prefix container/agent-runner ci
    if ($LASTEXITCODE -ne 0) { throw 'FarmGuard Agent runtime installation failed.' }
}
if ($Rebuild -or !(Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.js'))) {
    & npm run build:all
    if ($LASTEXITCODE -ne 0) { throw 'FarmGuard application build failed.' }
    & npm run desktop:build
    if ($LASTEXITCODE -ne 0) { throw 'FarmGuard desktop build failed.' }
}
try { $health = Invoke-RestMethod ($env:FARMGUARD_SERVER_URL + '/api/farmguard/health') -TimeoutSec 2 } catch { $health = $null }
if (!$health -or $health.service -ne 'FarmGuard') {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listener) { throw "Port $Port is already used by another service; choose -Port." }
    $nodePath = (Get-Command node).Source
    $backend = Start-Process -FilePath $nodePath -ArgumentList @('dist/index.js') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $logDir 'backend-stdout.log') -RedirectStandardError (Join-Path $logDir 'backend-stderr.log')
    $backend.Id | Set-Content -LiteralPath (Join-Path $profileRoot 'backend.pid') -Encoding ascii
    $ready = $false
    for ($attempt=0; $attempt -lt 40; $attempt++) {
        try { $health = Invoke-RestMethod ($env:FARMGUARD_SERVER_URL + '/api/farmguard/health') -TimeoutSec 1; if ($health.service -eq 'FarmGuard') { $ready=$true; break } } catch {}
        Start-Sleep -Milliseconds 500
    }
    if (!$ready) { throw 'FarmGuard backend did not start. See logs/backend-stderr.log.' }
}
if (!$NoDesktop) {
    $desktopArguments = @('electron')
    if ($DebugPort -gt 0) { $desktopArguments += '--remote-debugging-port=' + $DebugPort }
    Start-Process -FilePath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe') -ArgumentList $desktopArguments `
        -WorkingDirectory $projectRoot -WindowStyle Normal -RedirectStandardOutput (Join-Path $logDir 'desktop-stdout.log') `
        -RedirectStandardError (Join-Path $logDir 'desktop-stderr.log') | Out-Null
}
