$script:LocalPackageFiles = @(
    'seelen-ui.exe', 'slu-service.exe', 'slu.exe', 'sluhk.dll', 'SHA256SUMS', 'SHA256SUMS.sig'
)

function Get-LocalPackageFiles {
    param([Parameter(Mandatory)][string]$Directory)

    $root = (Resolve-Path -LiteralPath $Directory -ErrorAction Stop).Path
    $items = foreach ($name in $script:LocalPackageFiles) {
        Get-Item -LiteralPath (Join-Path $root $name) -ErrorAction Stop
    }
    $static = Get-Item -LiteralPath (Join-Path $root 'static') -ErrorAction Stop
    if (-not $static.PSIsContainer -or $static.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'The static resource directory must be a regular directory.'
    }
    $resources = @(Get-ChildItem -LiteralPath $static.FullName -Recurse -Force -ErrorAction Stop)
    if (@($resources | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) {
        throw 'Package resources cannot contain links or junctions.'
    }
    $items = @($items) + @($resources | Where-Object { -not $_.PSIsContainer })
    if (@($items).Count -eq $script:LocalPackageFiles.Count) {
        throw 'The package has no static resources.'
    }
    foreach ($item in ($items | Sort-Object FullName)) {
        if ($item.PSIsContainer -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Package files must be regular files: $($item.FullName)"
        }
        [pscustomobject]@{
            path = $item.FullName.Substring($root.TrimEnd('\').Length + 1).Replace('\', '/')
            sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash
        }
    }
}

function Assert-LocalPackage {
    param(
        [Parameter(Mandatory)][string]$Directory,
        [Parameter(Mandatory)][string]$ManifestPath,
        [switch]$RequireLocalBuild
    )

    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or -not $manifest.version -or -not $manifest.files) {
        throw 'Unsupported or incomplete package manifest.'
    }
    if ($RequireLocalBuild -and (
        $manifest.profile -ne 'dev' -or $manifest.frontend -ne 'embedded' -or
        $manifest.upstreamUpdates -ne $false
    )) {
        throw 'Only standalone local development builds are supported by this installer.'
    }
    $expected = @{}
    foreach ($entry in $manifest.files) {
        $path = [string]$entry.path
        if (
            [IO.Path]::IsPathRooted($path) -or $path -match '\\|:|(^|/)\.\.?(/|$)' -or
            ($path -notin $script:LocalPackageFiles -and $path -notmatch '^static/[^/].*') -or
            $entry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $expected.ContainsKey($path)
        ) {
            throw "Invalid or duplicate package entry: $path"
        }
        $expected[$path] = $entry.sha256
    }
    $actual = @(Get-LocalPackageFiles -Directory $Directory)
    if ($actual.Count -ne $expected.Count) {
        throw 'The manifest does not match the complete package file list.'
    }
    foreach ($entry in $actual) {
        if (-not $expected.ContainsKey($entry.path) -or $expected[$entry.path] -ne $entry.sha256) {
            throw "Package checksum mismatch: $($entry.path)"
        }
    }
    return $manifest
}

function Set-LocalGuiSubsystem {
    param([Parameter(Mandatory)][string]$Path)

    # Upstream debug binaries use a console subsystem. Change only the PE header
    # so a standalone desktop build does not open terminal windows at login.
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite)
    $reader = [IO.BinaryReader]::new($stream)
    $writer = [IO.BinaryWriter]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5a4d) { throw 'Missing executable DOS header.' }
        $stream.Position = 0x3c
        $offset = $reader.ReadInt32()
        if ($offset -lt 0x40 -or $offset + 0x5e -gt $stream.Length) { throw 'Invalid PE header offset.' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550) { throw 'Missing executable PE header.' }
        $stream.Position = $offset + 0x18
        if ($reader.ReadUInt16() -notin @(0x10b, 0x20b)) { throw 'Unsupported PE optional header.' }
        $stream.Position = $offset + 0x5c
        $writer.Write([uint16]2)
        $writer.Flush()
    } finally {
        $writer.Dispose()
        $reader.Dispose()
        $stream.Dispose()
    }
}
