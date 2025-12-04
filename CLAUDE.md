tauri, rust, react, time-tracking, desktop-app

## Development
- Run dev server: `tmux new-session -d -s tauri-dev "bun run tauri:dev"` (uses test database)
- Run production db: `bun run tauri dev` (uses `rotator.db`)
- Database configured via `ROTATOR_DB_NAME` env variable (defaults to `rotator.db`)

## Database
- SQLite stored at `~/.local/share/rotator/{ROTATOR_DB_NAME}`
- Tables: projects, tasks, app_state, active_tracking, time_entries
