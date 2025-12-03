import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./App.css";

const HOTKEY_PROJECT = "CommandOrControl+Shift+P";
const HOTKEY_TASK = "CommandOrControl+Shift+O";

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

interface HeaderIndicatorSettings {
  showProjectIndex: boolean;
  showTrackingStatus: boolean;
  showTotalTime: boolean;
  showProjectName: boolean;
}

const defaultIndicatorSettings: HeaderIndicatorSettings = {
  showProjectIndex: true,
  showTrackingStatus: true,
  showTotalTime: false,
  showProjectName: false,
};

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
  const [hotkeyRegistered, setHotkeyRegistered] = useState(false);
  const [activeTracking, setActiveTracking] = useState<ActiveTracking | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [currentView, setCurrentView] = useState<View>("main");
  const [adsEnabled, setAdsEnabled] = useState(() => {
    const saved = localStorage.getItem("adsEnabled");
    return saved ? JSON.parse(saved) : false;
  });
  const [adData, setAdData] = useState<AdData | null>(null);
  const [adLoading, setAdLoading] = useState(false);
  const [indicatorSettings, setIndicatorSettings] = useState<HeaderIndicatorSettings>(() => {
    const saved = localStorage.getItem("indicatorSettings");
    return saved ? { ...defaultIndicatorSettings, ...JSON.parse(saved) } : defaultIndicatorSettings;
  });

  const currentProject = projects[currentProjectIndex] || null;

  const loadData = useCallback(async () => {
    const loadedProjects = await invoke<Project[]>("get_projects");
    const index = await invoke<number>("get_current_project_index");
    const tracking = await invoke<ActiveTracking | null>("get_active_tracking");
    setProjects(loadedProjects);
    setCurrentProjectIndex(index);
    setActiveTracking(tracking);
    if (loadedProjects.length > 0 && expandedProjectId === null) {
      setExpandedProjectId(loadedProjects[index]?.id ?? null);
    }
  }, [expandedProjectId]);

  const registerHotkeys = useCallback(async () => {
    try {
      await register(HOTKEY_PROJECT, async (event) => {
        if (event.state === "Pressed") {
          const [index] = await invoke<[number, Project | null]>("rotate_project");
          setCurrentProjectIndex(index);
          const loadedProjects = await invoke<Project[]>("get_projects");
          const project = loadedProjects[index];
          if (project) {
            setExpandedProjectId(project.id);
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
      await register(HOTKEY_TASK, async (event) => {
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
      setHotkeyRegistered(true);
    } catch (e) {
      console.error("Failed to register hotkeys:", e);
      setHotkeyRegistered(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    registerHotkeys();
    return () => {
      unregister(HOTKEY_PROJECT).catch(console.error);
      unregister(HOTKEY_TASK).catch(console.error);
    };
  }, [loadData, registerHotkeys]);

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
    if (updated.length === 1) {
      setExpandedProjectId(updated[0].id);
    }
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
    if (projects[index]) {
      setExpandedProjectId(projects[index].id);
    }
  };

  const selectProject = async (index: number) => {
    await invoke<number>("set_current_project", { index });
    setCurrentProjectIndex(index);
    setExpandedProjectId(projects[index].id);
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

  const toggleIndicator = (key: keyof HeaderIndicatorSettings) => {
    const newSettings = { ...indicatorSettings, [key]: !indicatorSettings[key] };
    setIndicatorSettings(newSettings);
    localStorage.setItem("indicatorSettings", JSON.stringify(newSettings));
  };

  const getTotalTimeToday = (): number => {
    const totalBase = projects.reduce((sum, project) =>
      sum + project.tasks.reduce((taskSum, task) => taskSum + task.time_seconds, 0), 0);
    return activeTracking ? totalBase + elapsedTime : totalBase;
  };

  return (
    <div className="app">
      <header className="header">
        <h1>{currentView === "main" ? "Project Rotator" : currentView === "donate" ? "Support Us" : "Settings"}</h1>
        <div className="header-actions">
          {currentView === "main" ? (
            <>
              <div className="header-indicators">
                {indicatorSettings.showTrackingStatus && (
                  <div className={`header-indicator tracking-indicator ${activeTracking ? "active" : ""}`}>
                    <span className="indicator-dot"></span>
                    <span>{activeTracking ? "Tracking" : "Idle"}</span>
                  </div>
                )}
                {activeTracking && (
                  <div className="header-indicator session-timer">
                    <span>{formatTime(elapsedTime)}</span>
                  </div>
                )}
                {indicatorSettings.showProjectIndex && projects.length > 0 && (
                  <div className="header-indicator">
                    <span>{currentProjectIndex + 1}/{projects.length}</span>
                  </div>
                )}
                {indicatorSettings.showTotalTime && (
                  <div className="header-indicator">
                    <span>{formatTime(getTotalTimeToday())}</span>
                  </div>
                )}
                {indicatorSettings.showProjectName && currentProject && (
                  <div className="header-indicator project-name-indicator">
                    <span>{currentProject.name}</span>
                  </div>
                )}
              </div>
              <button className="nav-btn settings-btn" onClick={() => setCurrentView("settings")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3"></circle>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
              </button>
              <button className="nav-btn donate-btn" onClick={() => setCurrentView("donate")}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
                </svg>
              </button>
              <div className={`hotkey-badge ${hotkeyRegistered ? "active" : "inactive"}`}>
                <kbd>⌘⇧P/O</kbd>
                <span>{hotkeyRegistered ? "Active" : "Inactive"}</span>
              </div>
            </>
          ) : (
            <button className="nav-btn back-btn" onClick={() => setCurrentView("main")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="15 18 9 12 15 6"></polyline>
              </svg>
              Back
            </button>
          )}
        </div>
      </header>

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

          <form onSubmit={addProject} className="add-form">
            <input
              type="text"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              placeholder="Add new project..."
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
                    className="expand-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpandedProjectId(expandedProjectId === project.id ? null : project.id);
                    }}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      style={{ transform: expandedProjectId === project.id ? "rotate(180deg)" : "rotate(0)" }}
                    >
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </button>
                  <button
                    className="remove-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeProject(project.id);
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                  </button>
                </div>

                {expandedProjectId === project.id && (
                  <div className="tasks-section">
                    <div className="add-task-form">
                      <input
                        type="text"
                        value={newTaskName}
                        onChange={(e) => setNewTaskName(e.target.value)}
                        placeholder="Add task..."
                        className="task-input"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addTask(project.id);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="add-task-btn"
                        onClick={() => addTask(project.id)}
                      >
                        +
                      </button>
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
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
            <span>⌘⇧P rotate project • ⌘⇧O rotate task</span>
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
            <h2>Header Indicators</h2>
            <p className="settings-description">
              Choose which indicators to display in the header bar.
            </p>
            <div className="settings-options">
              <button
                className={`settings-toggle ${indicatorSettings.showTrackingStatus ? "enabled" : ""}`}
                onClick={() => toggleIndicator("showTrackingStatus")}
              >
                <span className="toggle-track">
                  <span className="toggle-thumb"></span>
                </span>
                <span className="toggle-label">Tracking Status</span>
                <span className="toggle-description">Show active/idle tracking indicator</span>
              </button>

              <button
                className={`settings-toggle ${indicatorSettings.showProjectIndex ? "enabled" : ""}`}
                onClick={() => toggleIndicator("showProjectIndex")}
              >
                <span className="toggle-track">
                  <span className="toggle-thumb"></span>
                </span>
                <span className="toggle-label">Project Index</span>
                <span className="toggle-description">Show current project position (1/5)</span>
              </button>

              <button
                className={`settings-toggle ${indicatorSettings.showTotalTime ? "enabled" : ""}`}
                onClick={() => toggleIndicator("showTotalTime")}
              >
                <span className="toggle-track">
                  <span className="toggle-thumb"></span>
                </span>
                <span className="toggle-label">Total Time</span>
                <span className="toggle-description">Show total tracked time across all projects</span>
              </button>

              <button
                className={`settings-toggle ${indicatorSettings.showProjectName ? "enabled" : ""}`}
                onClick={() => toggleIndicator("showProjectName")}
              >
                <span className="toggle-track">
                  <span className="toggle-thumb"></span>
                </span>
                <span className="toggle-label">Project Name</span>
                <span className="toggle-description">Show current project name in header</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
