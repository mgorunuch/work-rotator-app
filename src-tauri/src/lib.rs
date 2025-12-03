use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    image::Image,
    tray::TrayIconBuilder,
    AppHandle, Manager, State,
};

#[derive(Clone, Serialize, Deserialize)]
struct Task {
    id: u64,
    name: String,
    time_seconds: u64,
}

#[derive(Clone, Serialize, Deserialize)]
struct Project {
    id: u64,
    name: String,
    tasks: Vec<Task>,
    current_task_index: usize,
}

#[derive(Clone, Serialize, Deserialize)]
struct ActiveTracking {
    project_id: u64,
    task_id: u64,
    started_at: u64,
}

struct AppState {
    db: Mutex<Connection>,
    projects: Mutex<Vec<Project>>,
    current_project_index: Mutex<usize>,
    next_project_id: Mutex<u64>,
    next_task_id: Mutex<u64>,
    active_tracking: Mutex<Option<ActiveTracking>>,
}

fn get_db_path() -> PathBuf {
    let mut path = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("rotator");
    std::fs::create_dir_all(&path).ok();
    path.push("rotator.db");
    path
}

fn init_db(conn: &Connection) {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            current_task_index INTEGER NOT NULL DEFAULT 0
        )",
        [],
    ).expect("Failed to create projects table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY,
            project_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            time_seconds INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        )",
        [],
    ).expect("Failed to create tasks table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_state (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    ).expect("Failed to create app_state table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS active_tracking (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            project_id INTEGER NOT NULL,
            task_id INTEGER NOT NULL,
            started_at INTEGER NOT NULL
        )",
        [],
    ).expect("Failed to create active_tracking table");
}

fn load_projects(conn: &Connection) -> Vec<Project> {
    let mut stmt = conn.prepare("SELECT id, name, current_task_index FROM projects ORDER BY id").unwrap();
    let project_iter = stmt.query_map([], |row| {
        Ok((row.get::<_, u64>(0)?, row.get::<_, String>(1)?, row.get::<_, usize>(2)?))
    }).unwrap();

    let mut projects = Vec::new();
    for project_result in project_iter {
        let (id, name, current_task_index) = project_result.unwrap();
        let tasks = load_tasks(conn, id);
        projects.push(Project { id, name, tasks, current_task_index });
    }
    projects
}

fn load_tasks(conn: &Connection, project_id: u64) -> Vec<Task> {
    let mut stmt = conn.prepare("SELECT id, name, time_seconds FROM tasks WHERE project_id = ? ORDER BY id").unwrap();
    let task_iter = stmt.query_map([project_id], |row| {
        Ok(Task {
            id: row.get(0)?,
            name: row.get(1)?,
            time_seconds: row.get(2)?,
        })
    }).unwrap();

    task_iter.filter_map(|t| t.ok()).collect()
}

fn load_current_project_index(conn: &Connection) -> usize {
    conn.query_row(
        "SELECT value FROM app_state WHERE key = 'current_project_index'",
        [],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|v| v.parse().ok())
    .unwrap_or(0)
}

fn save_current_project_index(conn: &Connection, index: usize) {
    conn.execute(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES ('current_project_index', ?)",
        [index.to_string()],
    ).ok();
}

fn get_next_id(conn: &Connection, table: &str) -> u64 {
    conn.query_row(
        &format!("SELECT COALESCE(MAX(id), 0) + 1 FROM {}", table),
        [],
        |row| row.get(0),
    ).unwrap_or(1)
}

fn load_active_tracking(conn: &Connection) -> Option<ActiveTracking> {
    conn.query_row(
        "SELECT project_id, task_id, started_at FROM active_tracking WHERE id = 1",
        [],
        |row| {
            Ok(ActiveTracking {
                project_id: row.get(0)?,
                task_id: row.get(1)?,
                started_at: row.get(2)?,
            })
        },
    ).ok()
}

