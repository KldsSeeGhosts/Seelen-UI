# Personal Seelen UI fork

The fork is [KldsSeeGhosts/Seelen-UI](https://github.com/KldsSeeGhosts/Seelen-UI). `origin` points there; the `upstream`
remote points to `eythaann/Seelen-UI`.

The `upstream` branch contains the unmodified upstream baseline. `ksg/passthrough` adds local build and distribution
tooling; `ksg/dev` is the default branch for personal customizations. Use short-lived `ksg/<topic>` branches and
dedicated worktrees for individual changes, then merge into the appropriate layer.

The first installed build is tagged `ksg/installed-20261019-3fe78b7b` at `3fe78b7b40032c9df0ed3c97b36a6212c458ac76`. It
is an upstream development snapshot reporting version 2.8.10, not a published upstream release. `fork-upstream.json`
records this initial exception and the baseline for future builds.

## Local build

Use native Windows PowerShell 5.1 or newer, Node.js 24+, Deno 2+, Git, Rustup, and the Visual Studio C++ build tools
with a Windows SDK. Rustup selects the toolchain pinned in `rust-toolchain.toml`.

Install dependencies with `npm ci` with Deno on `PATH`. On the original workstation, the isolated Deno installation can
be exposed for this shell:

```powershell
$env:PATH = "$env:LOCALAPPDATA\SeelenForkBuildTools\node_modules\.bin;$env:PATH"
npm ci
```

From the repository root:

```powershell
.\scripts\windows\build-local.ps1
.\scripts\windows\install-local.ps1 -ValidateOnly
```

Use `build-local.ps1 -RebuildLibrary` after changing Rust declarations exposed to TypeScript. It first checks the
binding tests because the upstream generator does not propagate its Cargo subprocess failures.

The builder embeds the production frontend in a debug executable, builds the service, CLI, and hook DLL, and sets the
two desktop executables' PE subsystem to Windows so login does not open consoles. It uses Tauri's existing local
development behavior: static checksums remain validated, a maintainer signing key is unnecessary, and upstream in-app
updates are disabled. No frontend development server is needed. This is a development build, with debug performance
characteristics.

`target/debug/fork-build.json` records the source commit, dirty-tree state, upstream baseline, and SHA-256 hashes of
every executable and static resource. Builds do not install, publish, or restart the desktop.

## Install and rollback

Review the package first. `-ValidateOnly` checks the manifest and all package files without changing the installation or
requiring elevation. `-WhatIf` also checks the target installation and reports the proposed replacement.

To install, open an administrator PowerShell window in the checkout and run:

```powershell
.\scripts\windows\install-local.ps1
```

This upgrades an existing native Seelen installation under Program Files. `-InstallDirectory` selects another registered
native installation. `-BackupParent` selects a backup folder on the same volume as the installation. UAC and execution
policy do not need to be changed.

Before replacement, the script backs up the installed application, its registry display version, startup-task XML,
roaming settings and extensions, and local state files under `~/Seelen-Backups/before-local-*`. It preserves the app ID,
uninstaller, startup task, user settings, and extensions. A failed copy or startup check restores the previous app files
automatically.

To restore an application backup created by this script, use its exact path:

```powershell
.\scripts\windows\install-local.ps1 -RestoreFrom "$HOME\Seelen-Backups\before-local-<timestamp>" -ValidateOnly
.\scripts\windows\install-local.ps1 -RestoreFrom "$HOME\Seelen-Backups\before-local-<timestamp>"
```

Rollback restores app files while preserving current user data. The separately saved `Roaming` directory is available if
a settings migration also needs to be reverted. The first installation's older backup and one-off restore helper remain
outside this repository; they use the original backup format.

Run the focused packaging checks with:

```powershell
.\scripts\windows\local-package.test.ps1
```

## Upstream updates and releases

Review published upstream releases when they contain relevant improvements. Do not automatically install upstream branch
HEAD or a floating nightly tag. Fetching, reviewing, merging, pushing source, publishing, and installing are separate
steps.

Fetch published tags into a separate namespace:

```powershell
git fetch upstream --no-tags 'refs/tags/*:refs/tags/upstream/*'
```

Choose and verify a release tag and its commit. With clean branches, merge the chosen commit into `upstream`, then merge
`upstream` into `ksg/passthrough`, then merge `ksg/passthrough` into `ksg/dev`. Run each merge in that branch's existing
worktree if one exists. Update `fork-upstream.json` in the distribution layer to record the selected commit and
published release. Preserve the fork changes when resolving conflicts, and run checks appropriate to those changes.

Build and validate locally, test the toolbar and dock on both monitors and the installed Orbit themes/widgets, and
install only when requested. Tag the exact tested source commit with a unique `ksg/installed-*` tag when installing.
Push explicit branch/tag names; avoid `--all`, `--tags`, and force-pushes.

Inherited GitHub Actions are disabled on the fork because they publish upstream nightlies, libraries, store packages,
and announcements. Source pushes do not publish releases or update this PC. Keep releases manual until fork-specific
packaging, versioning, signing keys, and update feeds are deliberately set up. Do not reuse upstream publication
credentials or turn its release workflows on.
