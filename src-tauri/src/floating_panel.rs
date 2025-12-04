#[cfg(target_os = "macos")]
use cocoa::appkit::{
    NSBackingStoreType, NSColor, NSWindowCollectionBehavior, NSWindowStyleMask,
};
#[cfg(target_os = "macos")]
use cocoa::base::{id, nil, NO, YES};
#[cfg(target_os = "macos")]
use cocoa::foundation::{NSAutoreleasePool, NSPoint, NSRect, NSSize, NSString};
#[cfg(target_os = "macos")]
use objc::declare::ClassDecl;
#[cfg(target_os = "macos")]
use objc::runtime::{Class, Object, Sel, BOOL};
#[cfg(target_os = "macos")]
use objc::{class, msg_send, sel, sel_impl};
#[cfg(target_os = "macos")]
use std::sync::Once;

use std::sync::Mutex;
use std::sync::atomic::{AtomicPtr, Ordering};
use tauri::Manager;

#[cfg(target_os = "macos")]
static REGISTER_CUSTOM_VIEW: Once = Once::new();

#[cfg(target_os = "macos")]
static STOP_QUEUE: Mutex<Vec<u64>> = Mutex::new(Vec::new());

#[cfg(target_os = "macos")]
static HOVERED_STOP_BUTTON: Mutex<Option<usize>> = Mutex::new(None);

#[cfg(target_os = "macos")]
static APP_HANDLE: AtomicPtr<std::ffi::c_void> = AtomicPtr::new(std::ptr::null_mut());

pub fn set_app_handle(handle: tauri::AppHandle) {
    let boxed = Box::new(handle);
    let ptr = Box::into_raw(boxed) as *mut std::ffi::c_void;
    APP_HANDLE.store(ptr, Ordering::SeqCst);
}

#[cfg(target_os = "macos")]
fn show_main_window() {
    let ptr = APP_HANDLE.load(Ordering::SeqCst);
    if !ptr.is_null() {
        let handle = unsafe { &*(ptr as *const tauri::AppHandle) };
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

pub fn pop_stopped_task() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        STOP_QUEUE.lock().ok()?.pop()
    }
    #[cfg(not(target_os = "macos"))]
    None
}

pub struct FloatingPanel {
    #[cfg(target_os = "macos")]
    panel: Mutex<Option<id>>,
    #[cfg(not(target_os = "macos"))]
    _phantom: std::marker::PhantomData<()>,
}

unsafe impl Send for FloatingPanel {}
unsafe impl Sync for FloatingPanel {}

#[derive(Clone)]
pub struct TimerEntry {
    pub task_id: u64,
    pub project_name: String,
    pub task_name: String,
    pub elapsed_seconds: u64,
}

#[derive(Clone)]
pub struct TimerState {
    pub entries: Vec<TimerEntry>,
}