fn save_active_tracking(conn: &Connection, tracking: Option<&ActiveTracking>) {
    conn.execute("DELETE FROM active_tracking WHERE id = 1", []).ok();
    if let Some(t) = tracking {
        conn.execute(
            "INSERT INTO active_tracking (id, project_id, task_id, started_at) VALUES (1, ?, ?, ?)",
            params![t.project_id, t.task_id, t.started_at],
        ).ok();
    }
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[tauri::command]
fn get_projects(state: State<AppState>) -> Vec<Project> {
    state.projects.lock().unwrap().clone()
}

#[tauri::command]
fn get_current_project_index(state: State<AppState>) -> usize {
    *state.current_project_index.lock().unwrap()
}

#[tauri::command]
fn add_project(name: String, state: State<AppState>) -> Vec<Project> {
    let mut projects = state.projects.lock().unwrap();
    let mut next_id = state.next_project_id.lock().unwrap();
    let db = state.db.lock().unwrap();

    let project = Project {
        id: *next_id,
        name: name.clone(),
        tasks: Vec::new(),
        current_task_index: 0,
    };

    db.execute(
        "INSERT INTO projects (id, name, current_task_index) VALUES (?, ?, 0)",
        params![*next_id, name],
    ).ok();

    projects.push(project);
    *next_id += 1;

    projects.clone()
}

#[tauri::command]
fn remove_project(project_id: u64, state: State<AppState>) -> Vec<Project> {
    let mut projects = state.projects.lock().unwrap();
    let mut current = state.current_project_index.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();
    let db = state.db.lock().unwrap();

    if let Some(pos) = projects.iter().position(|p| p.id == project_id) {
        if let Some(ref t) = *tracking {
            if t.project_id == project_id {
                *tracking = None;
                save_active_tracking(&db, None);
            }
        }

        db.execute("DELETE FROM tasks WHERE project_id = ?", [project_id]).ok();
        db.execute("DELETE FROM projects WHERE id = ?", [project_id]).ok();

        projects.remove(pos);
        if *current >= projects.len() && !projects.is_empty() {
            *current = 0;
        }
        save_current_project_index(&db, *current);
    }

    projects.clone()
}

#[tauri::command]
fn rotate_project(state: State<AppState>) -> (usize, Option<Project>) {
    let projects = state.projects.lock().unwrap();
    let mut current = state.current_project_index.lock().unwrap();
    let db = state.db.lock().unwrap();

    if projects.is_empty() {
        return (0, None);
    }

    *current = (*current + 1) % projects.len();
    save_current_project_index(&db, *current);
    (*current, Some(projects[*current].clone()))
}

#[tauri::command]
fn set_current_project(index: usize, state: State<AppState>) -> usize {
    let projects = state.projects.lock().unwrap();
    let mut current = state.current_project_index.lock().unwrap();
    let db = state.db.lock().unwrap();

    if index < projects.len() {
        *current = index;
        save_current_project_index(&db, *current);
    }

    *current
}

#[tauri::command]
fn rotate_task(state: State<AppState>) -> Option<Task> {
    let mut projects = state.projects.lock().unwrap();
    let current_idx = state.current_project_index.lock().unwrap();
    let db = state.db.lock().unwrap();

    if projects.is_empty() {
        return None;
    }

    let project = &mut projects[*current_idx];
    if project.tasks.is_empty() {
        return None;
    }

    project.current_task_index = (project.current_task_index + 1) % project.tasks.len();

    db.execute(
        "UPDATE projects SET current_task_index = ? WHERE id = ?",
        params![project.current_task_index, project.id],
    ).ok();

    Some(project.tasks[project.current_task_index].clone())
}

#[tauri::command]
fn add_task(project_id: u64, name: String, state: State<AppState>) -> Option<Project> {
    let mut projects = state.projects.lock().unwrap();
    let mut next_task_id = state.next_task_id.lock().unwrap();
    let db = state.db.lock().unwrap();

    if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
        let task = Task {
            id: *next_task_id,
            name: name.clone(),
            time_seconds: 0,
        };

        db.execute(
            "INSERT INTO tasks (id, project_id, name, time_seconds) VALUES (?, ?, ?, 0)",
            params![*next_task_id, project_id, name],
        ).ok();

        project.tasks.push(task);
        *next_task_id += 1;
        return Some(project.clone());
    }

    None
}

