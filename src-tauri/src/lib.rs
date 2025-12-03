use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

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
    projects: Mutex<Vec<Project>>,
    current_project_index: Mutex<usize>,
    next_project_id: Mutex<u64>,
    next_task_id: Mutex<u64>,
    active_tracking: Mutex<Option<ActiveTracking>>,
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

    projects.push(Project {
        id: *next_id,
        name,
        tasks: Vec::new(),
        current_task_index: 0,
    });
    *next_id += 1;

    projects.clone()
}

#[tauri::command]
fn remove_project(project_id: u64, state: State<AppState>) -> Vec<Project> {
    let mut projects = state.projects.lock().unwrap();
    let mut current = state.current_project_index.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();

    if let Some(pos) = projects.iter().position(|p| p.id == project_id) {
        if let Some(ref t) = *tracking {
            if t.project_id == project_id {
                *tracking = None;
            }
        }

        projects.remove(pos);
        if *current >= projects.len() && !projects.is_empty() {
            *current = 0;
        }
    }

    projects.clone()
}

#[tauri::command]
fn rotate_project(state: State<AppState>) -> (usize, Option<Project>) {
    let projects = state.projects.lock().unwrap();
    let mut current = state.current_project_index.lock().unwrap();

    if projects.is_empty() {
        return (0, None);
    }

    *current = (*current + 1) % projects.len();
    (*current, Some(projects[*current].clone()))
}

#[tauri::command]
fn set_current_project(index: usize, state: State<AppState>) -> usize {
    let projects = state.projects.lock().unwrap();
    let mut current = state.current_project_index.lock().unwrap();

    if index < projects.len() {
        *current = index;
    }

    *current
}

#[tauri::command]
fn add_task(project_id: u64, name: String, state: State<AppState>) -> Option<Project> {
    let mut projects = state.projects.lock().unwrap();
    let mut next_task_id = state.next_task_id.lock().unwrap();

    if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
        project.tasks.push(Task {
            id: *next_task_id,
            name,
            time_seconds: 0,
        });
        *next_task_id += 1;
        return Some(project.clone());
    }

    None
}

#[tauri::command]
fn remove_task(project_id: u64, task_id: u64, state: State<AppState>) -> Option<Project> {
    let mut projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();

    if let Some(project) = projects.iter_mut().find(|p| p.id == project_id) {
        if let Some(ref t) = *tracking {
            if t.project_id == project_id && t.task_id == task_id {
                *tracking = None;
            }
        }

        if let Some(pos) = project.tasks.iter().position(|t| t.id == task_id) {
            project.tasks.remove(pos);
            if project.current_task_index >= project.tasks.len() && !project.tasks.is_empty() {
                project.current_task_index = 0;
            }
        }
        return Some(project.clone());
    }

    None
}

#[tauri::command]
fn start_tracking(project_id: u64, task_id: u64, state: State<AppState>) -> Option<ActiveTracking> {
    let projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();

    if tracking.is_some() {
        drop(tracking);
        drop(projects);
        stop_tracking_internal(&state);
        return start_tracking_internal(project_id, task_id, &state);
    }

    if projects.iter().any(|p| p.id == project_id && p.tasks.iter().any(|t| t.id == task_id)) {
        let new_tracking = ActiveTracking {
            project_id,
            task_id,
            started_at: now_seconds(),
        };
        *tracking = Some(new_tracking.clone());
        return Some(new_tracking);
    }

    None
}

fn start_tracking_internal(project_id: u64, task_id: u64, state: &State<AppState>) -> Option<ActiveTracking> {
    let projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();

    if projects.iter().any(|p| p.id == project_id && p.tasks.iter().any(|t| t.id == task_id)) {
        let new_tracking = ActiveTracking {
            project_id,
            task_id,
            started_at: now_seconds(),
        };
        *tracking = Some(new_tracking.clone());
        return Some(new_tracking);
    }

    None
}

fn stop_tracking_internal(state: &State<AppState>) -> Option<u64> {
    let mut projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();

    if let Some(ref t) = *tracking {
        let elapsed = now_seconds() - t.started_at;

        if let Some(project) = projects.iter_mut().find(|p| p.id == t.project_id) {
            if let Some(task) = project.tasks.iter_mut().find(|tk| tk.id == t.task_id) {
                task.time_seconds += elapsed;
            }
        }

        *tracking = None;
        return Some(elapsed);
    }

    None
}

#[tauri::command]
fn stop_tracking(state: State<AppState>) -> Option<u64> {
    let mut projects = state.projects.lock().unwrap();
    let mut tracking = state.active_tracking.lock().unwrap();

    if let Some(ref t) = *tracking {
        let elapsed = now_seconds() - t.started_at;

        if let Some(project) = projects.iter_mut().find(|p| p.id == t.project_id) {
            if let Some(task) = project.tasks.iter_mut().find(|tk| tk.id == t.task_id) {
                task.time_seconds += elapsed;
            }
        }

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            projects: Mutex::new(Vec::new()),
            current_project_index: Mutex::new(0),
            next_project_id: Mutex::new(1),
            next_task_id: Mutex::new(1),
            active_tracking: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_projects,
            get_current_project_index,
            add_project,
            remove_project,
            rotate_project,
            set_current_project,
            add_task,
            remove_task,
            start_tracking,
            stop_tracking,
            get_active_tracking,
            get_current_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