impl Default for TimerState {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

#[cfg(target_os = "macos")]
static mut CURRENT_TIMER_STATE: Option<TimerState> = None;

impl FloatingPanel {
    pub fn new() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            panel: Mutex::new(None),
            #[cfg(not(target_os = "macos"))]
            _phantom: std::marker::PhantomData,
        }
    }

    #[cfg(target_os = "macos")]
    pub fn show(&self) {
        unsafe {
            let mut panel_guard = self.panel.lock().unwrap();

            if panel_guard.is_none() {
                let panel = self.create_panel();
                *panel_guard = Some(panel);
            }

            if let Some(panel) = *panel_guard {
                let () = msg_send![panel, orderFrontRegardless];
                let () = msg_send![panel, setIsVisible: YES];
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn show(&self) {}

    #[cfg(target_os = "macos")]
    pub fn hide(&self) {
        unsafe {
            let panel_guard = self.panel.lock().unwrap();
            if let Some(panel) = *panel_guard {
                let () = msg_send![panel, orderOut: nil];
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn hide(&self) {}

    #[cfg(target_os = "macos")]
    pub fn update(&self, state: TimerState) {
        unsafe {
            let entry_count = state.entries.len().max(1);
            CURRENT_TIMER_STATE = Some(state);

            let panel_guard = self.panel.lock().unwrap();
            if let Some(panel) = *panel_guard {
                // Resize panel based on number of entries
                let row_height: f64 = 36.0;
                let padding: f64 = 8.0;
                let new_height = (entry_count as f64 * row_height) + padding;

                let frame: NSRect = msg_send![panel, frame];
                let screen: id = msg_send![class!(NSScreen), mainScreen];
                let screen_frame: NSRect = msg_send![screen, frame];

                // Recalculate Y position to keep top-right anchor
                let margin: f64 = 20.0;
                let menu_bar_height: f64 = 25.0;
                let new_y = screen_frame.size.height - new_height - margin - menu_bar_height;

                let new_frame = NSRect::new(
                    NSPoint::new(frame.origin.x, new_y),
                    NSSize::new(frame.size.width, new_height),
                );
                let () = msg_send![panel, setFrame: new_frame display: YES animate: YES];

                let content_view: id = msg_send![panel, contentView];
                let () = msg_send![content_view, setNeedsDisplay: YES];
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn update(&self, _state: TimerState) {}

    #[cfg(target_os = "macos")]
    pub fn is_visible(&self) -> bool {
        unsafe {
            let panel_guard = self.panel.lock().unwrap();
            if let Some(panel) = *panel_guard {
                let visible: BOOL = msg_send![panel, isVisible];
                visible == YES
            } else {
                false
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn is_visible(&self) -> bool {
        false
    }

    #[cfg(target_os = "macos")]
    unsafe fn create_panel(&self) -> id {
        let _pool = NSAutoreleasePool::new(nil);

        // Get screen dimensions
        let screen: id = msg_send![class!(NSScreen), mainScreen];
        let screen_frame: NSRect = msg_send![screen, frame];

        // Panel dimensions
        let panel_width: f64 = 400.0;
        let panel_height: f64 = 36.0;
        let margin: f64 = 20.0;
        let menu_bar_height: f64 = 25.0;

        // Position at top-right
        let x = screen_frame.size.width - panel_width - margin;
        let y = screen_frame.size.height - panel_height - margin - menu_bar_height;

        let frame = NSRect::new(
            NSPoint::new(x, y),
            NSSize::new(panel_width, panel_height),
        );

        // Create NSPanel with borderless style
        // NSBorderlessWindowMask = 0, NSNonactivatingPanelMask = 1 << 7 = 128
        let style_mask = NSWindowStyleMask::NSBorderlessWindowMask;

        let panel: id = msg_send![class!(NSPanel), alloc];
        let panel: id = msg_send![panel,
            initWithContentRect: frame
            styleMask: style_mask
            backing: NSBackingStoreType::NSBackingStoreBuffered
            defer: NO
        ];

        // Set non-activating behavior
        let () = msg_send![panel, setStyleMask: 128u64]; // NSNonactivatingPanelMask

        // Configure panel
        let () = msg_send![panel, setLevel: 25i64]; // NSStatusWindowLevel
        let () = msg_send![panel, setOpaque: NO];
        let () = msg_send![panel, setBackgroundColor: NSColor::clearColor(nil)];
        let () = msg_send![panel, setHasShadow: YES];
        let () = msg_send![panel, setMovableByWindowBackground: YES];
        let () = msg_send![panel, setFloatingPanel: YES];
        let () = msg_send![panel, setHidesOnDeactivate: NO];

        // Collection behavior for all spaces
        let behavior = NSWindowCollectionBehavior::NSWindowCollectionBehaviorCanJoinAllSpaces
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehavior::NSWindowCollectionBehaviorIgnoresCycle;
        let () = msg_send![panel, setCollectionBehavior: behavior];

        // Create custom content view
        let content_view = self.create_content_view(frame);
        let () = msg_send![panel, setContentView: content_view];

        panel
    }

    #[cfg(target_os = "macos")]
    unsafe fn create_content_view(&self, frame: NSRect) -> id {
        REGISTER_CUSTOM_VIEW.call_once(|| {
            let superclass = class!(NSView);
            let mut decl = ClassDecl::new("FloatingTimerView", superclass).unwrap();

            decl.add_method(
                sel!(drawRect:),
                draw_rect as extern "C" fn(&Object, Sel, NSRect),
            );

            decl.add_method(
                sel!(mouseDown:),
                mouse_down as extern "C" fn(&Object, Sel, id),
            );

            decl.add_method(
                sel!(mouseMoved:),
                mouse_moved as extern "C" fn(&Object, Sel, id),
            );

            decl.add_method(
                sel!(mouseExited:),
                mouse_exited as extern "C" fn(&Object, Sel, id),
            );

            decl.add_method(
                sel!(updateTrackingAreas),
                update_tracking_areas as extern "C" fn(&Object, Sel),
            );

            decl.register();
        });

        let view_class = Class::get("FloatingTimerView").unwrap();
        let view: id = msg_send![view_class, alloc];
        let view: id = msg_send![view, initWithFrame: frame];

        // Set up initial tracking area
        let _: () = msg_send![view, updateTrackingAreas];

        view
    }
}

#[cfg(target_os = "macos")]
extern "C" fn draw_rect(this: &Object, _cmd: Sel, _dirty_rect: NSRect) {
    unsafe {
        let bounds: NSRect = msg_send![this, bounds];
        let state = CURRENT_TIMER_STATE.clone().unwrap_or_default();

        // Draw rounded background
        let bg_path: id = msg_send![class!(NSBezierPath), bezierPathWithRoundedRect: bounds
            xRadius: 12.0f64
            yRadius: 12.0f64
        ];

        let bg_color: id = msg_send![class!(NSColor), colorWithCalibratedRed: 0.06f64
            green: 0.06f64
            blue: 0.06f64
            alpha: 0.95f64
        ];
        let () = msg_send![bg_color, setFill];
        let () = msg_send![bg_path, fill];

        // Draw border
        let border_color: id = msg_send![class!(NSColor), colorWithCalibratedRed: 0.2f64
            green: 0.2f64
            blue: 0.2f64
            alpha: 0.8f64
        ];
        let () = msg_send![border_color, setStroke];
        let () = msg_send![bg_path, setLineWidth: 1.0f64];
        let () = msg_send![bg_path, stroke];

        // Fonts and colors
        let font: id = msg_send![class!(NSFont), systemFontOfSize: 11.0f64 weight: 0.4f64];
        let bold_font: id = msg_send![class!(NSFont), systemFontOfSize: 11.0f64 weight: 0.6f64];
        let white_color: id = msg_send![class!(NSColor), whiteColor];
        let gray_color: id = msg_send![class!(NSColor), colorWithCalibratedWhite: 0.6f64 alpha: 1.0f64];
        let green_color: id = msg_send![class!(NSColor), colorWithCalibratedRed: 0.133f64
            green: 0.773f64
            blue: 0.369f64
            alpha: 1.0f64
        ];

        let row_height: f64 = 36.0;
        let padding: f64 = 4.0;

        if state.entries.is_empty() {
            // No active timers
            let y = bounds.size.height / 2.0 - 6.0;
            draw_text("No active timer", 12.0, y, font, gray_color);
        } else {
            // Draw each entry from top to bottom
            for (i, entry) in state.entries.iter().enumerate() {
                let row_y = bounds.size.height - padding - ((i as f64 + 1.0) * row_height) + row_height / 2.0 - 6.0;

                // Green indicator dot
                let dot_rect = NSRect::new(
                    NSPoint::new(10.0, row_y + 3.0),
                    NSSize::new(6.0, 6.0),
                );
                let dot_path: id = msg_send![class!(NSBezierPath), bezierPathWithOvalInRect: dot_rect];
                let () = msg_send![green_color, setFill];
                let () = msg_send![dot_path, fill];

                // Project name (truncated with ellipsis if needed)
                let max_project_len = 20;
                let project_text: String = if entry.project_name.chars().count() > max_project_len {
                    format!("{}…", entry.project_name.chars().take(max_project_len - 1).collect::<String>())
                } else {
                    entry.project_name.clone()
                };
                draw_text(&project_text, 22.0, row_y, bold_font, white_color);

                // Separator and task name (truncated with ellipsis if needed)
                let project_width = text_width(&project_text, bold_font);
                draw_text("·", 22.0 + project_width + 4.0, row_y, font, gray_color);

                let max_task_len = 30;
                let task_text: String = if entry.task_name.chars().count() > max_task_len {
                    format!("{}…", entry.task_name.chars().take(max_task_len - 1).collect::<String>())
                } else {
                    entry.task_name.clone()
                };
                draw_text(&task_text, 22.0 + project_width + 12.0, row_y, font, gray_color);

                // Format time
                let elapsed = entry.elapsed_seconds;
                let hours = elapsed / 3600;
                let minutes = (elapsed % 3600) / 60;
                let seconds = elapsed % 60;
                let time_str = if hours > 0 {
                    format!("{}:{:02}:{:02}", hours, minutes, seconds)
                } else {
                    format!("{}:{:02}", minutes, seconds)
                };

                // Time (before stop button)
                let time_w = text_width(&time_str, bold_font);
                draw_text(&time_str, bounds.size.width - time_w - 40.0, row_y, bold_font, white_color);

                // Stop button (square icon)
                let is_hovered = HOVERED_STOP_BUTTON.lock().ok().and_then(|h| *h).map(|h| h == i).unwrap_or(false);
                let stop_btn_x = bounds.size.width - 28.0;
                let stop_btn_y = row_y + 1.0;
                let stop_rect = NSRect::new(
                    NSPoint::new(stop_btn_x, stop_btn_y),
                    NSSize::new(12.0, 12.0),
                );
                let stop_path: id = msg_send![class!(NSBezierPath), bezierPathWithRoundedRect: stop_rect
                    xRadius: 2.0f64
                    yRadius: 2.0f64
                ];
                let stop_color: id = if is_hovered {
                    // Red when hovered
                    msg_send![class!(NSColor), colorWithCalibratedRed: 0.937f64
                        green: 0.267f64
                        blue: 0.267f64
                        alpha: 1.0f64
                    ]
                } else {
                    // Gray when not hovered
                    msg_send![class!(NSColor), colorWithCalibratedWhite: 0.4f64 alpha: 0.6f64]
                };
                let () = msg_send![stop_color, setFill];
                let () = msg_send![stop_path, fill];

                // Draw separator line between entries (except last)
                if i < state.entries.len() - 1 {
                    let line_y = bounds.size.height - padding - ((i as f64 + 1.0) * row_height);
                    let line_color: id = msg_send![class!(NSColor), colorWithCalibratedWhite: 0.2f64 alpha: 0.5f64];
                    let () = msg_send![line_color, setStroke];

                    let line_path: id = msg_send![class!(NSBezierPath), bezierPath];
                    let () = msg_send![line_path, moveToPoint: NSPoint::new(10.0, line_y)];
                    let () = msg_send![line_path, lineToPoint: NSPoint::new(bounds.size.width - 10.0, line_y)];
                    let () = msg_send![line_path, setLineWidth: 0.5f64];
                    let () = msg_send![line_path, stroke];
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn get_row_at_point(bounds: NSRect, point: NSPoint, entry_count: usize) -> Option<usize> {
    let row_height: f64 = 36.0;
    let padding: f64 = 4.0;
    let click_y = bounds.size.height - point.y - padding;
    let row_index = (click_y / row_height) as usize;
    if row_index < entry_count {
        Some(row_index)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn is_over_stop_button(bounds: NSRect, point: NSPoint) -> bool {
    // Stop button is 12x12 at right side, with some padding
    let stop_btn_x = bounds.size.width - 28.0;
    let stop_btn_width = 12.0;
    point.x >= stop_btn_x && point.x <= stop_btn_x + stop_btn_width
}

#[cfg(target_os = "macos")]
extern "C" fn mouse_down(this: &Object, _cmd: Sel, event: id) {
    unsafe {
        let bounds: NSRect = msg_send![this, bounds];
        let location: NSPoint = msg_send![event, locationInWindow];
        let local_point: NSPoint = msg_send![this, convertPoint: location fromView: nil];

        let state = CURRENT_TIMER_STATE.clone().unwrap_or_default();
        if state.entries.is_empty() {
            return;
        }

        if let Some(row_index) = get_row_at_point(bounds, local_point, state.entries.len()) {
            if is_over_stop_button(bounds, local_point) {
                // Click on stop button - stop the timer
                let task_id = state.entries[row_index].task_id;
                if let Ok(mut queue) = STOP_QUEUE.lock() {
                    queue.push(task_id);
                }
            } else {
                // Click on row - open the app immediately
                show_main_window();
            }
        }
    }
}

#[cfg(target_os = "macos")]
extern "C" fn mouse_moved(this: &Object, _cmd: Sel, event: id) {
    unsafe {
        let bounds: NSRect = msg_send![this, bounds];
        let location: NSPoint = msg_send![event, locationInWindow];
        let local_point: NSPoint = msg_send![this, convertPoint: location fromView: nil];

        let state = CURRENT_TIMER_STATE.clone().unwrap_or_default();

        // Only show hover if mouse is over the stop button
        let new_hovered = if is_over_stop_button(bounds, local_point) {
            get_row_at_point(bounds, local_point, state.entries.len())
        } else {
            None
        };

        if let Ok(mut hovered) = HOVERED_STOP_BUTTON.lock() {
            if *hovered != new_hovered {
                *hovered = new_hovered;
                let () = msg_send![this, setNeedsDisplay: YES];
            }
        }
    }
}

#[cfg(target_os = "macos")]
extern "C" fn mouse_exited(this: &Object, _cmd: Sel, _event: id) {
    unsafe {
        if let Ok(mut hovered) = HOVERED_STOP_BUTTON.lock() {
            if hovered.is_some() {
                *hovered = None;
                let () = msg_send![this, setNeedsDisplay: YES];
            }
        }
    }
}

#[cfg(target_os = "macos")]
extern "C" fn update_tracking_areas(this: &Object, _cmd: Sel) {
    unsafe {
        // Remove existing tracking areas
        let tracking_areas: id = msg_send![this, trackingAreas];
        let count: usize = msg_send![tracking_areas, count];
        for i in (0..count).rev() {
            let area: id = msg_send![tracking_areas, objectAtIndex: i];
            let () = msg_send![this, removeTrackingArea: area];
        }

        // Add new tracking area
        let bounds: NSRect = msg_send![this, bounds];
        // NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited | NSTrackingActiveAlways
        let options: usize = 0x02 | 0x01 | 0x80;
        let tracking_area: id = msg_send![class!(NSTrackingArea), alloc];
        let tracking_area: id = msg_send![tracking_area,
            initWithRect: bounds
            options: options
            owner: this
            userInfo: nil
        ];
        let () = msg_send![this, addTrackingArea: tracking_area];
    }
}

#[cfg(target_os = "macos")]
unsafe fn draw_text(text: &str, x: f64, y: f64, font: id, color: id) {
    let ns_string = NSString::alloc(nil).init_str(text);

    let attrs: id = msg_send![class!(NSMutableDictionary), dictionary];
    let font_key = NSString::alloc(nil).init_str("NSFont");
    let color_key = NSString::alloc(nil).init_str("NSColor");
    let () = msg_send![attrs, setObject: font forKey: font_key];
    let () = msg_send![attrs, setObject: color forKey: color_key];

    let point = NSPoint::new(x, y);
    let () = msg_send![ns_string, drawAtPoint: point withAttributes: attrs];
}

#[cfg(target_os = "macos")]
unsafe fn text_width(text: &str, font: id) -> f64 {
    let ns_string = NSString::alloc(nil).init_str(text);

    let attrs: id = msg_send![class!(NSMutableDictionary), dictionary];
    let font_key = NSString::alloc(nil).init_str("NSFont");
    let () = msg_send![attrs, setObject: font forKey: font_key];

    let size: NSSize = msg_send![ns_string, sizeWithAttributes: attrs];
    size.width
}
