[CmdletBinding()]
param([switch]$RebuildLibrary)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-package.ps1')
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$previousPath = $env:PATH
$previousConfig = $env:TAURI_CONFIG
try {
    # Support the isolated tools from the first local installation and a normal
    # per-user Deno installation, without changing the machine's PATH.
    $toolPaths = @(
        (Join-Path $env:LOCALAPPDATA 'SeelenForkBuildTools\node_modules\.bin'),
        (Join-Path $env:USERPROFILE '.deno\bin')
    )
    $env:PATH = ($toolPaths -join ';') + ';' + $env:PATH
    foreach ($command in @('cargo', 'npm.cmd', 'deno', 'git')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Missing build prerequisite: $command. See documentation/fork-maintenance.md."
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repository 'node_modules\.bin\tsx.cmd'))) {
        throw 'Install dependencies with npm ci before building.'
    }
    Push-Location -LiteralPath $repository
    try {
        if ($RebuildLibrary) {
            # Run the binding tests explicitly: the upstream generator currently
            # does not propagate its cargo subprocess failure.
            & cargo test --locked -p seelen-core --features gen-binds
            if ($LASTEXITCODE -ne 0) { throw 'Core binding tests failed.' }
            & npm.cmd run build:lib
            if ($LASTEXITCODE -ne 0) { throw 'Core library build failed.' }
        }
        if (-not (Test-Path -LiteralPath 'libs\core\gen\types\SeelenEventPayload.ts')) {
            throw 'Core bindings are missing. Run this script with -RebuildLibrary.'
        }
        # With no custom-protocol feature and no devUrl, Tauri embeds the frontend
        # while retaining the existing unsigned-local-build and no-updater behavior.
        $env:TAURI_CONFIG = '{"build":{"devUrl":null}}'
        & npm.cmd run build:ui -- --production
        if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }
        & cargo build --locked --target-dir (Join-Path $repository 'target') -p seelen-ui -p sluhk
        if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
        $directory = Join-Path $repository 'target\debug'
        foreach ($name in @('seelen-ui.exe', 'slu-service.exe')) {
            Set-LocalGuiSubsystem -Path (Join-Path $directory $name)
        }
        $commit = (& git rev-parse HEAD | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the build commit.' }
        $dirty = -not [string]::IsNullOrWhiteSpace((& git status --porcelain | Out-String))
        $baseline = Get-Content -LiteralPath 'fork-upstream.json' -Raw | ConvertFrom-Json
        $version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
        $manifest = [ordered]@{
            schemaVersion = 1
            version = $version
            sourceCommit = $commit
            sourceDirty = $dirty
            upstreamCommit = $baseline.baselineCommit
            profile = 'dev'
            frontend = 'embedded'
            upstreamUpdates = $false
            builtAt = (Get-Date).ToUniversalTime().ToString('o')
            files = @(Get-LocalPackageFiles -Directory $directory)
        }
        $manifestPath = Join-Path $directory 'fork-build.json'
        $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
        $null = Assert-LocalPackage -Directory $directory -ManifestPath $manifestPath -RequireLocalBuild
        Write-Output "Verified local package: $directory"
        Write-Output "Source: $commit (uncommitted changes: $dirty)"
    } finally {
        Pop-Location
    }
} finally {
    $env:PATH = $previousPath
    $env:TAURI_CONFIG = $previousConfig
}
