param([switch]$Apply)
$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Node.js >=24 is required; install it before continuing.' }
$entry = Join-Path $PSScriptRoot 'src\labus.ts'
$previewText = & $nodeCommand.Source '--experimental-strip-types' $entry 'setup'
if ($LASTEXITCODE -ne 0) { Write-Output $previewText; exit $LASTEXITCODE }
$preview = $previewText | ConvertFrom-Json
Write-Host 'AgentWire installation preview (compatible labus runtime):'
@($preview.data.runtime.changes) + @($preview.data.configuration.changes) | ForEach-Object { Write-Host ('  ' + $_.kind + ': ' + $_.target) }
if (-not $Apply) {
  $answer = Read-Host 'Apply these changes? Type yes to continue (default: no)'
  if ($answer -ne 'yes') { Write-Host 'No changes applied. Preview saved.'; exit 0 }
}
& $nodeCommand.Source '--experimental-strip-types' $entry 'setup' '--apply' '--operation' $preview.data.runtime.operationId '--configuration-operation' $preview.data.configuration.operationId
$resultCode = $LASTEXITCODE
if ($resultCode -eq 0) { Write-Host 'Review the native Hooks in both apps, then return to chat and ask to connect the other Agent. Existing windows may need native skill reload.' }
exit $resultCode
