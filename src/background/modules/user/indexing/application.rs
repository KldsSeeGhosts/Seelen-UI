use notify_debouncer_full::{
    DebounceEventResult, DebouncedEvent, Debouncer, NoCache, new_debouncer_opt,
    notify::{self, ReadDirectoryChangesWatcher, RecursiveMode},
};
use seelen_core::system_state::FolderType;
use std::{
    cmp::Reverse,
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        LazyLock, Once,
        atomic::{AtomicBool, Ordering},
    },
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

/// Set once the first (potentially slow, huge/deep trees or slow/unavailable paths)
/// indexing of the known user folders has finished.
static INITIALIZED: AtomicBool = AtomicBool::new(false);

#[derive(Debug)]
pub struct FolderDetails {
    pub path: PathBuf,
    pub content: Vec<PathBuf>,
    /// `None` when the folder could not be watched (missing path, denied access, etc).
    /// The already scanned content is still served in that case.
    _watcher: Option<Debouncer<ReadDirectoryChangesWatcher, NoCache>>,
}

#[derive(Debug)]
pub struct UserFoldersManager {
    pub folders: HashMap<FolderType, FolderDetails>,
}

unsafe impl Send for UserFoldersManager {}
unsafe impl Send for UserFoldersManagerEvent {}

event_manager!(UserFoldersManager, UserFoldersManagerEvent);

impl UserFoldersManager {
    /// Blocks until the manager is built, prefer [`Self::is_initialized`] + this, or
    /// [`Self::init_in_background`], on paths that shouldn't wait (like IPC commands).
    pub fn instance() -> &'static TracedMutex<Self> {
        static USER_FOLDERS_MANAGER: LazyLock<TracedMutex<UserFoldersManager>> =
            LazyLock::new(|| {
                let manager = TracedMutex::new(UserFoldersManager::new());
                INITIALIZED.store(true, Ordering::Release);
                manager
            });
        &USER_FOLDERS_MANAGER
    }

    /// Indexing the known user folders scans and starts watching all of them, which on
    /// some systems takes a long time (huge trees, slow/unavailable paths). Doing that
    /// lazily from an IPC command left widgets waiting forever on `get_user_folder_content`,
    /// so the work is done once on a background thread instead.
    pub fn init_in_background() {
        static SPAWNED: Once = Once::new();
        SPAWNED.call_once(|| {
            std::thread::spawn(|| {
                let _ = Self::instance();
                // widgets that got an empty list while this was running are updated by these
                for &folder_type in FolderType::values() {
                    Self::send(UserFoldersManagerEvent::FolderChanged(folder_type));
                }
            });
        });
    }

    pub fn is_initialized() -> bool {
        INITIALIZED.load(Ordering::Acquire)
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
        // Recent is a flat folder of .lnk shortcuts; others are scanned up to 3 levels deep
        // to avoid exploding on large/deep folder trees.
        let max_depth = match folder_type {
            FolderType::Recent => 1,
            _ => 3,
        };

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
                    if only_ignored_paths(&root, &events) {
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
            let manager = Self::instance().lock();
            match manager.folders.get(&folder_type) {
                Some(folder_details) => folder_details.path.clone(),
                None => return Ok(()),
            }
        };

        let content = Self::get_folder_content(path, folder_type)?;

        {
            let mut manager = Self::instance().lock();
            if let Some(folder_details) = manager.folders.get_mut(&folder_type) {
                folder_details.content = content;
            }
        }

        let _ = Self::event_tx().send(UserFoldersManagerEvent::FolderChanged(folder_type));
        Ok(())
    }

    /// Infallible on purpose: this runs lazily from the `get_user_folder_content` command,
    /// so panicking here would leave that IPC call pending forever and poison the lazy
    /// instance for every later call. Folders that can't be read or watched are skipped or
    /// degraded instead.
    pub fn new() -> Self {
        let mut folders = HashMap::new();

        for &folder_type in FolderType::values() {
            let Some(path) = Self::get_path_from_folder(&folder_type) else {
                continue;
            };

            if !path.is_dir() {
                log::warn!("Skipping user folder {folder_type:?}, missing directory: {path:?}");
                continue;
            }

            let content = Self::get_folder_content(path.clone(), folder_type).unwrap_or_default();
            // watching is best effort, a folder that can't be watched is still listed
            let watcher = match Self::create_folder_watcher(&path, folder_type) {
                Ok(watcher) => Some(watcher),
                Err(err) => {
                    log::error!("Failed to watch user folder {folder_type:?} ({path:?}): {err:?}");
                    None
                }
            };

            folders.insert(
                folder_type,
                FolderDetails {
                    path,
                    content,
                    _watcher: watcher,
                },
            );
        }

        Self { folders }
    }
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
