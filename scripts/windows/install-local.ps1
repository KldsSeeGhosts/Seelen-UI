[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$BuildDirectory = (Join-Path $PSScriptRoot '..\..\target\debug'),
    [string]$InstallDirectory = (Join-Path $env:ProgramFiles 'Seelen\Seelen UI'),
    [string]$BackupParent = (Join-Path $env:USERPROFILE 'Seelen-Backups'),
    [string]$RestoreFrom,
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'local-package.ps1')
if ($RestoreFrom) {
    $restoreRoot = (Resolve-Path -LiteralPath $RestoreFrom).Path
    $source = Join-Path $restoreRoot 'app'
    $manifestPath = Join-Path $restoreRoot 'app-manifest.json'
    $manifest = Assert-LocalPackage -Directory $source -ManifestPath $manifestPath
} else {
    $source = (Resolve-Path -LiteralPath $BuildDirectory).Path
    $manifestPath = Join-Path $source 'fork-build.json'
    $manifest = Assert-LocalPackage -Directory $source -ManifestPath $manifestPath -RequireLocalBuild
}
if ($ValidateOnly) {
    Write-Output "Verified $($manifest.files.Count) package files for Seelen UI $($manifest.version)."
    return
}
$installRoot = (Resolve-Path -LiteralPath $InstallDirectory).Path.TrimEnd('\')
$source = (Resolve-Path -LiteralPath $source).Path.TrimEnd('\')
$backupParentPath = [IO.Path]::GetFullPath($BackupParent).TrimEnd('\')
foreach ($other in @($source, $backupParentPath)) {
    if (
        $other -eq $installRoot -or $other.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $installRoot.StartsWith($other + '\', [StringComparison]::OrdinalIgnoreCase)
    ) { throw 'The installation, package, and backup directories must be separate.' }
}
if (
    $installRoot -eq [IO.Path]::GetPathRoot($installRoot).TrimEnd('\') -or
    [IO.Path]::GetPathRoot($backupParentPath) -ne [IO.Path]::GetPathRoot($installRoot)
) { throw 'Use a non-root installation directory and backups on the same volume for file rollback.' }
foreach ($name in $script:LocalPackageFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $installRoot $name) -PathType Leaf)) {
        throw "This script upgrades an existing native installation. Missing: $name"
    }
}
$registryPath = $null
foreach ($candidate in @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Seelen UI',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Seelen UI'
)) {
    $entry = Get-ItemProperty -LiteralPath $candidate -ErrorAction SilentlyContinue
    if ($entry -and ([string]$entry.InstallLocation).Trim('"').TrimEnd('\') -eq $installRoot) {
        $registryPath = $candidate
        break
    }
}
if (-not $registryPath) { throw 'No matching Seelen UI uninstall registration was found.' }
$oldVersion = (Get-ItemProperty -LiteralPath $registryPath).DisplayVersion
$task = Get-ScheduledTask -TaskPath '\Seelen\' -TaskName 'Seelen UI Service'
if (@($task.Actions).Count -ne 1 -or $task.Actions.Execute -ne (Join-Path $installRoot 'slu-service.exe')) {
    throw 'The startup task points to another installation.'
}
if (-not $PSCmdlet.ShouldProcess($installRoot, "Back up and install Seelen UI $($manifest.version)")) { return }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) { throw 'Run this script in an administrator PowerShell window. UAC and execution policy need no changes.' }

$backup = Join-Path $backupParentPath ('before-local-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$null = New-Item -ItemType Directory -Path $backup
$snapshot = [ordered]@{
    schemaVersion = 1
    version = (Get-Item -LiteralPath (Join-Path $installRoot 'seelen-ui.exe')).VersionInfo.FileVersion
    profile = 'installed'
    files = @(Get-LocalPackageFiles -Directory $installRoot)
}
$snapshot | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backup 'app-manifest.json') -Encoding UTF8
Copy-Item -LiteralPath $installRoot -Destination (Join-Path $backup 'app') -Recurse
$null = Assert-LocalPackage -Directory (Join-Path $backup 'app') -ManifestPath (Join-Path $backup 'app-manifest.json')
Export-ScheduledTask -TaskPath $task.TaskPath -TaskName $task.TaskName |
    Set-Content -LiteralPath (Join-Path $backup 'startup-task.xml') -Encoding UTF8
@{ displayVersion = $oldVersion } | ConvertTo-Json |
    Set-Content -LiteralPath (Join-Path $backup 'installation.json') -Encoding UTF8

$sessionId = (Get-Process -Id $PID).SessionId
function Stop-InstalledSeelen {
    $service = @(Get-Process -Name slu-service -ErrorAction SilentlyContinue | Where-Object {
        $_.SessionId -eq $sessionId -and $_.Path -eq (Join-Path $installRoot 'slu-service.exe')
    })
    if ($service.Count) {
        $stopper = Start-Process -FilePath (Join-Path $installRoot 'slu-service.exe') -ArgumentList stop `
            -WindowStyle Hidden -PassThru
        if (-not $stopper.WaitForExit(10000)) {
            Stop-Process -Id $stopper.Id -Force
        }
        foreach ($process in $service) { $null = $process.WaitForExit(8000) }
    }
    Get-Process -Name seelen-ui, slu-service -ErrorAction SilentlyContinue | Where-Object {
        $_.SessionId -eq $sessionId -and $_.Path -in @(
            (Join-Path $installRoot 'seelen-ui.exe'), (Join-Path $installRoot 'slu-service.exe')
        )
    } | Stop-Process -Force
}

$rollback = Join-Path $backup 'rollback'
$null = New-Item -ItemType Directory -Path $rollback
$touched = [Collections.Generic.List[string]]::new()
try {
    Stop-InstalledSeelen
    $roaming = Join-Path $env:APPDATA 'com.seelen.seelen-ui'
    if (Test-Path -LiteralPath $roaming) {
        Copy-Item -LiteralPath $roaming -Destination (Join-Path $backup 'Roaming') -Recurse
    }
    $local = Join-Path $env:LOCALAPPDATA 'com.seelen.seelen-ui'
    if (Test-Path -LiteralPath $local) {
        $localBackup = New-Item -ItemType Directory -Path (Join-Path $backup 'Local')
        Get-ChildItem -LiteralPath $local -File | Copy-Item -Destination $localBackup.FullName
    }
    # Only these fixed children of the resolved installation directory are moved.
    foreach ($name in $script:LocalPackageFiles + @('static', 'fork-build.json')) {
        $target = Join-Path $installRoot $name
        $touched.Add($name)
        if (Test-Path -LiteralPath $target) {
            Move-Item -LiteralPath $target -Destination (Join-Path $rollback $name)
        }
        $replacement = Join-Path $source $name
        if (Test-Path -LiteralPath $replacement) {
            Copy-Item -LiteralPath $replacement -Destination $target -Recurse
        }
    }
    $null = Assert-LocalPackage -Directory $installRoot -ManifestPath $manifestPath
    $displayVersion = "$($manifest.version) (local fork)"
    if ($RestoreFrom) {
        $displayVersion = (Get-Content -LiteralPath (Join-Path $restoreRoot 'installation.json') -Raw |
            ConvertFrom-Json).displayVersion
    }
    Set-ItemProperty -LiteralPath $registryPath -Name DisplayVersion -Value $displayVersion
    Start-ScheduledTask -TaskPath $task.TaskPath -TaskName $task.TaskName
    $deadline = (Get-Date).AddSeconds(30)
    $healthy = $false
    do {
        try {
            $ping = Invoke-RestMethod -Uri 'http://127.0.0.1:37074/ping' -TimeoutSec 2
            $app = @(Get-Process -Name seelen-ui -ErrorAction SilentlyContinue | Where-Object {
                $_.SessionId -eq $sessionId -and $_.Path -eq (Join-Path $installRoot 'seelen-ui.exe')
            })
            $service = @(Get-Process -Name slu-service -ErrorAction SilentlyContinue | Where-Object {
                $_.SessionId -eq $sessionId -and $_.Path -eq (Join-Path $installRoot 'slu-service.exe')
            })
            if ($ping.version -eq $manifest.version -and $app.Count -and $service.Count) {
                $healthy = $true
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    if (-not $healthy) { throw 'The installed app did not become healthy within 30 seconds.' }
    Write-Output "Installed Seelen UI $($manifest.version). Backup: $backup"
} catch {
    $failure = $_
    try {
        Stop-InstalledSeelen
        foreach ($name in $touched) {
            $target = Join-Path $installRoot $name
            if ([IO.Path]::GetFullPath((Split-Path -Parent $target)) -ne $installRoot) {
                throw 'Unsafe rollback path.'
            }
            $saved = Join-Path $rollback $name
            if (Test-Path -LiteralPath $saved) {
                if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
                Move-Item -LiteralPath $saved -Destination $target
            } elseif (-not (Test-Path -LiteralPath (Join-Path $backup "app\$name"))) {
                if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
            }
        }
        Set-ItemProperty -LiteralPath $registryPath -Name DisplayVersion -Value $oldVersion
        Start-ScheduledTask -TaskPath $task.TaskPath -TaskName $task.TaskName
    } catch {
        throw "Installation failed: $failure. Automatic rollback also failed: $_. Backup: $backup"
    }
    throw "Installation failed and the previous app was restored: $failure. Backup: $backup"
}
