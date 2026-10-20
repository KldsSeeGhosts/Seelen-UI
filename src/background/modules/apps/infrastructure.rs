use std::{
    collections::HashMap,
    sync::{LazyLock, Once},
    time::Duration,
};

use seelen_core::{
    handlers::SeelenEvent,
    system_state::{FocusedApp, UserAppWindow, UserAppWindowColors, UserAppWindowPreview},
};
use slu_utils::Throttle;
use windows::Win32::UI::Shell::{IShellDispatch6, Shell};

use crate::{
    app::emit_to_webviews,
    error::Result,
    modules::apps::application::{UserAppsManager, previews::WinPreviewManager},
    widgets::permissions::{WidgetPerm, request_widget_permission},
    windows_api::{Com, input::Mouse, window::Window},
};

/// Window captures arrive in bursts (several windows at once, or a window moving); the
/// events carry the complete preview/color maps, so broadcasting one per capture resends
/// every cached thumbnail. Bursts are coalesced over this short interval instead.
const BROADCAST_COALESCE_INTERVAL: Duration = Duration::from_millis(80);

static PREVIEWS_BROADCAST: LazyLock<Throttle<()>> = LazyLock::new(|| {
    slu_utils::throttle(
        |_| {
            emit_to_webviews(
                SeelenEvent::UserAppWindowsPreviewsChanged,
                WinPreviewManager::instance().get_previews(),
            );
        },
        BROADCAST_COALESCE_INTERVAL,
    )
});

static COLORS_BROADCAST: LazyLock<Throttle<()>> = LazyLock::new(|| {
    slu_utils::throttle(
        |_| {
            emit_to_webviews(
                SeelenEvent::UserAppWindowsColorsChanged,
                WinPreviewManager::instance().get_colors(),
            );
        },
        BROADCAST_COALESCE_INTERVAL,
    )
});

/// Lazy initialization wrapper that registers Tauri events on first access
/// This keeps Tauri logic separate from system logic while ensuring lazy initialization
fn get_apps_manager() -> &'static UserAppsManager {
    static TAURI_EVENT_REGISTRATION: Once = Once::new();
    TAURI_EVENT_REGISTRATION.call_once(|| {
        UserAppsManager::subscribe(|_event| {
            emit_to_webviews(
                SeelenEvent::UserAppWindowsChanged,
                UserAppsManager::instance().interactable_windows.to_vec(),
            );
        });

        WinPreviewManager::subscribe(|event| {
            use crate::modules::apps::application::previews::WinPreviewEvent;
            match event {
                WinPreviewEvent::Captured(_) => PREVIEWS_BROADCAST.call(()),
                WinPreviewEvent::ColorsUpdated(_) => COLORS_BROADCAST.call(()),
                // the window also disappears from the colors map
                WinPreviewEvent::Cleaned(_) => {
                    PREVIEWS_BROADCAST.call(());
                    COLORS_BROADCAST.call(());
                }
            }
        });
    });
    UserAppsManager::instance()
}

impl crate::tauri_handlers::Handlers {
    pub fn get_focused_app() -> FocusedApp {
        Window::get_foregrounded().as_focused_app_information()
    }

    pub fn get_mouse_position() -> [i32; 2] {
        let point = Mouse::get_cursor_pos().unwrap_or_default();
        [point.x, point.y]
    }

    pub fn get_key_state(key: String) -> Result<bool> {
        use win_hotkeys::VKey;
        use win_hotkeys::state::KeyboardState;

        let key = VKey::from_keyname(&key)?;
        if key == VKey::Menu {
            return Ok(KeyboardState::async_is_key_down(VKey::Menu.to_vk_code())
                || KeyboardState::async_is_key_down(VKey::LMenu.to_vk_code())
                || KeyboardState::async_is_key_down(VKey::RMenu.to_vk_code()));
        }

        Ok(KeyboardState::async_is_key_down(key.to_vk_code()))
    }

    pub fn get_user_app_windows() -> Vec<UserAppWindow> {
        get_apps_manager().interactable_windows.to_vec()
    }

    pub fn get_user_app_windows_previews() -> HashMap<isize, UserAppWindowPreview> {
        get_apps_manager();
        WinPreviewManager::instance().get_previews()
    }

    pub fn get_user_app_windows_colors() -> HashMap<isize, UserAppWindowColors> {
        get_apps_manager();
        WinPreviewManager::instance().get_colors()
    }

    /// This function is called show_desktop but acts more like minimize_all
    pub fn show_desktop(webview: tauri::WebviewWindow) -> Result<()> {
        request_widget_permission(&webview, WidgetPerm::ManageAppWindows)?;
        Com::run_with_context(|| {
            let shell: IShellDispatch6 = Com::create_instance(&Shell)?;
            unsafe { shell.ToggleDesktop()? };
            Ok(())
        })
    }
}
