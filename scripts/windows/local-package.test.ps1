$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-package.ps1')
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('seelen-package-test-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path (Join-Path $temporary 'static')

function Assert-Rejected {
    param([scriptblock]$Action, [string]$Reason)
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw "Expected rejection: $Reason" }
}

try {
    foreach ($name in $script:LocalPackageFiles) {
        [IO.File]::WriteAllText((Join-Path $temporary $name), "test $name")
    }
    $resource = Join-Path $temporary 'static\theme.css'
    [IO.File]::WriteAllText($resource, 'original')
    $manifest = [ordered]@{
        schemaVersion = 1
        version = '1.0.0'
        profile = 'dev'
        frontend = 'embedded'
        upstreamUpdates = $false
        files = @(Get-LocalPackageFiles -Directory $temporary)
    }
    $manifestPath = Join-Path $temporary 'fork-build.json'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    $null = Assert-LocalPackage -Directory $temporary -ManifestPath $manifestPath -RequireLocalBuild
    & (Join-Path $PSScriptRoot 'install-local.ps1') -BuildDirectory $temporary -ValidateOnly

    [IO.File]::WriteAllText($resource, 'tampered')
    Assert-Rejected { Assert-LocalPackage -Directory $temporary -ManifestPath $manifestPath } 'modified resource'
    Assert-Rejected {
        & (Join-Path $PSScriptRoot 'install-local.ps1') -BuildDirectory $temporary -ValidateOnly
    } 'installer preflight rejects a modified resource'
    [IO.File]::WriteAllText($resource, 'original')
    $extra = Join-Path $temporary 'static\extra.css'
    [IO.File]::WriteAllText($extra, 'unlisted')
    Assert-Rejected { Assert-LocalPackage -Directory $temporary -ManifestPath $manifestPath } 'unlisted resource'
    Remove-Item -LiteralPath $extra
    $hook = Join-Path $temporary 'sluhk.dll'
    Remove-Item -LiteralPath $hook
    Assert-Rejected { Assert-LocalPackage -Directory $temporary -ManifestPath $manifestPath } 'missing hook DLL'
    [IO.File]::WriteAllText($hook, 'test sluhk.dll')
    $manifest.files[0].path = 'static/../../outside'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Assert-Rejected { Assert-LocalPackage -Directory $temporary -ManifestPath $manifestPath } 'path traversal'
    $manifest.files = @(Get-LocalPackageFiles -Directory $temporary)
    $manifest.files += $manifest.files[0]
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Assert-Rejected { Assert-LocalPackage -Directory $temporary -ManifestPath $manifestPath } 'duplicate manifest entry'
    $manifest.files = @(Get-LocalPackageFiles -Directory $temporary)
    $manifest.upstreamUpdates = $true
    $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
    Assert-Rejected {
        Assert-LocalPackage -Directory $temporary -ManifestPath $manifestPath -RequireLocalBuild
    } 'unsupported update policy'

    $pe = Join-Path $temporary 'synthetic.exe'
    $bytes = [byte[]]::new(512)
    $bytes[0] = 0x4d; $bytes[1] = 0x5a; $bytes[0x3c] = 0x80
    $bytes[0x80] = 0x50; $bytes[0x81] = 0x45
    $bytes[0x98] = 0x0b; $bytes[0x99] = 0x02; $bytes[0xdc] = 3
    [IO.File]::WriteAllBytes($pe, $bytes)
    Set-LocalGuiSubsystem -Path $pe
    $patched = [IO.File]::ReadAllBytes($pe)
    if ($patched[0xdc] -ne 2) { throw 'GUI subsystem was not set.' }
    $bytes[0xdc] = 2
    if ([Convert]::ToBase64String($bytes) -ne [Convert]::ToBase64String($patched)) {
        throw 'PE patch changed bytes outside the subsystem field.'
    }
    Assert-Rejected { Set-LocalGuiSubsystem -Path $resource } 'invalid executable'
    Write-Output 'Package integrity, installer preflight, and PE-header checks passed.'
} finally {
    $resolved = (Resolve-Path -LiteralPath $temporary).Path
    if (
        (Split-Path -Parent $resolved).TrimEnd('\') -ne ([IO.Path]::GetTempPath()).TrimEnd('\') -or
        (Split-Path -Leaf $resolved) -notlike 'seelen-package-test-*'
    ) { throw 'Unsafe test cleanup path.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
