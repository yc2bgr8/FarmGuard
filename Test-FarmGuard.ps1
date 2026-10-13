$ErrorActionPreference = 'Stop'
$farmguardReplayDirectory = Join-Path -Path $PSScriptRoot -ChildPath 'verification\core-replay'
Set-Location -LiteralPath (Join-Path $PSScriptRoot 'app')
& npm.cmd run farmguard:test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& npm.cmd run farmguard:replay -- --data-dir $farmguardReplayDirectory
exit $LASTEXITCODE
