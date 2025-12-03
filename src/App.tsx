import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./App.css";

const DEFAULT_HOTKEY_PROJECT = "CommandOrControl+Shift+P";
const DEFAULT_HOTKEY_TASK = "CommandOrControl+Shift+O";
const DEFAULT_HOTKEY_STOP = "CommandOrControl+Shift+I";

interface HotkeySettings {
  projectHotkey: string;
  taskHotkey: string;
  stopHotkey: string;
}

interface Task {
  id: number;
  name: string;
  time_seconds: number;
}

interface Project {
  id: number;
  name: string;
  tasks: Task[];
  current_task_index: number;
}

interface ActiveTracking {
  project_id: number;
  task_id: number;
  started_at: number;
}

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

type View = "main" | "donate" | "settings";

interface AdData {
  url: string;
  imagePath: string;
}

const AD_WIDTH = 320;
const AD_HEIGHT = 50;

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectIndex, setCurrentProjectIndex] = useState(0);
  const [newProjectName, setNewProjectName] = useState("");
  const [newTaskName, setNewTaskName] = useState("");
  const [_hotkeyRegistered, setHotkeyRegistered] = useState(false);
  const [activeTracking, setActiveTracking] = useState<ActiveTracking | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [currentView, setCurrentView] = useState<View>("main");
  const [adsEnabled, setAdsEnabled] = useState(() => {
    const saved = localStorage.getItem("adsEnabled");
    return saved ? JSON.parse(saved) : false;
  });
  const [adData, setAdData] = useState<AdData | null>(null);
  const [adLoading, setAdLoading] = useState(false);
  const [hotkeySettings, setHotkeySettings] = useState<HotkeySettings>(() => {
    const saved = localStorage.getItem("hotkeySettings");
    const defaults = { projectHotkey: DEFAULT_HOTKEY_PROJECT, taskHotkey: DEFAULT_HOTKEY_TASK, stopHotkey: DEFAULT_HOTKEY_STOP };
    return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
  });
  const [recordingHotkey, setRecordingHotkey] = useState<"project" | "task" | "stop" | null>(null);
  const currentProject = projects[currentProjectIndex] || null;
  const projectInputRef = useRef<HTMLInputElement>(null);
  const taskInputRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    const loadedProjects = await invoke<Project[]>("get_projects");
    const index = await invoke<number>("get_current_project_index");
    const tracking = await invoke<ActiveTracking | null>("get_active_tracking");
    setProjects(loadedProjects);
    setCurrentProjectIndex(index);
    setActiveTracking(tracking);
  }, []);

  const registerHotkeys = useCallback(async () => {
    try {
      await register(hotkeySettings.projectHotkey, async (event) => {
        if (event.state === "Pressed") {
          const [index] = await invoke<[number, Project | null]>("rotate_project");
          setCurrentProjectIndex(index);
          const loadedProjects = await invoke<Project[]>("get_projects");
          const project = loadedProjects[index];
          if (project) {
            setProjects(loadedProjects);
            // Auto-start tracking current task
            const task = project.tasks[project.current_task_index];
            if (task) {
              const tracking = await invoke<ActiveTracking | null>("start_tracking", {
                projectId: project.id,
                taskId: task.id,
              });
              setActiveTracking(tracking);
              if (tracking) setElapsedTime(0);
            }
          }
        }
      });
      await register(hotkeySettings.taskHotkey, async (event) => {
        if (event.state === "Pressed") {
          const task = await invoke<Task | null>("rotate_task");
          if (task) {
            const loadedProjects = await invoke<Project[]>("get_projects");
            setProjects(loadedProjects);
            const currentIdx = await invoke<number>("get_current_project_index");
            const project = loadedProjects[currentIdx];
            if (project) {
              const tracking = await invoke<ActiveTracking | null>("start_tracking", {
                projectId: project.id,
                taskId: task.id,
              });
              setActiveTracking(tracking);
              if (tracking) setElapsedTime(0);
            }
          }
        }
      });
      await register(hotkeySettings.stopHotkey, async (event) => {
        if (event.state === "Pressed") {
          await invoke<number | null>("stop_tracking");
          setActiveTracking(null);
          const loadedProjects = await invoke<Project[]>("get_projects");
          setProjects(loadedProjects);
        }
      });
      setHotkeyRegistered(true);
    } catch (e) {
      console.error("Failed to register hotkeys:", e);
      setHotkeyRegistered(false);
    }
  }, [hotkeySettings]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    // Don't register hotkeys when on settings page
    if (currentView === "settings") {
      unregister(hotkeySettings.projectHotkey).catch(console.error);
      unregister(hotkeySettings.taskHotkey).catch(console.error);
      unregister(hotkeySettings.stopHotkey).catch(console.error);
      setHotkeyRegistered(false);
      return;
    }

    registerHotkeys();
    return () => {
      unregister(hotkeySettings.projectHotkey).catch(console.error);
      unregister(hotkeySettings.taskHotkey).catch(console.error);
      unregister(hotkeySettings.stopHotkey).catch(console.error);
    };
  }, [registerHotkeys, hotkeySettings, currentView]);

  useEffect(() => {
    if (!activeTracking) {
      setElapsedTime(0);
      return;
    }

    const interval = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      setElapsedTime(now - activeTracking.started_at);
    }, 1000);

    return () => clearInterval(interval);
  }, [activeTracking]);

  // Update system tray title
  useEffect(() => {
    const updateTray = async () => {
      let title = "";
      const truncateName = (name: string, maxLen = 10) =>
        name.length > maxLen ? name.slice(0, maxLen) + "…" : name;

      if (activeTracking && currentProject) {
        const task = currentProject.tasks.find(t => t.id === activeTracking.task_id);
        const taskName = task ? task.name : "";
        title = `[${truncateName(currentProject.name, 6)}] ${truncateName(taskName, 8)} │ ${formatTime(elapsedTime)}`;
      } else if (currentProject) {
        title = `${truncateName(currentProject.name)} (${currentProjectIndex + 1}/${projects.length})`;
      } else {
        title = "Rotator";
      }

      try {
        await invoke("update_tray_title", { title });
      } catch (e) {
        console.error("Failed to update tray:", e);
      }
    };

    updateTray();
  }, [activeTracking, elapsedTime, currentProject, currentProjectIndex, projects.length]);

  useEffect(() => {
    if (!adsEnabled) {
      setAdData(null);
      return;
    }

    const fetchAd = async () => {
      setAdLoading(true);
      try {
        const response = await fetch("https://the-ihor.com/ads/rotator");
        if (response.ok) {
          const data: AdData = await response.json();
          setAdData(data);
        }
      } catch (error) {
        console.error("Failed to fetch ad:", error);
      } finally {
        setAdLoading(false);
      }
    };

    fetchAd();
  }, [adsEnabled]);

  const getAdImageUrl = (imagePath: string): string => {
    return imagePath
      .replace("$WIDTH", String(AD_WIDTH))
      .replace("$HEIGHT", String(AD_HEIGHT));
  };

  const addProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;
    const updated = await invoke<Project[]>("add_project", { name: newProjectName.trim() });
    setProjects(updated);
    setNewProjectName("");
  };

  const removeProject = async (projectId: number) => {
    const updated = await invoke<Project[]>("remove_project", { projectId });
    setProjects(updated);
    const newIndex = await invoke<number>("get_current_project_index");
    setCurrentProjectIndex(newIndex);
    const tracking = await invoke<ActiveTracking | null>("get_active_tracking");
    setActiveTracking(tracking);
  };

  const addTask = async (projectId: number) => {
    if (!newTaskName.trim()) return;
    const updated = await invoke<Project | null>("add_task", { projectId, name: newTaskName.trim() });
    if (updated) {
      setProjects(projects.map(p => p.id === projectId ? updated : p));
    }
    setNewTaskName("");
  };

  const removeTask = async (projectId: number, taskId: number) => {
    const updated = await invoke<Project | null>("remove_task", { projectId, taskId });
    if (updated) {
      setProjects(projects.map(p => p.id === projectId ? updated : p));
    }
    const tracking = await invoke<ActiveTracking | null>("get_active_tracking");
    setActiveTracking(tracking);
  };

  const startTracking = async (projectId: number, taskId: number) => {
    const tracking = await invoke<ActiveTracking | null>("start_tracking", { projectId, taskId });
    setActiveTracking(tracking);
    if (tracking) {
      setElapsedTime(0);
    }
  };

  const stopTracking = async () => {
    await invoke<number | null>("stop_tracking");
    setActiveTracking(null);
    await loadData();
  };

  const rotateManually = async () => {
    if (projects.length === 0) return;
    const [index] = await invoke<[number, Project | null]>("rotate_project");
    setCurrentProjectIndex(index);
  };

  const selectProject = async (index: number) => {
    await invoke<number>("set_current_project", { index });
    setCurrentProjectIndex(index);
  };

  const getTaskTime = (task: Task): number => {
    if (activeTracking?.task_id === task.id) {
      return task.time_seconds + elapsedTime;
    }
    return task.time_seconds;
  };

  const getProjectTotalTime = (project: Project): number =>
    project.tasks.reduce((sum, task) => sum + getTaskTime(task), 0);

  const toggleAds = () => {
    const newValue = !adsEnabled;
    setAdsEnabled(newValue);
    localStorage.setItem("adsEnabled", JSON.stringify(newValue));
  };

  const formatHotkeyForDisplay = (hotkey: string): string => {
    return hotkey
      .replace("CommandOrControl", "Cmd/Ctrl")
      .replace("Shift", "Shift")
      .replace("Alt", "Alt")
      .replace(/\+/g, " + ");
  };

  const formatHotkeyShort = (hotkey: string): string => {
    return hotkey
      .replace("CommandOrControl+", "⌘")
      .replace("Shift+", "⇧")
      .replace("Alt+", "⌥");
  };

  const handleHotkeyRecord = (e: React.KeyboardEvent, type: "project" | "task" | "stop") => {
    e.preventDefault();
    e.stopPropagation();

    // Ignore modifier-only keys
    const ignoredKeys = ["Control", "Shift", "Alt", "Meta", "CapsLock", "Tab", "Escape"];
    if (ignoredKeys.includes(e.key)) return;

    const parts: string[] = [];
    if (e.metaKey || e.ctrlKey) parts.push("CommandOrControl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");

    // Get the actual key
    let key = e.key.toUpperCase();
    if (e.code.startsWith("Key")) {
      key = e.code.replace("Key", "");
    } else if (e.code.startsWith("Digit")) {
      key = e.code.replace("Digit", "");
    }

    if (/^[A-Z0-9]$/.test(key)) {
      parts.push(key);
    } else {
      return;
    }

    // Require at least one modifier
    if (parts.length < 2) return;

    const newHotkey = parts.join("+");
    const keyMap = { project: "projectHotkey", task: "taskHotkey", stop: "stopHotkey" } as const;
    const newSettings = {
      ...hotkeySettings,
      [keyMap[type]]: newHotkey,
    };
    setHotkeySettings(newSettings);
    localStorage.setItem("hotkeySettings", JSON.stringify(newSettings));
    setRecordingHotkey(null);
  };

  const resetHotkeys = () => {
    const defaultSettings = { projectHotkey: DEFAULT_HOTKEY_PROJECT, taskHotkey: DEFAULT_HOTKEY_TASK, stopHotkey: DEFAULT_HOTKEY_STOP };
    setHotkeySettings(defaultSettings);
    localStorage.setItem("hotkeySettings", JSON.stringify(defaultSettings));
  };

  return (
    <div className="app">
      {currentView === "main" ? (
        <>
          {currentProject && (
            <div className="current-section" onClick={rotateManually}>
              <div className="current-label">Current Project</div>
              <div className="current-value">{currentProject.name}</div>
              <div className="current-indicator">
                {currentProjectIndex + 1} of {projects.length} • {formatTime(getProjectTotalTime(currentProject))}
              </div>
            </div>
          )}

          <div className="inline-add-form project-inline-add">
            <span className="inline-add-icon" onClick={() => projectInputRef.current?.focus()}>+</span>
            <input
              ref={projectInputRef}
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (newProjectName.trim()) {
                    addProject(e as unknown as React.FormEvent);
                  }
                }
              }}
              onBlur={() => {
                if (newProjectName.trim()) {
                  addProject({ preventDefault: () => {} } as React.FormEvent);
                }
              }}
              placeholder="Add project..."
              className="inline-add-input"
            />
          </div>

          <div className="items-container">
        {projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="3" y="3" width="18" height="18" rx="2"></rect>
                <line x1="9" y1="12" x2="15" y2="12"></line>
              </svg>
            </div>
            <p>No projects yet</p>
            <span>Add projects above to start tracking</span>
          </div>
        ) : (
          <ul className="projects-list">
            {projects.map((project, index) => (
              <li key={project.id} className="project-item">
                <div
                  className={`project-header ${index === currentProjectIndex ? "active" : ""}`}
                  onClick={() => selectProject(index)}
                >
                  <span className="project-index">{index + 1}</span>
                  <span className="project-name">{project.name}</span>
                  <span className="project-time">{formatTime(getProjectTotalTime(project))}</span>
                  <button
                    className="remove-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeProject(project.id);
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>

                {index === currentProjectIndex && (
                  <div className="tasks-section">
                    <div className="inline-add-form task-inline-add">
                      <span className="inline-add-icon" onClick={() => taskInputRef.current?.focus()}>+</span>
                      <input
                        ref={taskInputRef}
                        type="text"
                        value={newTaskName}
                        onChange={(e) => setNewTaskName(e.target.value)}
                        placeholder="Add task..."
                        className="inline-add-input"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addTask(project.id);
                          }
                        }}
                        onBlur={() => {
                          if (newTaskName.trim()) {
                            addTask(project.id);
                          }
                        }}
                      />
                    </div>

                    {project.tasks.length === 0 ? (
                      <div className="no-tasks">No tasks yet</div>
                    ) : (
                      <ul className="tasks-list">
                        {project.tasks.map((task) => {
                          const isTracking = activeTracking?.project_id === project.id && activeTracking?.task_id === task.id;
                          return (
                            <li key={task.id} className={`task-item ${isTracking ? "tracking" : ""}`}>
                              <span className="task-name">{task.name}</span>
                              <span className="task-time">{formatTime(getTaskTime(task))}</span>
                              <button
                                className={`track-btn ${isTracking ? "stop" : "start"}`}
                                onClick={() => isTracking ? stopTracking() : startTracking(project.id, task.id)}
                              >
                                {isTracking ? (
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                    <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                                  </svg>
                                ) : (
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                                  </svg>
                                )}
                              </button>
                              <button
                                className="remove-task-btn"
                                onClick={() => removeTask(project.id, task.id)}
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <line x1="18" y1="6" x2="6" y2="18"></line>
                                  <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

          <footer className="footer">
            <span>{formatHotkeyShort(hotkeySettings.projectHotkey)} project • {formatHotkeyShort(hotkeySettings.taskHotkey)} task • {formatHotkeyShort(hotkeySettings.stopHotkey)} stop</span>
          </footer>
        </>
      ) : currentView === "donate" ? (
        <div className="donate-view">
          <div className="donate-section">
            <h2>Enable Ads</h2>
            <p className="donate-description">
              Support development by enabling banner ads in the app.
            </p>
            <div className="ads-toggle-container">
              <button
                className={`ads-toggle ${adsEnabled ? "enabled" : ""}`}
                onClick={toggleAds}
              >
                <span className="toggle-track">
                  <span className="toggle-thumb"></span>
                </span>
                <span className="toggle-label">{adsEnabled ? "Ads Enabled" : "Ads Disabled"}</span>
              </button>
            </div>
            {adsEnabled && (
              <div className="ad-preview">
                {adLoading ? (
                  <div className="ad-banner-preview ad-loading">
                    <span className="ad-text">Loading ad...</span>
                  </div>
                ) : adData ? (
                  <a
                    href={adData.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ad-banner-link"
                  >
                    <img
                      src={getAdImageUrl(adData.imagePath)}
                      alt="Advertisement"
                      className="ad-banner-image"
                      width={AD_WIDTH}
                      height={AD_HEIGHT}
                    />
                  </a>
                ) : (
                  <div className="ad-banner-preview ad-error">
                    <span className="ad-label">AD</span>
                    <span className="ad-text">No ad available</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="donate-section">
            <h2>Donate</h2>
            <p className="donate-description">
              Support the project directly through donation.
            </p>
            <div className="donate-iframe-container">
              <iframe
                src="https://the-ihor.com/donate"
                title="Donate"
                className="donate-iframe"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="settings-view">
          <div className="settings-section">
            <h2>Keyboard Shortcuts</h2>
            <p className="settings-description">
              Click on a shortcut to record a new key combination.
            </p>
            <div className="hotkey-list">
              <div className="hotkey-item">
                <div className="hotkey-info">
                  <span className="hotkey-label">Rotate Project</span>
                  <span className="hotkey-description">Switch to the next project</span>
                </div>
                <input
                  type="text"
                  readOnly
                  className={`hotkey-recorder ${recordingHotkey === "project" ? "recording" : ""}`}
                  value={recordingHotkey === "project" ? "Press keys..." : formatHotkeyForDisplay(hotkeySettings.projectHotkey)}
                  onFocus={() => setRecordingHotkey("project")}
                  onBlur={() => setRecordingHotkey(null)}
                  onKeyDown={(e) => handleHotkeyRecord(e, "project")}
                />
              </div>
              <div className="hotkey-item">
                <div className="hotkey-info">
                  <span className="hotkey-label">Rotate Task</span>
                  <span className="hotkey-description">Switch to the next task</span>
                </div>
                <input
                  type="text"
                  readOnly
                  className={`hotkey-recorder ${recordingHotkey === "task" ? "recording" : ""}`}
                  value={recordingHotkey === "task" ? "Press keys..." : formatHotkeyForDisplay(hotkeySettings.taskHotkey)}
                  onFocus={() => setRecordingHotkey("task")}
                  onBlur={() => setRecordingHotkey(null)}
                  onKeyDown={(e) => handleHotkeyRecord(e, "task")}
                />
              </div>
              <div className="hotkey-item">
                <div className="hotkey-info">
                  <span className="hotkey-label">Stop Timer</span>
                  <span className="hotkey-description">Stop the current timer</span>
                </div>
                <input
                  type="text"
                  readOnly
                  className={`hotkey-recorder ${recordingHotkey === "stop" ? "recording" : ""}`}
                  value={recordingHotkey === "stop" ? "Press keys..." : formatHotkeyForDisplay(hotkeySettings.stopHotkey)}
                  onFocus={() => setRecordingHotkey("stop")}
                  onBlur={() => setRecordingHotkey(null)}
                  onKeyDown={(e) => handleHotkeyRecord(e, "stop")}
                />
              </div>
            </div>
            <button className="reset-hotkeys-btn" onClick={resetHotkeys}>
              Reset to Defaults
            </button>
          </div>
        </div>
      )}

      <footer className="toolbar">
        {currentView === "main" ? (
          <>
            <button className="toolbar-btn" onClick={() => setCurrentView("settings")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
              <span>Settings</span>
            </button>
            <button className="toolbar-btn" onClick={() => setCurrentView("donate")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
              </svg>
              <span>Support</span>
            </button>
          </>
        ) : (
          <button className="toolbar-btn" onClick={() => setCurrentView("main")}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
            <span>Back</span>
          </button>
        )}
      </footer>
    </div>
  );
}

export default App;
