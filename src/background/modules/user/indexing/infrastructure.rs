use std::{path::PathBuf, sync::Once};

use seelen_core::{
    handlers::SeelenEvent,
    system_state::{FolderChangedArgs, FolderType, UserFolderSnapshot},
};

use crate::{app::emit_to_webviews, utils::lock_free::TracedMutex};

use super::application::{UserFoldersManager, UserFoldersManagerEvent};

fn register_folder_events() {
    static TAURI_EVENT_REGISTRATION: Once = Once::new();
    TAURI_EVENT_REGISTRATION.call_once(|| {
        UserFoldersManager::subscribe(|event| match event {
            UserFoldersManagerEvent::FolderChanged(folder) => {
                let content = UserFoldersManager::instance()
                    .lock()
                    .snapshot(folder)
                    .content;
                emit_to_webviews(
                    SeelenEvent::UserFolderChanged,
                    FolderChangedArgs {
                        of_folder: folder,
                        content,
                    },
                );
            }
        });
    });
}

/// Returns the manager, creating it (cheaply) if needed, and makes sure the tauri event
/// registration and the background indexing worker are set up. The manager is available
/// before the first scan finishes, so this must not depend on the indexing state.
fn ensure_folders_manager() -> &'static TracedMutex<UserFoldersManager> {
    register_folder_events();
    let manager = UserFoldersManager::instance();
    UserFoldersManager::init_in_background();
    manager
}

impl crate::tauri_handlers::Handlers {
    pub fn get_user_folder_content(folder_type: FolderType) -> Vec<PathBuf> {
        ensure_folders_manager()
            .lock()
            .snapshot(folder_type)
            .content
    }

    pub fn get_user_folder_content_state(folder_type: FolderType) -> UserFolderSnapshot {
        ensure_folders_manager().lock().snapshot(folder_type)
    }
}
