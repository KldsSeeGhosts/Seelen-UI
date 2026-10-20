use std::{
    collections::HashMap,
    sync::{
        LazyLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{DynamicImage, RgbaImage};
use seelen_core::system_state::{Color, UserAppWindowColors, UserAppWindowPreview};
use slu_utils::{Debounce, debounce};
use win_screenshot::prelude::capture_window;

use crate::{
    error::{Result, ResultLogExt},
    event_manager,
    hook::HookManager,
    modules::apps::application::{USER_APPS_MANAGER, UserAppWinEvent, UserAppsManager},
    utils::lock_free::SyncHashMap,
    windows_api::{
        WindowsApi,
        event_window::IS_INTERACTIVE_SESSION,
        window::{Window, event::WinEvent},
    },
};

const CAPTURE_WINDOW_INTERVAL: Duration = Duration::from_millis(200);
/// Longest side of a stored preview, in pixels.
const MAX_PREVIEW_SIZE: u32 = 640;
/// Number of pixel samples taken evenly across the top and bottom edges of a window.
const SAMPLING: usize = 7;

static WINDOWS_PREVIEWS: LazyLock<WinPreviewManager> = LazyLock::new(WinPreviewManager::create);
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

/// One-by-one capture queue: sender side, receiver processes in a dedicated thread.
/// Only windows without an already queued capture are sent, so the queue never holds
/// more than one pending request per window.
static CAPTURE_TX: LazyLock<crossbeam_channel::Sender<(isize, u64)>> = LazyLock::new(|| {
    let (tx, rx) = crossbeam_channel::unbounded::<(isize, u64)>();
    std::thread::Builder::new()
        .name("win-capture-queue".into())
        .spawn(move || {
            for (addr, generation) in rx {
                WINDOWS_PREVIEWS.process_queued_capture(addr, generation);
            }
        })
        .log_error();
    tx
});

pub struct WinPreviewManager {
    previews: SyncHashMap<isize, UserAppWindowPreviewWrap>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum WinPreviewEvent {
    Captured(isize),
    ColorsUpdated(isize),
    Cleaned(isize),
}

event_manager!(WinPreviewManager, WinPreviewEvent);

impl WinPreviewManager {
    pub fn instance() -> &'static Self {
        &WINDOWS_PREVIEWS
    }

    fn create() -> Self {
        let manager = Self {
            previews: SyncHashMap::new(),
        };
        manager.init().log_error();
        manager
    }

    fn init(&self) -> Result<()> {
        // Force initialization of the capture queue thread before any enqueue.
        let _ = &*CAPTURE_TX;

        let windows = UserAppsManager::instance()
            .interactable_windows
            .map(|w| w.hwnd);

        for hwnd in windows {
            self.register_window(hwnd);
        }

        UserAppsManager::subscribe(|e| match e {
            UserAppWinEvent::Added(addr) => {
                WINDOWS_PREVIEWS.register_window(addr);
            }
            UserAppWinEvent::Updated(_) => {}
            UserAppWinEvent::Removed(addr) => {
                if WINDOWS_PREVIEWS.previews.remove(&addr).is_some() {
                    Self::send(WinPreviewEvent::Cleaned(addr));
                }
            }
        });

        HookManager::subscribe(|(event, window)| {
            if !USER_APPS_MANAGER.contains_win(&window) {
                return;
            }
            let addr = window.address();
            match event {
                WinEvent::ObjectNameChange | WinEvent::SynDebouncedRectChange => {
                    WINDOWS_PREVIEWS.enqueue_capture(addr);
                }
                WinEvent::SystemMinimizeEnd => {
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(300));
                        WINDOWS_PREVIEWS.enqueue_capture(addr);
                    });
                }
                _ => {}
            }
        });

        Ok(())
    }

    fn register_window(&self, addr: isize) {
        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let capture = debounce(
            move |_| WINDOWS_PREVIEWS.request_capture(addr, generation),
            CAPTURE_WINDOW_INTERVAL,
        );
        self.previews.upsert(
            addr,
            UserAppWindowPreviewWrap {
                generation,
                preview: None,
                colors: None,
                capture,
                queued: false,
                capturing: false,
                pending_recapture: false,
            },
        );
        self.enqueue_capture(addr);
    }

    /// Debounced capture request for a window, coalescing bursts of window events.
    fn enqueue_capture(&self, addr: isize) {
        self.previews.get(&addr, |wrap| {
            wrap.capture.call(());
        });
    }

    /// Queues a capture unless one is already waiting for this window; a change requested
    /// while the window is being captured schedules exactly one recapture afterwards.
    fn request_capture(&self, addr: isize, generation: u64) {
        let mut should_queue = false;
        self.previews.get(&addr, |wrap| {
            if wrap.generation != generation || wrap.queued {
                return;
            }
            if wrap.capturing {
                wrap.pending_recapture = true;
                return;
            }
            wrap.queued = true;
            should_queue = true;
        });

        if should_queue && let Err(e) = CAPTURE_TX.send((addr, generation)) {
            log::error!("Failed to enqueue window capture: {e}");
            self.previews.get(&addr, |wrap| {
                if wrap.generation == generation {
                    wrap.queued = false;
                }
            });
        }
    }

    /// Captures a window that was requested through the capture queue. Runs on the capture
    /// thread, so the slow screenshot/encoding work never blocks event dispatch.
    fn process_queued_capture(&self, addr: isize, generation: u64) {
        let should_capture = self.previews.get(&addr, |wrap| {
            // the window can be closed while its capture is queued; its entry is removed
            // in that case and nothing must be captured or published for it anymore
            if wrap.generation != generation || !wrap.queued {
                return false;
            }
            wrap.queued = false;
            wrap.capturing = true;
            true
        });

        if should_capture != Some(true) {
            return;
        }

        if IS_INTERACTIVE_SESSION.load(std::sync::atomic::Ordering::Acquire) {
            let window = Window::from(addr);
            // the handle can be destroyed (or reused by another window) while queued
            if window.is_window() && window.is_manageable_from_unelevated() {
                self.do_capture(&window, generation).log_error();
            }
        }

        let recapture = self
            .previews
            .get(&addr, |wrap| {
                if wrap.generation != generation {
                    return false;
                }
                wrap.capturing = false;
                std::mem::take(&mut wrap.pending_recapture)
            })
            .unwrap_or(false);

        if recapture {
            self.request_capture(addr, generation);
        }
    }

    fn do_capture(&self, window: &Window, generation: u64) -> Result<()> {
        if window.is_minimized() {
            return Ok(());
        }

        let addr = window.address();
        log::trace!("capturing window ({addr:x})");

        let buf = capture_window(window.address()).map_err(|_| "Failed to capture window")?;
        let raw = RgbaImage::from_raw(buf.width, buf.height, buf.pixels)
            .ok_or("Failed to create image")?;

        let shadow = WindowsApi::shadow_rect(window.hwnd())?;
        let crop_x = shadow.left.unsigned_abs();
        let crop_y = shadow.top.unsigned_abs();
        let crop_w = buf
            .width
            .saturating_sub(shadow.left.unsigned_abs() + shadow.right.unsigned_abs());
        let crop_h = buf
            .height
            .saturating_sub(shadow.top.unsigned_abs() + shadow.bottom.unsigned_abs());

        let cropped: RgbaImage =
            image::imageops::crop_imm(&raw, crop_x, crop_y, crop_w, crop_h).to_image();
        let image = downscale_preview(cropped);

        let colors = sample_edge_colors(&image);

        let image_hash = image_to_hash(&image);

        // the window can be closed while it is being captured, in that case nothing must
        // be published (its entry was already removed)
        let Some((preview_unchanged, colors_unchanged)) = self
            .previews
            .get(&addr, |wrap| {
                (wrap.generation == generation).then(|| {
                    (
                        wrap.preview.as_ref().is_some_and(|p| p.hash == image_hash),
                        wrap.colors
                            .as_ref()
                            .is_some_and(|stored| same_edge_colors(stored, &colors)),
                    )
                })
            })
            .flatten()
        else {
            return Ok(());
        };

        if !preview_unchanged {
            let dynamic = DynamicImage::ImageRgba8(image);
            let webp_bytes = webp::Encoder::from_image(&dynamic)
                .map_err(|e| e.to_string())?
                .encode(75.0);
            let data = STANDARD.encode(&*webp_bytes);

            let published = self
                .previews
                .get(&addr, |wrap| {
                    if wrap.generation != generation {
                        return false;
                    }
                    wrap.preview = Some(UserAppWindowPreview {
                        hash: image_hash,
                        data,
                        width: dynamic.width(),
                        height: dynamic.height(),
                    });
                    true
                })
                .unwrap_or(false);
            if published {
                Self::send(WinPreviewEvent::Captured(addr));
            }
        }

        // colors are republished only when the sampled edges actually changed
        if !colors_unchanged {
            let published = self
                .previews
                .get(&addr, |wrap| {
                    if wrap.generation != generation {
                        return false;
                    }
                    wrap.colors = Some(colors);
                    true
                })
                .unwrap_or(false);
            if published {
                Self::send(WinPreviewEvent::ColorsUpdated(addr));
            }
        }

        Ok(())
    }

    pub fn get_previews(&self) -> HashMap<isize, UserAppWindowPreview> {
        let mut map = HashMap::new();
        self.previews.for_each(|(k, v)| {
            if let Some(preview) = &v.preview {
                map.insert(*k, preview.clone());
            }
        });
        map
    }

    pub fn get_colors(&self) -> HashMap<isize, UserAppWindowColors> {
        let mut map = HashMap::new();
        self.previews.for_each(|(k, v)| {
            if let Some(colors) = &v.colors {
                map.insert(*k, colors.clone());
            }
        });
        map
    }
}

