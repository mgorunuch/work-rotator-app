import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import "./App.css";

const HOTKEY = "CommandOrControl+Shift+P";

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

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectIndex, setCurrentProjectIndex] = useState(0);
  const [newProjectName, setNewProjectName] = useState("");
  const [newTaskName, setNewTaskName] = useState("");
  const [hotkeyRegistered, setHotkeyRegistered] = useState(false);
  const [activeTracking, setActiveTracking] = useState<ActiveTracking | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);

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

  const registerHotkey = useCallback(async () => {
    try {
      await register(HOTKEY, async (event) => {
        if (event.state === "Pressed") {
          const [index] = await invoke<[number, Project | null]>("rotate_project");
          setCurrentProjectIndex(index);
          const loadedProjects = await invoke<Project[]>("get_projects");
          if (loadedProjects[index]) {
            setExpandedProjectId(loadedProjects[index].id);
          }
        }
      });
      setHotkeyRegistered(true);
    } catch (e) {
      console.error("Failed to register hotkey:", e);
      setHotkeyRegistered(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    registerHotkey();
    return () => {
      unregister(HOTKEY).catch(console.error);
    };
  }, [loadData, registerHotkey]);

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

  return (
    <div className="app">
      <header className="header">
        <h1>Project Rotator</h1>
        <div className={`hotkey-badge ${hotkeyRegistered ? "active" : "inactive"}`}>
          <kbd>{HOTKEY.replace("CommandOrControl", "⌘")}</kbd>
          <span>{hotkeyRegistered ? "Active" : "Inactive"}</span>
        </div>
      </header>

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
        <span>Click project or press {HOTKEY.replace("CommandOrControl", "⌘")} to rotate</span>
      </footer>
    </div>
  );
}

export default App;
