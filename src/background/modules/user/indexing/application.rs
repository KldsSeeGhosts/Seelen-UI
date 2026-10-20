use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt,
    notify::{self, ReadDirectoryChangesWatcher, RecursiveMode},
};
use seelen_core::system_state::{FolderType, UserFolderSnapshot};
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Once},
    time::{Duration, SystemTime},
};
use tauri::Manager;

use crate::{
    app::get_app_handle,
    error::{Result, ResultLogExt},
    event_manager,
    utils::lock_free::TracedMutex,
};

/// Hard cap of walk entries visited per folder scan, huge trees are walked partially.
const MAX_SCAN_ENTRIES: usize = 20_000;
/// Hard cap of files kept (and sent to the webviews) per folder.
const MAX_FOLDER_ITEMS: usize = 300;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UserFoldersManagerEvent {
    FolderChanged(FolderType),
}

#[derive(Debug)]
pub struct UserFoldersManager {
    pub folders: HashMap<FolderType, FolderDetails>,
}

unsafe impl Send for UserFoldersManager {}
unsafe impl Send for UserFoldersManagerEvent {}

event_manager!(UserFoldersManager, UserFoldersManagerEvent);

impl UserFoldersManager {
    /// The manager is available immediately, building it only resolves the known folder
    /// paths. The scans and watchers are created later by [`Self::init_in_background`], so
    /// command handlers never wait for huge, slow or unavailable folders.
    pub fn instance() -> &'static TracedMutex<Self> {
        static USER_FOLDERS_MANAGER: LazyLock<TracedMutex<UserFoldersManager>> =
            LazyLock::new(|| TracedMutex::new(UserFoldersManager::new()));
        &USER_FOLDERS_MANAGER
    }

    /// Starts (once) the background worker that scans and watches the known user folders.
    /// Indexing them can take a long time on some systems (huge trees, slow or unavailable
    /// paths), so each folder publishes its result as soon as it is ready instead of
    /// withholding every folder until all of them were scanned.
    pub fn init_in_background() {
        static SPAWNED: Once = Once::new();
        SPAWNED.call_once(|| {
            for &folder_type in FolderType::values() {
                std::thread::Builder::new()
                    .name(format!("user-folder-{folder_type:?}"))
                    .spawn(move || {
                        Self::index_folder(folder_type);
                    })
                    .log_error();
            }
        });
    }

    /// Content and loading state of a folder, read together so a webview never receives
    /// the content of one scan combined with the loading state of another.
    pub fn snapshot(&self, folder_type: FolderType) -> UserFolderSnapshot {
        match self.folders.get(&folder_type) {
            Some(details) => UserFolderSnapshot {
                content: details.content.clone(),
                is_loading: details.is_loading,
            },
            // the folder could not be resolved, so there is nothing loading for it
            None => UserFolderSnapshot {
                content: Vec::new(),
                is_loading: false,
            },
        }
    }

    fn index_folder(folder_type: FolderType) {
        // never scan while holding the manager lock, on huge trees the scan takes seconds
        // and every reader of the folders would wait for it (and trip the lock watchdog).
        let path = {
            let manager = Self::instance().lock();
            match manager.folders.get(&folder_type) {
                Some(details) => details.path.clone(),
                None => return,
            }
        };

        if !path.is_dir() {
            log::warn!("Skipping user folder {folder_type:?}, missing directory: {path:?}");
            // still publish it, webviews need the event to leave their loading state
            Self::publish_initial_content(folder_type, Vec::new(), None);
            return;
        }

        // Watch before scanning so changes during the scan can request a fresh snapshot.
        let watcher = match Self::create_folder_watcher(&path, folder_type) {
            Ok(watcher) => Some(watcher),
            Err(err) => {
                log::error!("Failed to watch user folder {folder_type:?} ({path:?}): {err:?}");
                None
            }
        };

        // a failed scan is published as empty, otherwise the folder would stay loading forever
        let content = match Self::get_folder_content(path.clone(), folder_type) {
            Ok(content) => content,
            Err(err) => {
                log::error!("Failed to scan user folder {folder_type:?} ({path:?}): {err:?}");
                Vec::new()
            }
        };

        Self::publish_initial_content(folder_type, content, watcher);
    }

    /// Publishes the first scan of a folder, even when it is empty or missing, because
    /// that event is what tells the webviews the folder is no longer loading.
    fn publish_initial_content(
        folder_type: FolderType,
        content: Vec<PathBuf>,
        watcher: Option<Debouncer<ReadDirectoryChangesWatcher, NoCache>>,
    ) {
        let refresh = {
            let mut manager = Self::instance().lock();
            match manager.folders.get_mut(&folder_type) {
                Some(details) => {
                    details.content = content;
                    details.is_loading = false;
                    details._watcher = watcher;
                    Some(std::mem::take(&mut details.pending_reload))
                }
                None => None,
            }
        };
        if let Some(refresh) = refresh {
            Self::send(UserFoldersManagerEvent::FolderChanged(folder_type));
            if refresh {
                Self::reload_folder_content(folder_type).log_error();
            }
        }
    }

    fn get_path_from_folder(folder_type: &FolderType) -> Option<PathBuf> {
        let resolver = get_app_handle().path();
        match folder_type {
            FolderType::Recent => {
                Some(resolver.data_dir().ok()?.join("Microsoft\\Windows\\Recent"))
            }
            FolderType::Desktop => resolver.desktop_dir().ok(),
            FolderType::Downloads => resolver.download_dir().ok(),
            FolderType::Documents => resolver.document_dir().ok(),
            FolderType::Pictures => resolver.picture_dir().ok(),
            FolderType::Videos => resolver.video_dir().ok(),
            FolderType::Music => resolver.audio_dir().ok(),
        }
    }

    fn get_folder_content(base_path: PathBuf, folder_type: FolderType) -> Result<Vec<PathBuf>> {
        let max_depth = listing_depth(folder_type);

        // (last modified time, path), files with unreadable metadata sort last
        let mut list: Vec<(Option<SystemTime>, PathBuf)> = Vec::new();

        for (index, entry) in walkdir::WalkDir::new(&base_path)
            .follow_links(false)
            .max_depth(max_depth)
            .into_iter()
            .filter_entry(|e| !is_ignored_entry(e.path()))
            .enumerate()
        {
            if index >= MAX_SCAN_ENTRIES {
                break;
            }

            let Ok(entry) = entry else {
                continue;
            };

            let path = entry.path();
            // links aren't followed while walking, but a link to a file is still listed
            let is_file =
                entry.file_type().is_file() || (entry.path_is_symlink() && path.is_file());
            if !is_file || is_ignored_file(path) {
                continue;
            }

            let modified = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok());
            list.push((modified, path.to_path_buf()));
        }

        list.sort_by_key(|item| Reverse(item.0)); // newest first
        list.truncate(MAX_FOLDER_ITEMS);

        Ok(list.into_iter().map(|(_, path)| path).collect())
    }

    fn create_folder_watcher(
        path: &PathBuf,
        folder_type: FolderType,
    ) -> Result<Debouncer<ReadDirectoryChangesWatcher, NoCache>> {
        // NoCache on purpose: the default file id cache indexes every file of the watched
        // tree, which never ends on folders like Documents with millions of files.
        let root = path.clone();
        let mut debouncer: Debouncer<ReadDirectoryChangesWatcher, NoCache> = new_debouncer_opt(
            Duration::from_millis(1000),
            None,
            move |result: DebounceEventResult| match result {
                Ok(events) => {
                    if changes_cannot_affect_listing(&root, folder_type, &events) {
                        return;
                    }
                    Self::reload_folder_content(folder_type).log_error();
                }
                Err(errors) => {
                    log::error!("Folder Watcher Error for {:?}: {errors:?}", folder_type);
                }
            },
            NoCache::new(),
            notify::Config::default(),
        )?;
        debouncer.watch(path, RecursiveMode::Recursive)?;
        Ok(debouncer)
    }

    fn reload_folder_content(folder_type: FolderType) -> Result<()> {
        // never scan while holding the manager lock, on huge trees the scan takes seconds
        // and every reader of the folders would wait for it (and trip the lock watchdog).
        let path = {
            let mut manager = Self::instance().lock();
            match manager.folders.get_mut(&folder_type) {
                Some(details) if details.is_loading => {
                    details.pending_reload = true;
                    return Ok(());
                }
                Some(folder_details) => folder_details.path.clone(),
                None => return Ok(()),
            }
        };

        let content = Self::get_folder_content(path, folder_type)?;

        let changed = {
            let mut manager = Self::instance().lock();
            match manager.folders.get_mut(&folder_type) {
                Some(folder_details) => {
                    // the listing is bounded and sorted, so a reload that produced the
                    // same list (a change outside of the listed files) has nothing new
                    // for the webviews
                    if folder_details.content == content {
                        false
                    } else {
                        folder_details.content = content;
                        true
                    }
                }
                None => false,
            }
        };

        if changed {
            Self::send(UserFoldersManagerEvent::FolderChanged(folder_type));
        }
        Ok(())
    }

    /// Building the manager never blocks: folders are registered as loading and the
    /// background worker fills them in later.
    pub fn new() -> Self {
        let mut folders = HashMap::new();

        for &folder_type in FolderType::values() {
            let Some(path) = Self::get_path_from_folder(&folder_type) else {
                continue;
            };
            folders.insert(
                folder_type,
                FolderDetails {
                    path,
                    content: Vec::new(),
                    is_loading: true,
                    pending_reload: false,
                    _watcher: None,
                },
            );
        }

        Self { folders }
    }
}