#[tauri::command]
fn remove_task(project_id: u64, task_id: u64, state: State<AppState>) -> Option<Project> {
    let mut projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();
    let db = state.db.lock().unwrap();

    if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
        if let Some(ref t) = *tracking {
            if t.project_id == project_id && t.task_id == task_id {
                *tracking = None;
                save_active_tracking(&db, None);
            }
        }

        if let Some(pos) = project.tasks.iter().position(|t| t.id == task_id) {
            db.execute("DELETE FROM tasks WHERE id = ?", [task_id]).ok();

            project.tasks.remove(pos);
            if project.current_task_index >= project.tasks.len() && !project.tasks.is_empty() {
                project.current_task_index = 0;
            }

            db.execute(
                "UPDATE projects SET current_task_index = ? WHERE id = ?",
                params![project.current_task_index, project_id],
            ).ok();
        }
        return Some(project.clone());
    }

    None
}

#[tauri::command]
fn rename_project(project_id: u64, new_name: String, state: State<AppState>) -> Vec<Project> {
    let mut projects = state.projects.lock().unwrap();
    let db = state.db.lock().unwrap();

    if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
        project.name = new_name.clone();
        db.execute(
            "UPDATE projects SET name = ? WHERE id = ?",
            params![new_name, project_id],
        ).ok();
    }

    projects.clone()
}

#[tauri::command]
fn rename_task(project_id: u64, task_id: u64, new_name: String, state: State<AppState>) -> Option<Project> {
    let mut projects = state.projects.lock().unwrap();
    let db = state.db.lock().unwrap();

    if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
        if let Some(task) = project.tasks.iter_mut().find(|t| t.id == task_id) {
            task.name = new_name.clone();
            db.execute(
                "UPDATE tasks SET name = ? WHERE id = ?",
                params![new_name, task_id],
            ).ok();
        }
        return Some(project.clone());
    }

    None
}

#[tauri::command]
fn start_tracking(project_id: u64, task_id: u64, state: State<AppState>) -> Option<ActiveTracking> {
    let projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();
    let db = state.db.lock().unwrap();

    if tracking.is_some() {
        drop(tracking);
        drop(projects);
        drop(db);
        stop_tracking_internal(&state);
        return start_tracking_internal(project_id, task_id, &state);
    }

    if projects.iter().any(|p| p.id == project_id && p.tasks.iter().any(|t| t.id == task_id)) {
        let new_tracking = ActiveTracking {
            project_id,
            task_id,
            started_at: now_seconds(),
        };
        save_active_tracking(&db, Some(&new_tracking));
        *tracking = Some(new_tracking.clone());
        return Some(new_tracking);
    }

    None
}

fn start_tracking_internal(project_id: u64, task_id: u64, state: &State<AppState>) -> Option<ActiveTracking> {
    let projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();
    let db = state.db.lock().unwrap();

    if projects.iter().any(|p| p.id == project_id && p.tasks.iter().any(|t| t.id == task_id)) {
        let new_tracking = ActiveTracking {
            project_id,
            task_id,
            started_at: now_seconds(),
        };
        save_active_tracking(&db, Some(&new_tracking));
        *tracking = Some(new_tracking.clone());
        return Some(new_tracking);
    }

    None
}

