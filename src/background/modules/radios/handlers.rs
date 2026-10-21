use std::sync::Once;

use seelen_core::{
    handlers::SeelenEvent,
    system_state::{RadioDevice, RadioDeviceKind},
};

use crate::{app::emit_to_webviews, error::Result, modules::radios::manager::RadioManager};

/// Wrapper for RadioManager that automatically registers Tauri events on first access
/// This keeps Tauri logic separate from system logic while ensuring lazy initialization
fn get_radio_manager() -> &'static RadioManager {
    static TAURI_EVENT_REGISTRATION: Once = Once::new();
    TAURI_EVENT_REGISTRATION.call_once(|| {
        RadioManager::subscribe(|_event| {
            emit_to_webviews(
                SeelenEvent::RadiosChanged,
                RadioManager::instance().get_radios(),
            );
        });
    });

    RadioManager::instance()
}

impl crate::tauri_handlers::Handlers {
    pub async fn get_radios() -> Result<Vec<RadioDevice>> {
        // The first call initializes the WinRT radio watcher, which blocks until the initial
        // enumeration completes. Keep that off the async command workers (and the UI thread).
        crate::get_tokio_handle()
            .spawn_blocking(|| get_radio_manager().get_radios())
            .await
            .map_err(|err| format!("Failed to read radios: {err}").into())
    }

    pub async fn set_radios_state(kind: RadioDeviceKind, enabled: bool) -> Result<()> {
        crate::get_tokio_handle()
            .spawn_blocking(move || get_radio_manager().set_radios_state(kind, enabled))
            .await
            .map_err(|err| format!("Failed to change radio state: {err}"))?
    }
}
