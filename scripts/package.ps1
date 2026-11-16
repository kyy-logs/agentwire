param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Unsupported version format' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $sourceRoot 'dist' }
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$stage = Join-Path $outputRoot ('agentwire-' + $version + '-windows')
$archive = $stage + '.zip'
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $archive)) { throw 'Output already exists; choose a new output directory' }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($entry in @('src','assets','docs','package.json','install.ps1','README.md','LICENSE','CHANGELOG.md')) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $entry) -Destination $stage -Recurse
}
$manifest = @(Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{ path = $_.FullName.Substring($stage.Length + 1).Replace('\','/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
})
[IO.File]::WriteAllText((Join-Path $stage 'release-manifest.json'), (ConvertTo-Json -InputObject $manifest -Depth 4), [Text.UTF8Encoding]::new($false))
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive
$digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumFile = Join-Path $outputRoot 'SHA256SUMS.txt'
if (Test-Path -LiteralPath $checksumFile) { throw 'Checksum output already exists' }
[IO.File]::WriteAllText($checksumFile, ($digest + '  ' + [IO.Path]::GetFileName($archive) + "`n"), [Text.UTF8Encoding]::new($false))
Write-Output ('Archive: ' + $archive)
Write-Output ('SHA256: ' + $digest)
