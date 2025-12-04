import { useState, useEffect, useCallback, useRef } from "react";
import { usePostHog } from "posthog-js/react";
import { invoke } from "@tauri-apps/api/core";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { fetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import * as XLSX from "xlsx";
import "./App.css";

const API_BASE_URL = "https://the-ihor.com"; // swap to "http://localhost:3000" for local testing

const DEFAULT_HOTKEY_PROJECT = "CommandOrControl+Shift+P";
const DEFAULT_HOTKEY_TASK = "CommandOrControl+Shift+O";
const DEFAULT_HOTKEY_STOP = "CommandOrControl+Shift+I";

interface HotkeySettings {
  projectHotkey: string;
  taskHotkey: string;
  stopHotkey: string;
}

interface TrackingSettings {
  allowMultipleTasks: boolean;
}

interface Task {
  id: number;
  name: string;
  time_seconds: number;
  done_at: number | null;
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

interface TimeEntry {
  id: number;
  project_id: number;
  task_id: number;
  start_time: number;
  end_time: number;
  duration_seconds: number;
}

interface HourlyActivity {
  hour: number;
  total_seconds: number;
}

interface DailyActivity {
  date: string;
  total_seconds: number;
}

interface ProjectTimeStats {
  project_id: number;
  project_name: string;
  total_seconds: number;
}

interface TaskWithStatus {
  id: number;
  name: string;
  time_seconds: number;
  archived_at: number | null;
  done_at: number | null;
}

interface ProjectWithStatus {
  id: number;
  name: string;
  tasks: TaskWithStatus[];
  current_task_index: number;
  archived_at: number | null;
}

const formatTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
};

type View = "main" | "donate" | "settings" | "database";

interface AdData {
  url: string;
  imagePath: string;
}

const AD_WIDTH = 320;
const AD_HEIGHT = 50;

function App() {
  const posthog = usePostHog();
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProjectIndex, setCurrentProjectIndex] = useState(0);
  const [newProjectName, setNewProjectName] = useState("");
  const [newTaskNames, setNewTaskNames] = useState<Record<number, string>>({});
  const [_hotkeyRegistered, setHotkeyRegistered] = useState(false);
  const [activeTracking, setActiveTracking] = useState<ActiveTracking[]>([]);
  const [elapsedTimes, setElapsedTimes] = useState<Record<number, number>>({});
  const [trackingSettings, setTrackingSettings] = useState<TrackingSettings>(() => {
    const saved = localStorage.getItem("trackingSettings");
    return saved ? JSON.parse(saved) : { allowMultipleTasks: false };
  });
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
  const [editing, setEditing] = useState<{ type: "project" | "task"; id: number; value: string } | null>(null);
  const [hourlyActivity, setHourlyActivity] = useState<HourlyActivity[]>([]);
  const [dailyActivity, setDailyActivity] = useState<DailyActivity[]>([]);
  const [projectStats, setProjectStats] = useState<ProjectTimeStats[]>([]);
  const [allProjectsWithStatus, setAllProjectsWithStatus] = useState<ProjectWithStatus[]>([]);
  const [confirmModal, setConfirmModal] = useState<{
    title: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    onConfirm: () => void;
  } | null>(null);
  const [floatingTimerEnabled, setFloatingTimerEnabled] = useState(() => {
    const saved = localStorage.getItem("floatingTimerEnabled");
    return saved ? JSON.parse(saved) : false;
  });

  const loadData = useCallback(async () => {
    const loadedProjects = await invoke<Project[]>("get_projects");
    const index = await invoke<number>("get_current_project_index");
    const tracking = await invoke<ActiveTracking[]>("get_active_tracking");
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
          setProjects(loadedProjects);
          posthog.capture("project_rotated", { source: "hotkey" });
        }
      });
      await register(hotkeySettings.taskHotkey, async (event) => {
        if (event.state === "Pressed") {
          await invoke<Task | null>("rotate_task");
          const loadedProjects = await invoke<Project[]>("get_projects");
          setProjects(loadedProjects);
          posthog.capture("task_rotated", { source: "hotkey" });
        }
      });
      await register(hotkeySettings.stopHotkey, async (event) => {
        if (event.state === "Pressed") {
          const currentTracking = await invoke<ActiveTracking[]>("get_active_tracking");
          if (currentTracking.length > 0) {
            posthog.capture("timer_stopped", { source: "hotkey" });
            await invoke<number | null>("stop_tracking", { taskId: null });
            setActiveTracking([]);
            setElapsedTimes({});
            invoke("emit_tracking_updated").catch(console.error);
            const loadedProjects = await invoke<Project[]>("get_projects");
            setProjects(loadedProjects);
          } else {
            // Start tracking current task
            const loadedProjects = await invoke<Project[]>("get_projects");
            const currentIdx = await invoke<number>("get_current_project_index");
            const project = loadedProjects[currentIdx];
            if (project) {
              const activeTasks = project.tasks.filter(t => t.done_at === null);
              const currentTask = activeTasks.length > 0
                ? activeTasks[project.current_task_index % activeTasks.length]
                : null;
              if (currentTask) {
                const savedSettings = localStorage.getItem("trackingSettings");
                const settings = savedSettings ? JSON.parse(savedSettings) : { allowMultipleTasks: false };
                const tracking = await invoke<ActiveTracking[]>("start_tracking", {
                  projectId: project.id,
                  taskId: currentTask.id,
                  allowMultiple: settings.allowMultipleTasks,
                });
                setActiveTracking(tracking);
                if (tracking.length > 0) {
                  setElapsedTimes({});
                  posthog.capture("timer_started", { source: "hotkey" });
                  invoke("emit_tracking_updated").catch(console.error);
                }
              }
            }
            setProjects(loadedProjects);
          }
        }
      });
      setHotkeyRegistered(true);
    } catch (e) {
      console.error("Failed to register hotkeys:", e);
      setHotkeyRegistered(false);
    }
  }, [hotkeySettings, posthog]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (floatingTimerEnabled) {
      invoke("show_floating_timer").catch(console.error);

      // Poll for floating timer interactions (stop/open) regardless of active timers
      const pollInterval = setInterval(() => {
        invoke<number | null>("poll_floating_timer_stop").then(taskId => {
          if (taskId !== null) {
            // Immediately update floating timer (optimistic update for instant feedback)
            const now = Math.floor(Date.now() / 1000);
            const remainingEntries = activeTracking
              .filter(t => t.task_id !== taskId)
              .map(t => {
                const project = projects.find(p => p.id === t.project_id);
                const task = project?.tasks.find(task => task.id === t.task_id);
                return {
                  task_id: t.task_id,
                  project_name: project?.name || "",
                  task_name: task?.name || "",
                  elapsed_seconds: now - t.started_at,
                };
              });
            invoke("update_floating_timer", { entries: remainingEntries }).catch(console.error);

            // Run backend operations in parallel
            invoke("stop_tracking", { taskId }).then(() => {
              Promise.all([
                invoke<Project[]>("get_projects"),
                invoke<ActiveTracking[]>("get_active_tracking")
              ]).then(([newProjects, newTracking]) => {
                setProjects(newProjects);
                setActiveTracking(newTracking);
              });
            });
          }
        }).catch(console.error);
      }, 100); // Poll for stop requests

      return () => clearInterval(pollInterval);
    } else {
      invoke("hide_floating_timer").catch(console.error);
    }
  }, [floatingTimerEnabled, activeTracking, projects]);

  useEffect(() => {
    posthog.capture("$pageview", { view: currentView });
  }, [currentView, posthog]);

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
    if (activeTracking.length === 0) {
      setElapsedTimes({});
      if (floatingTimerEnabled) {
        invoke("update_floating_timer", { entries: [] }).catch(console.error);
      }
      return;
    }

    const updateTimer = () => {
      const now = Math.floor(Date.now() / 1000);
      const newElapsed: Record<number, number> = {};
      activeTracking.forEach(t => {
        newElapsed[t.task_id] = now - t.started_at;
      });
      setElapsedTimes(newElapsed);

      if (floatingTimerEnabled) {
        const entries = activeTracking.map(t => {
          const project = projects.find(p => p.id === t.project_id);
          const task = project?.tasks.find(task => task.id === t.task_id);
          return {
            task_id: t.task_id,
            project_name: project?.name || "",
            task_name: task?.name || "",
            elapsed_seconds: newElapsed[t.task_id] || 0,
          };
        });
        invoke("update_floating_timer", { entries }).catch(console.error);
      }
    };

    updateTimer();
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [activeTracking, floatingTimerEnabled, projects]);

  // Update system tray title
  useEffect(() => {
    const updateTray = async () => {
      let title = "";
      const truncateName = (name: string, maxLen = 20) =>
        name.length > maxLen ? name.slice(0, maxLen) + "…" : name;

      if (currentProject) {
        const activeTasks = currentProject.tasks.filter(t => t.done_at === null);
        const currentTask = activeTasks.length > 0
          ? activeTasks[currentProject.current_task_index % activeTasks.length]
          : null;

        if (activeTracking.length > 0) {
          // Show first active task in tray (most recent)
          const t = activeTracking[0];
          const project = projects.find(p => p.id === t.project_id);
          const task = project?.tasks.find(tk => tk.id === t.task_id);
          const taskName = task ? task.name : "";
          const projectName = project ? project.name : "";
          const elapsed = elapsedTimes[t.task_id] || 0;
          const suffix = activeTracking.length > 1 ? ` +${activeTracking.length - 1}` : "";
          title = `[${truncateName(projectName, 8)}] ${truncateName(taskName, 10)}${suffix} │ ${formatTime(elapsed)}`;
        } else if (currentTask) {
          title = `[${truncateName(currentProject.name, 10)}] ${truncateName(currentTask.name, 15)}`;
        } else {
          title = truncateName(currentProject.name, 25);
        }
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
  }, [activeTracking, elapsedTimes, currentProject, currentProjectIndex, projects.length, projects]);

  useEffect(() => {
    if (!adsEnabled) {
      setAdData(null);
      return;
    }

    const fetchAd = async () => {
      setAdLoading(true);
      try {
        const response = await fetch(`${API_BASE_URL}/api/ads/rotator`);
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

  // Handle iframe postMessage events
  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      // Validate origin
      if (!event.origin.includes("the-ihor.com") && !event.origin.includes("localhost")) {
        return;
      }

      const { source, type, url } = event.data || {};

      if (source !== "support-iframe") return;

      if (type === "openLink" && url) {
        await openUrl(url);
      }
      // 'copied' type - clipboard already handled by iframe
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

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
    posthog.capture("project_added");
  };

  const removeProject = async (projectId: number) => {
    const updated = await invoke<Project[]>("remove_project", { projectId });
    setProjects(updated);
    const newIndex = await invoke<number>("get_current_project_index");
    setCurrentProjectIndex(newIndex);
    const tracking = await invoke<ActiveTracking[]>("get_active_tracking");
    setActiveTracking(tracking);
    posthog.capture("project_archived");
  };

  const addTask = async (projectId: number) => {
    const taskName = newTaskNames[projectId] || "";
    if (!taskName.trim()) return;
    const updated = await invoke<Project | null>("add_task", { projectId, name: taskName.trim() });
    if (updated) {
      setProjects(projects.map(p => p.id === projectId ? updated : p));
    }
    setNewTaskNames(prev => ({ ...prev, [projectId]: "" }));
    posthog.capture("task_added");
  };

  const removeTask = async (projectId: number, taskId: number) => {
    const updated = await invoke<Project | null>("remove_task", { projectId, taskId });
    if (updated) {
      setProjects(projects.map(p => p.id === projectId ? updated : p));
    }
    const tracking = await invoke<ActiveTracking[]>("get_active_tracking");
    setActiveTracking(tracking);
    posthog.capture("task_archived");
  };

  const toggleTaskDone = async (projectId: number, taskId: number, done: boolean) => {
    const updated = await invoke<Project | null>("toggle_task_done", { projectId, taskId, done });
    if (updated) {
      setProjects(projects.map(p => p.id === projectId ? updated : p));
    }
    posthog.capture(done ? "task_completed" : "task_uncompleted");
  };

  const startTracking = async (projectId: number, taskId: number) => {
    const tracking = await invoke<ActiveTracking[]>("start_tracking", {
      projectId,
      taskId,
      allowMultiple: trackingSettings.allowMultipleTasks,
    });
    setActiveTracking(tracking);
    if (tracking.length > 0) {
      posthog.capture("timer_started");
      invoke("emit_tracking_updated").catch(console.error);
    }
  };

  const stopTracking = async (taskId?: number) => {
    const elapsed = taskId ? elapsedTimes[taskId] : Object.values(elapsedTimes).reduce((sum, t) => sum + t, 0);
    posthog.capture("timer_stopped", { duration_seconds: elapsed });
    await invoke<number | null>("stop_tracking", { taskId: taskId ?? null });
    if (taskId) {
      setActiveTracking(prev => prev.filter(t => t.task_id !== taskId));
      setElapsedTimes(prev => {
        const newTimes = { ...prev };
        delete newTimes[taskId];
        return newTimes;
      });
    } else {
      setActiveTracking([]);
      setElapsedTimes({});
    }
    invoke("emit_tracking_updated").catch(console.error);
    await loadData();
  };

  const rotateManually = async () => {
    if (projects.length === 0) return;
    const [index] = await invoke<[number, Project | null]>("rotate_project");
    setCurrentProjectIndex(index);
    posthog.capture("project_rotated");
  };

  const rotateTask = async () => {
    await invoke<Task | null>("rotate_task");
    const loadedProjects = await invoke<Project[]>("get_projects");
    setProjects(loadedProjects);
    posthog.capture("task_rotated");
  };

  const selectProject = async (index: number) => {
    await invoke<number>("set_current_project", { index });
    const loadedProjects = await invoke<Project[]>("get_projects");
    const currentIdx = await invoke<number>("get_current_project_index");
    setProjects(loadedProjects);
    setCurrentProjectIndex(currentIdx);
    posthog.capture("project_selected");
  };

  const getTaskTime = (task: Task): number => {
    const trackingEntry = activeTracking.find(t => t.task_id === task.id);
    if (trackingEntry) {
      return task.time_seconds + (elapsedTimes[task.id] || 0);
    }
    return task.time_seconds;
  };

  const isTaskTracking = (taskId: number): boolean => {
    return activeTracking.some(t => t.task_id === taskId);
  };

  const getProjectTotalTime = (project: Project): number =>
    project.tasks.reduce((sum, task) => sum + getTaskTime(task), 0);

  const toggleAds = () => {
    const newValue = !adsEnabled;
    setAdsEnabled(newValue);
    localStorage.setItem("adsEnabled", JSON.stringify(newValue));
    posthog.capture(newValue ? "ads_enabled" : "ads_disabled");
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

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditing(null);
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, []);

  const renameProject = async (projectId: number, newName: string) => {
    if (!newName.trim()) return;
    const updated = await invoke<Project[]>("rename_project", { projectId, newName: newName.trim() });
    setProjects(updated);
    setEditing(null);
  };

  const renameTask = async (projectId: number, taskId: number, newName: string) => {
    if (!newName.trim()) return;
    const updated = await invoke<Project | null>("rename_task", { projectId, taskId, newName: newName.trim() });
    if (updated) {
      setProjects(projects.map(p => p.id === projectId ? updated : p));
    }
    setEditing(null);
  };

  const restoreProject = async (projectId: number) => {
    const updated = await invoke<Project[]>("restore_project", { projectId });
    setProjects(updated);
    const allProjects = await invoke<ProjectWithStatus[]>("get_all_projects_with_status");
    setAllProjectsWithStatus(allProjects);
  };

  const restoreTask = async (projectId: number, taskId: number) => {
    const updated = await invoke<Project | null>("restore_task", { projectId, taskId });
    if (updated) {
      setProjects(projects.map(p => p.id === projectId ? updated : p));
    }
    const allProjects = await invoke<ProjectWithStatus[]>("get_all_projects_with_status");
    setAllProjectsWithStatus(allProjects);
  };

  const deleteTaskPermanent = async (taskId: number) => {
    await invoke<boolean>("delete_task_permanent", { taskId });
    const allProjects = await invoke<ProjectWithStatus[]>("get_all_projects_with_status");
    setAllProjectsWithStatus(allProjects);
  };

  const deleteProjectPermanent = async (projectId: number) => {
    await invoke<boolean>("delete_project_permanent", { projectId });
    const allProjects = await invoke<ProjectWithStatus[]>("get_all_projects_with_status");
    setAllProjectsWithStatus(allProjects);
  };

  const loadDatabaseData = useCallback(async () => {
    const now = Math.floor(Date.now() / 1000);
    const oneYearAgo = now - 365 * 86400;
    const [hourly, daily, stats, allProjects] = await Promise.all([
      invoke<HourlyActivity[]>("get_hourly_activity", { startTime: oneYearAgo, endTime: now }),
      invoke<DailyActivity[]>("get_daily_activity", { startTime: oneYearAgo, endTime: now }),
      invoke<ProjectTimeStats[]>("get_project_time_stats", { startTime: oneYearAgo, endTime: now }),
      invoke<ProjectWithStatus[]>("get_all_projects_with_status"),
    ]);
    setHourlyActivity(hourly);
    setDailyActivity(daily);
    setProjectStats(stats);
    setAllProjectsWithStatus(allProjects);
  }, []);

  useEffect(() => {
    if (currentView === "database") {
      loadDatabaseData();
    }
  }, [currentView, loadDatabaseData]);

  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState("");

  const exportToXlsx = async () => {
    setExporting(true);
    setExportMessage("");
    try {
      const allProjects = await invoke<Project[]>("get_projects");
      const entries = await invoke<TimeEntry[]>("get_all_time_entries");

      const projectsSheet = allProjects
        .filter(p => p.tasks.reduce((sum, t) => sum + t.time_seconds, 0) >= 3)
        .map(p => ({
          "Project ID": p.id,
          "Project Name": p.name,
          "Total Time (seconds)": p.tasks.reduce((sum, t) => sum + t.time_seconds, 0),
          "Total Time": formatTime(p.tasks.reduce((sum, t) => sum + t.time_seconds, 0)),
          "Task Count": p.tasks.filter(t => t.time_seconds >= 3).length,
        }));

      const tasksSheet = allProjects.flatMap(p =>
        p.tasks
          .filter(t => t.time_seconds >= 3)
          .map(t => ({
            "Task ID": t.id,
            "Task Name": t.name,
            "Project ID": p.id,
            "Project Name": p.name,
            "Time (seconds)": t.time_seconds,
            "Time": formatTime(t.time_seconds),
          }))
      );

      const entriesSheet = entries
        .filter(e => e.duration_seconds >= 3)
        .map(e => {
          const project = allProjects.find(p => p.id === e.project_id);
          const task = project?.tasks.find(t => t.id === e.task_id);
          return {
            "Entry ID": e.id,
            "Project": project?.name || "Unknown",
            "Task": task?.name || "Unknown",
            "Start": new Date(e.start_time * 1000).toLocaleString(),
            "End": new Date(e.end_time * 1000).toLocaleString(),
            "Duration (seconds)": e.duration_seconds,
            "Duration": formatTime(e.duration_seconds),
          };
        });

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(projectsSheet), "Projects");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tasksSheet), "Tasks");
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entriesSheet), "Time Entries");

      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([wbout], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rotator-export-${new Date().toISOString().split("T")[0]}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setExportMessage("Saved to Downloads folder");
      setTimeout(() => setExportMessage(""), 3000);
    } finally {
      setExporting(false);
    }
  };

  const formatHours = (seconds: number): string => {
    const hours = seconds / 3600;
    return hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(seconds / 60)}m`;
  };

  const getYearActivityByMonth = (): { month: string; label: string; days: { date: string; level: number }[] }[] => {
    const today = new Date();
    const oneYearAgo = new Date(today);
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const activityMap = new Map(dailyActivity.map(d => [d.date, d.total_seconds]));
    const maxSeconds = Math.max(...dailyActivity.map(d => d.total_seconds), 1);

    const months: Map<string, { label: string; days: { date: string; level: number }[] }> = new Map();
    const current = new Date(oneYearAgo);

    while (current <= today) {
      const dateStr = current.toISOString().split("T")[0];
      const monthKey = `${current.getFullYear()}-${current.getMonth()}`;
      const monthLabel = current.toLocaleDateString("en-US", { month: "short" });
      const seconds = activityMap.get(dateStr) || 0;
      const level = seconds === 0 ? 0 : Math.min(4, Math.ceil((seconds / maxSeconds) * 4));

      if (!months.has(monthKey)) months.set(monthKey, { label: monthLabel, days: [] });
      months.get(monthKey)!.days.push({ date: dateStr, level });
      current.setDate(current.getDate() + 1);
    }

    return Array.from(months.entries()).map(([month, data]) => ({ month, label: data.label, days: data.days }));
  };

  const getHourlyChartData = () => {
    const allHours = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      label: `${i.toString().padStart(2, "0")}:00`,
      total_seconds: 0,
    }));

    hourlyActivity.forEach(h => {
      if (h.hour >= 0 && h.hour < 24) {
        allHours[h.hour].total_seconds = h.total_seconds;
      }
    });

    return allHours;
  };

  return (
    <div className="app">
      {currentView === "main" ? (
        <>
          {adsEnabled && (
            <div className="main-ad-banner">
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
                  onClick={(e) => {
                    e.preventDefault();
                    openUrl(adData.url);
                  }}
                >
                  <img
                    src={getAdImageUrl(adData.imagePath)}
                    alt="Advertisement"
                    className="ad-banner-image"
                    width={AD_WIDTH}
                    height={AD_HEIGHT}
                  />
                </a>
              ) : null}
            </div>
          )}
          {currentProject && (
            <div className="current-section" onClick={rotateManually}>
              <span className="hotkey-badge">{formatHotkeyShort(hotkeySettings.projectHotkey)}</span>
              <div className="current-label">Current Project</div>
              <div className="current-value">{currentProject.name}</div>
              <div className="current-indicator">
                {formatTime(getProjectTotalTime(currentProject))}
              </div>
            </div>
          )}

          {currentProject && currentProject.tasks.length > 0 && (() => {
            const activeTasks = currentProject.tasks.filter(t => t.done_at === null);
            const currentTask = activeTasks.length > 0
              ? activeTasks[currentProject.current_task_index % activeTasks.length]
              : null;
            if (!currentTask) return null;
            const isCurrentTaskTracking = isTaskTracking(currentTask.id);
            const totalActiveCount = activeTracking.length;
            return (
              <>
                <div className="current-section task-section" onClick={rotateTask}>
                  <span className="hotkey-badge">{formatHotkeyShort(hotkeySettings.taskHotkey)}</span>
                  <div className="current-label">Current Task</div>
                  <div className="current-value">{currentTask.name}</div>
                  <div className="current-indicator">
                    {formatTime(currentTask.time_seconds)}
                  </div>
                </div>
                <div className="tracking-controls">
                  <button
                    className={`track-btn large ${isCurrentTaskTracking ? "stop" : "start"}`}
                    onClick={() => isCurrentTaskTracking ? stopTracking(currentTask.id) : startTracking(currentProject.id, currentTask.id)}
                  >
                    {isCurrentTaskTracking ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                        <polygon points="5 3 19 12 5 21 5 3"></polygon>
                      </svg>
                    )}
                  </button>
                  <span className="session-time">
                    {isCurrentTaskTracking
                      ? formatTime(elapsedTimes[currentTask.id] || 0)
                      : "00:00:00"}
                  </span>
                  <span className="hotkey-badge stop-hotkey">{formatHotkeyShort(hotkeySettings.stopHotkey)}</span>
                </div>
                {totalActiveCount > 0 && (
                  <div className="active-tracking-list">
                    {activeTracking.map(t => {
                      const project = projects.find(p => p.id === t.project_id);
                      const task = project?.tasks.find(tk => tk.id === t.task_id);
                      if (!task) return null;
                      return (
                        <div key={t.task_id} className="active-tracking-item">
                          <div className="active-tracking-info">
                            <span className="active-tracking-project">{project?.name}</span>
                            <span className="active-tracking-task">{task.name}</span>
                          </div>
                          <span className="active-tracking-time">{formatTime(elapsedTimes[t.task_id] || 0)}</span>
                          <button
                            className="track-btn stop small"
                            onClick={() => stopTracking(t.task_id)}
                          >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                              <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                    {totalActiveCount > 1 && (
                      <button
                        className="stop-all-btn"
                        onClick={() => stopTracking()}
                      >
                        Stop All ({totalActiveCount})
                      </button>
                    )}
                  </div>
                )}
              </>
            );
          })()}

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
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <button className="dots-btn" onClick={(e) => e.stopPropagation()}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="12" cy="5" r="2"></circle>
                          <circle cx="12" cy="12" r="2"></circle>
                          <circle cx="12" cy="19" r="2"></circle>
                        </svg>
                      </button>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content className="dropdown-content" sideOffset={5} align="start">
                        <DropdownMenu.Item
                          className="dropdown-item"
                          onSelect={() => setEditing({ type: "project", id: project.id, value: project.name })}
                        >
                          Edit
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          className="dropdown-item danger"
                          onSelect={() => removeProject(project.id)}
                        >
                          Archive
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                  {editing?.type === "project" && editing.id === project.id ? (
                    <input
                      className="inline-edit-input"
                      value={editing.value}
                      onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") renameProject(project.id, editing.value);
                        if (e.key === "Escape") setEditing(null);
                      }}
                      onBlur={() => renameProject(project.id, editing.value)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <span className="project-name">{project.name}</span>
                  )}
                  <span className="project-time">{formatTime(getProjectTotalTime(project))}</span>
                </div>

                <div className="tasks-section">
                    <div className="inline-add-form task-inline-add">
                      <span className="inline-add-icon">+</span>
                      <input
                        type="text"
                        value={newTaskNames[project.id] || ""}
                        onChange={(e) => setNewTaskNames(prev => ({ ...prev, [project.id]: e.target.value }))}
                        placeholder="Add task..."
                        className="inline-add-input"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addTask(project.id);
                          }
                        }}
                        onBlur={() => {
                          if ((newTaskNames[project.id] || "").trim()) {
                            addTask(project.id);
                          }
                        }}
                      />
                    </div>

                    {project.tasks.length === 0 ? (
                      <div className="no-tasks">No tasks yet</div>
                    ) : (
                      <ul className="tasks-list">
                        {(() => {
                          const activeTasks = project.tasks.filter(t => t.done_at === null);
                          const currentTaskId = activeTasks.length > 0
                            ? activeTasks[project.current_task_index % activeTasks.length]?.id
                            : null;
                          return [...project.tasks].sort((a, b) => {
                            const aDone = a.done_at !== null ? 1 : 0;
                            const bDone = b.done_at !== null ? 1 : 0;
                            return aDone - bDone;
                          }).map((task) => {
                            const isTracking = isTaskTracking(task.id);
                            const isDone = task.done_at !== null;
                            const isSelected = task.id === currentTaskId && index === currentProjectIndex;
                            return (
                              <li key={task.id} className={`task-item ${isTracking ? "tracking" : ""} ${isDone ? "done" : ""} ${isSelected ? "selected" : ""}`}>
                              <button
                                className={`done-checkbox ${isDone ? "checked" : ""}`}
                                onClick={() => toggleTaskDone(project.id, task.id, !isDone)}
                              >
                                {isDone && (
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                                    <polyline points="20 6 9 17 4 12"></polyline>
                                  </svg>
                                )}
                              </button>
                              <DropdownMenu.Root>
                                <DropdownMenu.Trigger asChild>
                                  <button className="dots-btn small">
                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                                      <circle cx="12" cy="5" r="2"></circle>
                                      <circle cx="12" cy="12" r="2"></circle>
                                      <circle cx="12" cy="19" r="2"></circle>
                                    </svg>
                                  </button>
                                </DropdownMenu.Trigger>
                                <DropdownMenu.Portal>
                                  <DropdownMenu.Content className="dropdown-content" sideOffset={5} align="start">
                                    <DropdownMenu.Item
                                      className="dropdown-item"
                                      onSelect={() => setEditing({ type: "task", id: task.id, value: task.name })}
                                    >
                                      Edit
                                    </DropdownMenu.Item>
                                    <DropdownMenu.Item
                                      className="dropdown-item danger"
                                      onSelect={() => removeTask(project.id, task.id)}
                                    >
                                      Archive
                                    </DropdownMenu.Item>
                                  </DropdownMenu.Content>
                                </DropdownMenu.Portal>
                              </DropdownMenu.Root>
                              {editing?.type === "task" && editing.id === task.id ? (
                                <input
                                  className="inline-edit-input small"
                                  value={editing.value}
                                  onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") renameTask(project.id, task.id, editing.value);
                                    if (e.key === "Escape") setEditing(null);
                                  }}
                                  onBlur={() => renameTask(project.id, task.id, editing.value)}
                                  autoFocus
                                />
                              ) : (
                                <span className="task-name">{task.name}</span>
                              )}
                              <span className="task-time">{formatTime(getTaskTime(task))}</span>
                              <button
                                className={`track-btn ${isTracking ? "stop" : "start"}`}
                                onClick={() => isTracking ? stopTracking(task.id) : startTracking(project.id, task.id)}
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
                            </li>
                            );
                          });
                        })()}
                      </ul>
                    )}
                  </div>
              </li>
            ))}
          </ul>
        )}
      </div>

          <footer className="footer">
            <span>{formatHotkeyShort(hotkeySettings.projectHotkey)} project • {formatHotkeyShort(hotkeySettings.taskHotkey)} task • {formatHotkeyShort(hotkeySettings.stopHotkey)} toggle</span>
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
                src={`${API_BASE_URL}/iframe/support`}
                title="Donate"
                className="donate-iframe"
              />
            </div>
          </div>

          <div className="donate-section sale-section">
            <h2>For Sale</h2>
            <p className="donate-description">
              The app is on sale in a bidding format starting from $10,000.
              <br />
              <a href="mailto:contact@the-ihor.com" className="sale-contact">Get in touch</a> to make a bid.
            </p>
          </div>
        </div>
      ) : currentView === "settings" ? (
        <div className="settings-view">
          <div className="settings-section">
            <h2>Tracking</h2>
            <p className="settings-description">
              Configure how task tracking works.
            </p>
            <div className="tracking-toggle-container">
              <div className="tracking-toggle-info">
                <span className="tracking-toggle-label">Allow Multiple Tasks</span>
                <span className="tracking-toggle-description">Track multiple tasks simultaneously</span>
              </div>
              <button
                className={`ads-toggle ${trackingSettings.allowMultipleTasks ? "enabled" : ""}`}
                onClick={() => {
                  const newSettings = { ...trackingSettings, allowMultipleTasks: !trackingSettings.allowMultipleTasks };
                  setTrackingSettings(newSettings);
                  localStorage.setItem("trackingSettings", JSON.stringify(newSettings));
                  posthog.capture(newSettings.allowMultipleTasks ? "multi_task_enabled" : "multi_task_disabled");
                }}
              >
                <span className="toggle-track">
                  <span className="toggle-thumb"></span>
                </span>
                <span className="toggle-label">{trackingSettings.allowMultipleTasks ? "Enabled" : "Disabled"}</span>
              </button>
            </div>
            <div className="tracking-toggle-container">
              <div className="tracking-toggle-info">
                <span className="tracking-toggle-label">Floating Timer</span>
                <span className="tracking-toggle-description">Show always-on-top timer widget</span>
              </div>
              <button
                className={`ads-toggle ${floatingTimerEnabled ? "enabled" : ""}`}
                onClick={() => {
                  const newValue = !floatingTimerEnabled;
                  setFloatingTimerEnabled(newValue);
                  localStorage.setItem("floatingTimerEnabled", JSON.stringify(newValue));
                  posthog.capture(newValue ? "floating_timer_enabled" : "floating_timer_disabled");
                }}
              >
                <span className="toggle-track">
                  <span className="toggle-thumb"></span>
                </span>
                <span className="toggle-label">{floatingTimerEnabled ? "Enabled" : "Disabled"}</span>
              </button>
            </div>
          </div>
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
                  <span className="hotkey-label">Toggle Timer</span>
                  <span className="hotkey-description">Start or stop the current timer</span>
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
          <div className="settings-section">
            <h2>Database</h2>
            <p className="settings-description">
              Manage your database. Warning: These actions cannot be undone.
            </p>
            <div className="database-actions">
              <button
                className="danger-btn"
                onClick={() => {
                  setConfirmModal({
                    title: "Reset Database",
                    message: "Are you sure you want to reset the database? All projects, tasks, and time entries will be permanently deleted.",
                    confirmText: "Reset",
                    danger: true,
                    onConfirm: async () => {
                      try {
                        const newProjects = await invoke<Project[]>("reset_database");
                        setProjects(newProjects);
                        setActiveTracking([]);
                        setElapsedTimes({});
                        setCurrentView("main");
                      } catch (e) {
                        console.error("Reset database error:", e);
                      }
                    },
                  });
                }}
              >
                Reset Database
              </button>
              <button
                className="secondary-btn"
                onClick={async () => {
                  try {
                    const newProjects = await invoke<Project[]>("add_mock_data");
                    setProjects(newProjects);
                    setCurrentView("main");
                  } catch (e) {
                    console.error("Add mock data error:", e);
                    alert("Failed to add mock data: " + e);
                  }
                }}
              >
                Add Mock Data
              </button>
            </div>
          </div>
        </div>
      ) : currentView === "database" ? (
        <div className="database-view">
          <div className="db-header">
            <h2>Database</h2>
            <div className="export-container">
              <button className="export-btn" onClick={exportToXlsx} disabled={exporting}>
                {exporting ? (
                  <>Exporting...</>
                ) : (
                  <>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="7 10 12 15 17 10"></polyline>
                      <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    Export
                  </>
                )}
              </button>
              {exportMessage && <span className="export-message">{exportMessage}</span>}
            </div>
          </div>

          <div className="db-section">
            <h3>Activity by Hour</h3>
            <div className="chart-container">
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={getHourlyChartData()} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                    tickLine={false}
                    axisLine={false}
                    interval={2}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(v) => formatHours(v)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "var(--bg-secondary)",
                      border: "1px solid var(--border-color)",
                      borderRadius: "6px",
                      fontSize: "12px",
                    }}
                    formatter={(value: number) => [formatHours(value), "Time"]}
                    labelFormatter={(label) => `${label}`}
                  />
                  <Bar dataKey="total_seconds" radius={[4, 4, 0, 0]}>
                    {getHourlyChartData().map((_, index) => (
                      <Cell key={index} fill="var(--accent)" />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="db-section">
            <h3>Time by Project</h3>
            {projectStats.length === 0 ? (
              <div className="no-data">No project data for this period</div>
            ) : (
              <div className="chart-container">
                <ResponsiveContainer width="100%" height={Math.max(150, projectStats.length * 40)}>
                  <BarChart
                    data={projectStats}
                    layout="vertical"
                    margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  >
                    <XAxis
                      type="number"
                      tick={{ fontSize: 10, fill: "var(--text-muted)" }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v) => formatHours(v)}
                    />
                    <YAxis
                      type="category"
                      dataKey="project_name"
                      tick={{ fontSize: 11, fill: "var(--text-primary)" }}
                      tickLine={false}
                      axisLine={false}
                      width={100}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--bg-secondary)",
                        border: "1px solid var(--border-color)",
                        borderRadius: "6px",
                        fontSize: "12px",
                      }}
                      formatter={(value: number) => [formatHours(value), "Time"]}
                    />
                    <Bar dataKey="total_seconds" radius={[0, 4, 4, 0]}>
                      {projectStats.map((_, index) => (
                        <Cell key={index} fill={`hsl(${(index * 45 + 230) % 360}, 70%, 60%)`} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>

          <div className="db-section">
            <h3>Year Activity</h3>
            <div className="activity-months">
              {getYearActivityByMonth().map(({ month, label, days }) => (
                <div key={month} className="activity-month">
                  <div className="activity-month-label">{label}</div>
                  <div className="activity-month-grid">
                    {days.map((day, idx) => (
                      <div
                        key={idx}
                        className={`activity-cell level-${day.level}`}
                        title={`${day.date}`}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="activity-legend">
              <span>Less</span>
              {[0, 1, 2, 3, 4].map(level => (
                <div key={level} className={`activity-cell level-${level}`} />
              ))}
              <span>More</span>
            </div>
          </div>

          <div className="db-section">
            <h3>All Projects & Tasks</h3>
            {allProjectsWithStatus.length === 0 ? (
              <div className="no-data">No projects yet</div>
            ) : (
              <div className="all-projects-list">
                {allProjectsWithStatus.map(project => {
                  const isProjectArchived = project.archived_at !== null;
                  return (
                    <div key={project.id} className={`db-project ${isProjectArchived ? "archived" : ""}`}>
                      <div className="db-project-header">
                        <div className="db-project-info">
                          <span className="db-project-name">{project.name}</span>
                          {isProjectArchived && <span className="status-badge archived">Archived</span>}
                          <span className="db-project-time">{formatTime(project.tasks.reduce((sum, t) => sum + t.time_seconds, 0))}</span>
                        </div>
                        {isProjectArchived && (
                          <div className="db-project-actions">
                            <button className="restore-btn" onClick={() => restoreProject(project.id)}>
                              Restore
                            </button>
                            <button className="delete-btn" onClick={() => deleteProjectPermanent(project.id)}>
                              Delete
                            </button>
                          </div>
                        )}
                      </div>
                      {project.tasks.length > 0 && (
                        <div className="db-tasks">
                          {project.tasks.map(task => {
                            const isTaskArchived = task.archived_at !== null;
                            return (
                              <div key={task.id} className={`db-task ${isTaskArchived ? "archived" : ""}`}>
                                <div className="db-task-info">
                                  <span className="db-task-name">{task.name}</span>
                                  {isTaskArchived && <span className="status-badge archived small">Archived</span>}
                                  <span className="db-task-time">{formatTime(task.time_seconds)}</span>
                                </div>
                                {isTaskArchived && (
                                  <div className="db-task-actions">
                                    <button className="restore-btn small" onClick={() => restoreTask(project.id, task.id)}>
                                      Restore
                                    </button>
                                    <button className="delete-btn small" onClick={() => deleteTaskPermanent(task.id)}>
                                      Delete
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

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
            <button className="toolbar-btn" onClick={() => setCurrentView("database")}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
              </svg>
              <span>Database</span>
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

      {confirmModal && (
        <div className="modal-overlay" onClick={() => setConfirmModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">{confirmModal.title}</h3>
            <p className="modal-message">{confirmModal.message}</p>
            <div className="modal-actions">
              <button
                className="modal-btn modal-btn-cancel"
                onClick={() => setConfirmModal(null)}
              >
                {confirmModal.cancelText || "Cancel"}
              </button>
              <button
                className={`modal-btn ${confirmModal.danger ? "modal-btn-danger" : "modal-btn-confirm"}`}
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
              >
                {confirmModal.confirmText || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
