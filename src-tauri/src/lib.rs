use std::sync::Mutex;
use tauri::State;

struct AppState {
    items: Mutex<Vec<String>>,
    current_index: Mutex<usize>,
}

#[tauri::command]
fn get_items(state: State<AppState>) -> Vec<String> {
    state.items.lock().unwrap().clone()
}

#[tauri::command]
fn get_current_index(state: State<AppState>) -> usize {
    *state.current_index.lock().unwrap()
}

#[tauri::command]
fn add_item(item: String, state: State<AppState>) -> Vec<String> {
    let mut items = state.items.lock().unwrap();
    items.push(item);
    items.clone()
}

#[tauri::command]
fn remove_item(index: usize, state: State<AppState>) -> Vec<String> {
    let mut items = state.items.lock().unwrap();
    let mut current = state.current_index.lock().unwrap();

    if index < items.len() {
        items.remove(index);
        if *current >= items.len() && !items.is_empty() {
            *current = 0;
        }
    }
    items.clone()
}

#[tauri::command]
fn rotate_next(state: State<AppState>) -> (usize, Option<String>) {
    let items = state.items.lock().unwrap();
    let mut current = state.current_index.lock().unwrap();

    if items.is_empty() {
        return (0, None);
    }

    *current = (*current + 1) % items.len();
    (*current, Some(items[*current].clone()))
}

#[tauri::command]
fn get_current_item(state: State<AppState>) -> Option<String> {
    let items = state.items.lock().unwrap();
    let current = state.current_index.lock().unwrap();

    if items.is_empty() {
        None
    } else {
        Some(items[*current].clone())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState {
            items: Mutex::new(Vec::new()),
            current_index: Mutex::new(0),
        })
        .invoke_handler(tauri::generate_handler![
            get_items,
            get_current_index,
            add_item,
            remove_item,
            rotate_next,
            get_current_item
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
