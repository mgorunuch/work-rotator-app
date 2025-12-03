import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./App.css";

const HOTKEY = "CommandOrControl+Shift+R";

function App() {
  const [items, setItems] = useState<string[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [newItem, setNewItem] = useState("");
  const [hotkeyRegistered, setHotkeyRegistered] = useState(false);

  const loadItems = useCallback(async () => {
    const items = await invoke<string[]>("get_items");
    const index = await invoke<number>("get_current_index");
    setItems(items);
    setCurrentIndex(index);
  }, []);

  const registerHotkey = useCallback(async () => {
    try {
      await register(HOTKEY, async (event) => {
        if (event.state === "Pressed") {
          const [index] = await invoke<[number, string | null]>("rotate_next");
          setCurrentIndex(index);
        }
      });
      setHotkeyRegistered(true);
    } catch (e) {
      console.error("Failed to register hotkey:", e);
      setHotkeyRegistered(false);
    }
  }, []);

  useEffect(() => {
    loadItems();
    registerHotkey();
    return () => {
      unregister(HOTKEY).catch(console.error);
    };
  }, [loadItems, registerHotkey]);

  const addItem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItem.trim()) return;
    const updated = await invoke<string[]>("add_item", { item: newItem.trim() });
    setItems(updated);
    setNewItem("");
  };

  const removeItem = async (index: number) => {
    const updated = await invoke<string[]>("remove_item", { index });
    setItems(updated);
    const newIndex = await invoke<number>("get_current_index");
    setCurrentIndex(newIndex);
  };

  const rotateManually = async () => {
    if (items.length === 0) return;
    const [index] = await invoke<[number, string | null]>("rotate_next");
    setCurrentIndex(index);
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Item Rotator</h1>
        <div className={`hotkey-badge ${hotkeyRegistered ? "active" : "inactive"}`}>
          <kbd>{HOTKEY.replace("CommandOrControl", "⌘")}</kbd>
          <span>{hotkeyRegistered ? "Active" : "Inactive"}</span>
        </div>
      </header>

      {items.length > 0 && (
        <div className="current-section">
          <div className="current-label">Current Item</div>
          <div className="current-value" onClick={rotateManually}>
            {items[currentIndex]}
          </div>
          <div className="current-indicator">
            {currentIndex + 1} of {items.length}
          </div>
        </div>
      )}

      <form onSubmit={addItem} className="add-form">
        <input
          type="text"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          placeholder="Add new item..."
          className="add-input"
        />
        <button type="submit" className="add-btn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </form>

      <div className="items-container">
        {items.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                <line x1="9" y1="12" x2="15" y2="12"></line>
              </svg>
            </div>
            <p>No items yet</p>
            <span>Add items above to start rotating</span>
          </div>
        ) : (
          <ul className="items-list">
            {items.map((item, index) => (
              <li
                key={index}
                className={`item ${index === currentIndex ? "active" : ""}`}
                onClick={() => setCurrentIndex(index)}
              >
                <span className="item-index">{index + 1}</span>
                <span className="item-text">{item}</span>
                <button
                  className="remove-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeItem(index);
                  }}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="footer">
        <span>Click current item or press hotkey to rotate</span>
      </footer>
    </div>
  );
}

export default App;