fn stop_tracking_internal(state: &State<AppState>) -> Option<u64> {
    let mut projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();
    let db = state.db.lock().unwrap();

    if let Some(ref t) = *tracking {
        let elapsed = now_seconds() - t.started_at;

        if let Some(project) = projects.iter_mut().find(|p| p.id == t.project_id) {
            if let Some(task) = project.tasks.iter_mut().find(|tk| tk.id == t.task_id) {
                task.time_seconds += elapsed;
                db.execute(
                    "UPDATE tasks SET time_seconds = ? WHERE id = ?",
                    params![task.time_seconds, task.id],
                ).ok();
            }
        }

        save_active_tracking(&db, None);
        *tracking = None;
        return Some(elapsed);
    }

    None
}

#[tauri::command]
fn stop_tracking(state: State<AppState>) -> Option<u64> {
    let mut projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();
    let db = state.db.lock().unwrap();

    if let Some(ref t) = *tracking {
        let elapsed = now_seconds() - t.started_at;

        if let Some(project) = projects.iter_mut().find(|p| p.id == t.project_id) {
            if let Some(task) = project.tasks.iter_mut().find(|tk| tk.id == t.task_id) {
                task.time_seconds += elapsed;
                db.execute(
                    "UPDATE tasks SET time_seconds = ? WHERE id = ?",
                    params![task.time_seconds, task.id],
                ).ok();
            }
        }

        save_active_tracking(&db, None);
        *tracking = None;
        return Some(elapsed);
    }

    None
}

#[tauri::command]
fn get_active_tracking(state: State<AppState>) -> Option<ActiveTracking> {
    state.active_tracking.lock().unwrap().clone()
}

#[tauri::command]
fn get_current_project(state: State<AppState>) -> Option<Project> {
    let projects = state.projects.lock().unwrap();
    let current = state.current_project_index.lock().unwrap();

    if projects.is_empty() {
        None
    } else {
        Some(projects[*current].clone())
    }
}

#[tauri::command]
fn update_tray_title(app: AppHandle, title: String) -> Result<(), String> {
    match app.tray_by_id("main-tray") {
        Some(tray) => {
            tray.set_title(Some(&title)).map_err(|e| e.to_string())?;
            Ok(())
        }
        None => Err("Tray not found".to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let db_path = get_db_path();
    let conn = Connection::open(&db_path).expect("Failed to open database");
    init_db(&conn);

    let projects = load_projects(&conn);
    let current_project_index = load_current_project_index(&conn);
    let next_project_id = get_next_id(&conn, "projects");
    let next_task_id = get_next_id(&conn, "tasks");
    let active_tracking = load_active_tracking(&conn);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            db: Mutex::new(conn),
            projects: Mutex::new(projects),
            current_project_index: Mutex::new(current_project_index),
            next_project_id: Mutex::new(next_project_id),
            next_task_id: Mutex::new(next_task_id),
            active_tracking: Mutex::new(active_tracking),
        })
        .setup(|app| {
            // Set window height to 80% of screen
            if let Some(window) = app.get_webview_window("main") {
                if let Some(monitor) = window.current_monitor().ok().flatten() {
                    let screen_height = monitor.size().height as f64 / monitor.scale_factor();
                    let target_height = (screen_height * 0.8) as u32;
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize {
                        width: (400.0 * monitor.scale_factor()) as u32,
                        height: (target_height as f64 * monitor.scale_factor()) as u32,
                    }));
                    let _ = window.center();
                }
            }

            let icon_bytes = include_bytes!("../icons/32x32.png");
            let icon = Image::from_bytes(icon_bytes).expect("Failed to load tray icon");

            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .icon_as_template(true)
                .title("Rotator")
                .tooltip("Project Rotator")
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_current_project_index,
            add_project,
            remove_project,
            rename_project,
            rotate_project,
            set_current_project,
            rotate_task,
            add_task,
            remove_task,
            rename_task,
            start_tracking,
            stop_tracking,
            get_active_tracking,
            get_current_project,
            update_tray_title
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