struct UserAppWindowPreviewWrap {
    generation: u64,
    preview: Option<UserAppWindowPreview>,
    colors: Option<UserAppWindowColors>,
    capture: Debounce<()>,
    /// A capture of this window is waiting in the capture queue.
    queued: bool,
    /// A capture of this window is currently running on the capture thread.
    capturing: bool,
    /// The window changed while it was being captured, so it needs one more capture.
    pending_recapture: bool,
}

/// Shrinks the preview so its longest side is at most [`MAX_PREVIEW_SIZE`], keeping the
/// aspect ratio. Images that already fit are returned untouched.
fn downscale_preview(source: RgbaImage) -> RgbaImage {
    let (width, height) = source.dimensions();
    let longest = width.max(height);
    if longest <= MAX_PREVIEW_SIZE {
        return source;
    }
    let scaled =
        |side: u32| ((side as u64 * MAX_PREVIEW_SIZE as u64) / longest as u64).max(1) as u32;
    image::imageops::thumbnail(&source, scaled(width), scaled(height))
}

/// Samples SAMPLING pixels evenly spaced from left to right along the top and bottom rows.
fn sample_edge_colors(image: &RgbaImage) -> UserAppWindowColors {
    let w = image.width();
    let h = image.height();

    let sample_x = |i: usize| -> u32 {
        if SAMPLING <= 1 {
            return 0;
        }
        ((i as u64 * (w as u64 - 1)) / (SAMPLING as u64 - 1)) as u32
    };

    let pixel_to_color = |x: u32, y: u32| -> Color {
        let p = image.get_pixel(x, y);
        Color {
            r: p[0],
            g: p[1],
            b: p[2],
            a: p[3],
        }
    };

    let sample_y = |i: usize| -> u32 {
        if SAMPLING <= 1 {
            return 0;
        }
        ((i as u64 * (h as u64 - 1)) / (SAMPLING as u64 - 1)) as u32
    };

    let top = (0..SAMPLING)
        .map(|i| pixel_to_color(sample_x(i), 0))
        .collect();
    let bottom = (0..SAMPLING)
        .map(|i| pixel_to_color(sample_x(i), h.saturating_sub(1)))
        .collect();
    let left = (0..SAMPLING)
        .map(|i| pixel_to_color(0, sample_y(i)))
        .collect();
    let right = (0..SAMPLING)
        .map(|i| pixel_to_color(w.saturating_sub(1), sample_y(i)))
        .collect();

    UserAppWindowColors {
        top,
        bottom,
        left,
        right,
    }
}

/// `UserAppWindowColors` is not `PartialEq`, so the sampled edges are compared field-wise
/// to avoid republishing (and re-cloning) colors that did not change.
fn same_edge_colors(a: &UserAppWindowColors, b: &UserAppWindowColors) -> bool {
    same_colors(&a.top, &b.top)
        && same_colors(&a.bottom, &b.bottom)
        && same_colors(&a.left, &b.left)
        && same_colors(&a.right, &b.right)
}

fn same_colors(a: &[Color], b: &[Color]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(a, b)| (a.r, a.g, a.b, a.a) == (b.r, b.g, b.b, b.a))
}

fn image_to_hash(icon_image: &image::RgbaImage) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    icon_image.as_raw().hash(&mut hasher);
    format!("{:x}", hasher.finish())
}
