use std::sync::Once;

use seelen_core::{handlers::SeelenEvent, system_state::SeelenFont};

use crate::{app::emit_to_webviews, error::Result};

use super::application::{FontManager, FontManagerEvent};

fn get_font_manager() -> &'static FontManager {
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| {
        FontManager::subscribe(|event| {
            if event == FontManagerEvent::FontsChanged
                && let Ok(fonts) = FontManager::instance().get_fonts()
            {
                emit_to_webviews(SeelenEvent::SystemFontsChanged, &fonts);
            }
        });
    });
    FontManager::instance()
}

impl crate::tauri_handlers::Handlers {
    pub async fn get_fonts() -> Result<Vec<SeelenFont>> {
        crate::get_tokio_handle()
            .spawn_blocking(|| get_font_manager().get_fonts())
            .await
            .map_err(|err| format!("Failed to read fonts: {err}"))?
    }
}