#[derive(Debug)]
pub struct FolderDetails {
    pub path: PathBuf,
    pub content: Vec<PathBuf>,
    /// `true` until the background worker published the first scan of this folder.
    pub is_loading: bool,
    /// A watcher saw a change during the initial scan.
    pending_reload: bool,
    /// `None` when the folder could not be watched (missing path, denied access, etc).
    /// The already scanned content is still served in that case.
    _watcher: Option<Debouncer<ReadDirectoryChangesWatcher, NoCache>>,
}

/// Maximum depth, relative to the folder root, of the entries returned by a scan.
fn listing_depth(folder_type: FolderType) -> usize {
    // Recent is a flat folder of .lnk shortcuts; others are scanned up to 3 levels deep
    // to avoid exploding on large/deep folder trees.
    match folder_type {
        FolderType::Recent => 1,
        _ => 3,
    }
}

/// Returns true when no path of the batch can change the bounded listing of `root`, so a
/// reload would produce the same result.
fn changes_cannot_affect_listing(
    root: &Path,
    folder_type: FolderType,
    events: &[DebouncedEvent],
) -> bool {
    only_ignored_paths(root, events) || only_below_listing_depth(root, folder_type, events)
}

/// Returns true when every path of the batch is inside an ignored directory of the watched
/// `root`, in which case the change can't affect the listed files and the reload is pointless.
/// Only components below `root` count, so a root that itself lives under e.g. `build` still
/// reloads. An empty or mixed batch returns false, so it still triggers a reload.
fn only_ignored_paths(root: &Path, events: &[DebouncedEvent]) -> bool {
    let mut seen_any = false;
    for path in events.iter().flat_map(|event| &event.paths) {
        seen_any = true;
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        if !relative.ancestors().any(is_ignored_entry) {
            return false;
        }
    }
    seen_any
}

