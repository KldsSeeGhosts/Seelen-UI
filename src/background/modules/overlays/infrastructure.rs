use std::sync::Once;

use seelen_core::{handlers::SeelenEvent, system_state::UserAppOverlayWindow};

use crate::{
    app::emit_to_webviews,
    modules::overlays::{OverlayManager, OverlayManagerEvent},
};

fn get_overlay_manager() -> &'static OverlayManager {
    static TAURI_EVENT_REGISTRATION: Once = Once::new();
    TAURI_EVENT_REGISTRATION.call_once(|| {
        OverlayManager::subscribe(|event| {
            if event == OverlayManagerEvent::Changed {
                emit_to_webviews(
                    SeelenEvent::UserAppOverlaysChanged,
                    OverlayManager::instance().snapshot(),
                );
            }
        });
    });
    OverlayManager::instance()
}

impl crate::tauri_handlers::Handlers {
    pub fn get_user_app_overlays() -> Vec<UserAppOverlayWindow> {
        get_overlay_manager().snapshot()
    }
}
