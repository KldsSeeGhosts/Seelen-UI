use seelen_core::{
    resource::{ResourceId, ResourceKind, SluResource},
    state::{
        IconPack, Plugin, Theme, Wallpaper, Widget, settings::shortcuts::SystemShortcutDeclaration,
    },
};

use crate::{
    error::{Result, ResultLogExt},
    resources::RESOURCES,
    utils::icon_extractor::queue::IconExtractor,
    widgets::{
        permissions::{WidgetPerm, request_widget_permission},
        webview::WidgetWebviewLabel,
    },
};
use std::{path::PathBuf, sync::Arc};

async fn delete_path(path: PathBuf) {
    if path.is_dir() {
        tokio::fs::remove_dir_all(&path).await.log_error();
    } else {
        tokio::fs::remove_file(&path).await.log_error();
    }
}

impl crate::tauri_handlers::Handlers {
    pub fn state_get_widgets() -> Vec<Arc<Widget>> {
        RESOURCES.widgets()
    }

    /// Resolves the widget definition of the calling webview. Widgets used to fetch the whole
    /// widget list on startup just to pick their own entry; this serializes a single
    /// definition instead (and fails when the webview is not a widget instance).
    pub fn get_self_widget(webview: tauri::WebviewWindow) -> Result<Arc<Widget>> {
        let label = WidgetWebviewLabel::try_from_raw(webview.label())?;
        RESOURCES
            .widgets
            .read_sync(&label.widget_id, |_, widget| widget.clone())
            .ok_or_else(|| format!("Widget definition not found for {}", label.widget_id).into())
    }

    pub fn state_get_system_shortcuts() -> Vec<SystemShortcutDeclaration> {
        seelen_core::state::settings::shortcuts::system_shortcut_declarations()
    }

    pub fn state_get_themes() -> Vec<Arc<Theme>> {
        RESOURCES.themes()
    }

    pub fn state_get_plugins() -> Vec<Arc<Plugin>> {
        RESOURCES.plugins()
    }

    pub fn state_get_wallpapers() -> Vec<Arc<Wallpaper>> {
        RESOURCES.wallpapers()
    }

    pub fn state_get_icon_packs() -> Vec<Arc<IconPack>> {
        RESOURCES.icon_packs()
    }

    pub async fn remove_resource(
        webview: tauri::WebviewWindow,
        id: ResourceId,
        kind: ResourceKind,
    ) -> Result<()> {
        request_widget_permission(&webview, WidgetPerm::ModifyConfiguration)?;
        let mut to_delete = Vec::new();

        match kind {
            ResourceKind::Theme => {
                RESOURCES
                    .themes
                    .retain_async(|_, v| {
                        if *v.id == id && !v.metadata.internal.bundled {
                            to_delete.push(v.metadata.internal.path.clone());
                            return false;
                        }
                        true
                    })
                    .await;
            }
            ResourceKind::Plugin => {
                RESOURCES
                    .plugins
                    .retain_async(|_, v| {
                        if *v.id == id && !v.metadata.internal.bundled {
                            to_delete.push(v.metadata.internal.path.clone());
                            return false;
                        }
                        true
                    })
                    .await;
            }
            ResourceKind::Widget => {
                RESOURCES
                    .widgets
                    .retain_async(|_, v| {
                        if *v.id == id && !v.metadata.internal.bundled {
                            to_delete.push(v.metadata.internal.path.clone());
                            return false;
                        }
                        true
                    })
                    .await;
            }
            ResourceKind::IconPack => {
                RESOURCES
                    .icon_packs
                    .retain_async(|_, v| {
                        if *v.id == id && !v.metadata.internal.bundled {
                            to_delete.push(v.metadata.internal.path.clone());
                            return false;
                        }
                        true
                    })
                    .await;
            }
            ResourceKind::Wallpaper => {
                RESOURCES
                    .wallpapers
                    .retain_async(|_, v| {
                        if *v.id == id && !v.metadata.internal.bundled {
                            to_delete.push(v.metadata.internal.path.clone());
                            return false;
                        }
                        true
                    })
                    .await;
            }
            ResourceKind::SoundPack => {
                // feature not implemented
            }
        }

        for path in to_delete {
            delete_path(path).await;
        }

        RESOURCES.emit_kind_changed(&kind)?;
        Ok(())
    }

    pub async fn state_delete_cached_icons() -> Result<()> {
        // Take the pack before awaiting — never hold MutexGuard across an await point
        let pack = { RESOURCES.system_icon_pack.lock().take() };
        if let Some(pack) = pack {
            pack.delete().await?;
        }
        IconExtractor::instance().clear_failures();
        RESOURCES.ensure_system_icon_pack(true)?;
        RESOURCES.emit_icon_packs();
        Ok(())
    }
}
