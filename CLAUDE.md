tauri, rust, react, time-tracking, desktop-app

## Development
- Run dev server: `tmux new-session -d -s tauri-dev "bun run tauri:dev"` (uses test database)
- Run production db: `bun run tauri dev` (uses `rotator.db`)
- Database configured via `ROTATOR_DB_NAME` env variable (defaults to `rotator.db`)

## Database
- SQLite stored at `~/.local/share/rotator/{ROTATOR_DB_NAME}`
- Tables: projects, tasks, app_state, active_tracking, time_entries

## Floating Timer (Native macOS Panel)
- Location: `src-tauri/src/floating_panel.rs`
- Uses native NSPanel via cocoa/objc crates (NOT webview) for true transparency and instant response
- Always-on-top, draggable, visible on all spaces
- Architecture:
  - `FLOATING_PANEL` static instance created via `once_cell::Lazy`
  - `APP_HANDLE` stored at startup for window operations from native code
  - `CURRENT_TIMER_STATE` holds timer entries for drawing
  - `STOP_QUEUE` for communicating stop requests back to frontend (polled every 100ms)
- Click handling:
  - Click on stop button → adds task_id to `STOP_QUEUE`
  - Click elsewhere on row → calls `show_main_window()` directly (no polling, instant)
- Hover tracking via `NSTrackingArea` for stop button highlight
- Frontend polls `poll_floating_timer_stop` for stop requests (webview throttling doesn't affect stop since it only matters when window visible)
- Updates sent via `update_floating_timer` command with entries array