/// Returns true when every path of the batch is deeper than the listing depth of the
/// folder, so none of them can be listed (the walk never descends past that depth).
/// Every path of a batch is checked, so a rename that moves an entry into the listed depth
/// still reloads. An empty or mixed batch returns false.
fn only_below_listing_depth(
    root: &Path,
    folder_type: FolderType,
    events: &[DebouncedEvent],
) -> bool {
    let max_depth = listing_depth(folder_type);
    let mut seen_any = false;
    for path in events.iter().flat_map(|event| &event.paths) {
        seen_any = true;
        match path.strip_prefix(root) {
            Ok(relative) if relative.components().count() > max_depth => {}
            _ => return false,
        }
    }
    seen_any
}

/// Returns true if the entry should be excluded from the file list.
/// When applied via `filter_entry`, returning true for a directory prunes its entire subtree.
fn is_ignored_entry(path: &Path) -> bool {
    static IGNORED: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
        HashSet::from([
            // Dev artifact directories
            "node_modules",
            "target",
            "dist",
            "build",
            "out",
            "__pycache__",
            "venv",
            ".venv",
            "env",
            "vendor",
            // VCS
            ".git",
            ".svn",
            ".hg",
            // IDE/editor
            ".idea",
            ".vscode",
            ".next",
            // Cache
            ".cache",
            "cache",
            "Cache",
            // Windows system
            "$RECYCLE.BIN",
            "System Volume Information",
            "WindowsApps",
            "MicrosoftEdgeBackups",
        ])
    });

    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| IGNORED.contains(name))
}

fn is_ignored_file(path: &Path) -> bool {
    static IGNORED: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
        HashSet::from([
            // Temp / backup
            "ini",
            "dat",
            "bak",
            "tmp",
            "temp",
            "old",
            "swp",
            "save",
            // Crash / memory dumps
            "dmp",
            "blk",
            // In-progress downloads
            "download",
            "crdownload",
            "part",
            // Lock / pid files
            "lock",
            "pid",
            // Log files
            "log",
            // Database / cache files
            "db",
            "sqlite",
            "sqlite3",
            "ldb",
            // Build artifacts
            "obj",
            "pdb",
            "ilk",
            "exp",
            "iobj",
            "ipdb",
            // Windows shortcut noise (internet shortcuts, not file shortcuts)
            "url",
            // System / driver files
            "dll",
            "sys",
            "lib",
            "cat",
            "inf",
            "winmd",
            // Certificates & keys
            "pfx",
            "pem",
            "crl",
            "p7b",
            // Checksums
            "sha512",
            "sha256",
            "sha1",
            "md5",
            // Game / engine packages
            "pak",
            "pck",
            "vdf",
            // iTunes library metadata
            "itdb",
            "itl",
            // Compiled shader cache
            "fxo",
            // Numbered / no-semantic extension (autotools, Python dist)
            "0",
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
            "7",
            "8",
            "9",
            // Obscure image formats (raw scientific / legacy)
            "pbm",
            "pgm",
            "ppm",
            "ras",
            "sgi",
            "xbm",
            "xpm",
            // Obscure / legacy audio formats
            "8svx",
            "hcom",
            "sndt",
            "voc",
            "spx",
            "aifc",
        ])
    });

    let Some(extension) = path.extension() else {
        return true; // filter files without extension
    };

    let ext = extension.to_string_lossy().to_lowercase();

    // Backup files can have numbers in their name (e.g. 1, 2, 3, etc.)
    if ext.starts_with("bak") || ext.starts_with("backup") {
        return true;
    }

    IGNORED.contains(ext.as_str())
}
