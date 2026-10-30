import { useSyncExternalStore } from "react";

export type ImportTaskType =
  | "local_files"
  | "provider_track"
  | "provider_batch"
  | "cached_track"
  | "playlist_load";

export type ImportTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface ImportTaskItemInfo {
  key: string;
  title: string;
  stage?: string;
  percent?: number;
  status: "pending" | "running" | "completed" | "failed";
  error?: string;
}

export interface ImportTaskGroup {
  id: string;
  type: ImportTaskType;
  title: string;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  currentTitle?: string;
  currentStage?: string;
  currentStagePercent?: number; // 0 - 100
  overallPercent: number; // 0 - 100
  status: ImportTaskStatus;
  error?: string;
  itemKeys: string[];
  startedAt: number;
  finishedAt?: number;
}

export interface ItemImportStatus {
  isImporting: boolean;
  title?: string;
  stage?: string;
  percent?: number;
  status?: "pending" | "running" | "completed" | "failed";
}

type TaskListener = () => void;

const IDLE_ITEM_STATUS: ItemImportStatus = Object.freeze({ isImporting: false });

class ImportTaskStore {
  private tasks = new Map<string, ImportTaskGroup>();
  private itemKeyIndex = new Map<string, ImportTaskItemInfo>();
  private abortControllers = new Map<string, AbortController>();
  private listeners = new Set<TaskListener>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private visibleSnapshot: ImportTaskGroup[] = [];
  private itemStatusCache = new Map<string, ItemImportStatus>();

  // Cooldown time before a completed/failed task is removed from active tasks
  private readonly finishCooldownMs = 2500;

  private notify() {
    this.visibleSnapshot = Array.from(this.tasks.values());
    this.itemStatusCache.clear();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Ignore listener error
      }
    }
  }

  public subscribe = (listener: TaskListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  public getTasks(): ImportTaskGroup[] {
    return this.visibleSnapshot;
  }

  public getActiveTasks(): ImportTaskGroup[] {
    return this.visibleSnapshot.filter((t) => t.status === "running");
  }

  public getVisibleTasks(): ImportTaskGroup[] {
    return this.visibleSnapshot;
  }

  public getVisibleSnapshot = (): ImportTaskGroup[] => {
    return this.visibleSnapshot;
  };

  public getItemStatus = (itemKey: string | null | undefined): ItemImportStatus => {
    if (!itemKey) return IDLE_ITEM_STATUS;
    const cached = this.itemStatusCache.get(itemKey);
    if (cached) return cached;

    const item = this.itemKeyIndex.get(itemKey);
    const status: ItemImportStatus = item
      ? {
          isImporting: item.status === "pending" || item.status === "running",
          title: item.title,
          stage: item.stage,
          percent: item.percent,
          status: item.status
        }
      : IDLE_ITEM_STATUS;

    this.itemStatusCache.set(itemKey, status);
    return status;
  };

  public isItemImporting = (itemKey: string | null | undefined): boolean => {
    if (!itemKey) return false;
    const item = this.itemKeyIndex.get(itemKey);
    return item ? item.status === "pending" || item.status === "running" : false;
  };

  public areAnyItemsImporting = (itemKeys: readonly string[]): boolean => {
    for (const key of itemKeys) {
      if (this.isItemImporting(key)) return true;
    }
    return false;
  };

  public startTask(input: {
    id?: string;
    type: ImportTaskType;
    title: string;
    totalCount: number;
    itemKeys?: string[];
    currentTitle?: string;
    currentStage?: string;
    signal?: AbortSignal;
  }): string {
    const id = input.id ?? `import_task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const totalCount = Math.max(1, input.totalCount);
    const itemKeys = input.itemKeys ?? [];

    const existingTimer = this.cleanupTimers.get(id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.cleanupTimers.delete(id);
    }

    const controller = new AbortController();
    if (input.signal) {
      if (input.signal.aborted) {
        controller.abort(input.signal.reason);
      } else {
        input.signal.addEventListener("abort", () => controller.abort(input.signal?.reason), { once: true });
      }
    }
    this.abortControllers.set(id, controller);

    const task: ImportTaskGroup = {
      id,
      type: input.type,
      title: input.title,
      totalCount,
      completedCount: 0,
      failedCount: 0,
      currentTitle: input.currentTitle,
      currentStage: input.currentStage,
      currentStagePercent: 0,
      overallPercent: 0,
      status: "running",
      itemKeys,
      startedAt: Date.now()
    };

    this.tasks.set(id, task);

    // Register items in the index
    for (const key of itemKeys) {
      this.itemKeyIndex.set(key, {
        key,
        title: input.currentTitle ?? input.title,
        status: "pending"
      });
    }

    this.notify();
    return id;
  }

  public updateTaskProgress(
    taskId: string,
    update: {
      currentTitle?: string;
      currentStage?: string;
      currentStagePercent?: number;
      completedCount?: number;
      failedCount?: number;
      activeItemKey?: string;
      activeItemAliasKeys?: string[];
    }
  ) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return;

    const currentTitle = update.currentTitle !== undefined ? update.currentTitle : task.currentTitle;
    const currentStage = update.currentStage !== undefined ? update.currentStage : task.currentStage;
    const currentStagePercent = update.currentStagePercent !== undefined
      ? Math.min(100, Math.max(0, Math.round(update.currentStagePercent)))
      : (task.currentStagePercent ?? 0);
    const completedCount = update.completedCount !== undefined ? update.completedCount : task.completedCount;
    const failedCount = update.failedCount !== undefined ? update.failedCount : task.failedCount;

    // Recalculate overall percentage
    const stagePortion = currentStagePercent / 100;
    const progressCount = completedCount + stagePortion;
    const calculatedPercent = Math.min(100, Math.max(0, Math.round((progressCount / task.totalCount) * 100)));
    const overallPercent = Math.max(task.overallPercent, calculatedPercent);

    const updatedTask: ImportTaskGroup = {
      ...task,
      currentTitle,
      currentStage,
      currentStagePercent,
      completedCount,
      failedCount,
      overallPercent
    };
    this.tasks.set(taskId, updatedTask);

    // Update active item status
    if (update.activeItemKey) {
      const itemInfo: ImportTaskItemInfo = {
        key: update.activeItemKey,
        title: updatedTask.currentTitle ?? updatedTask.title,
        stage: updatedTask.currentStage,
        percent: updatedTask.currentStagePercent,
        status: "running"
      };
      this.itemKeyIndex.set(update.activeItemKey, itemInfo);
      if (update.activeItemAliasKeys) {
        for (const alias of update.activeItemAliasKeys) {
          this.itemKeyIndex.set(alias, itemInfo);
        }
      }
    }

    this.notify();
  }

  public completeItem(taskId: string, itemKey: string, aliasKeys?: string[]) {
    const task = this.tasks.get(taskId);
    if (task) {
      const completedCount = task.completedCount + 1;
      const progressCount = completedCount;
      const calculatedPercent = Math.min(100, Math.max(0, Math.round((progressCount / task.totalCount) * 100)));
      const overallPercent = Math.max(task.overallPercent, calculatedPercent);
      const updatedTask: ImportTaskGroup = {
        ...task,
        completedCount,
        overallPercent,
        currentStagePercent: completedCount >= task.totalCount ? 100 : 0
      };
      this.tasks.set(taskId, updatedTask);
    }

    const item = this.itemKeyIndex.get(itemKey);
    if (item) {
      this.itemKeyIndex.set(itemKey, {
        ...item,
        status: "completed",
        percent: 100
      });
    }
    if (aliasKeys) {
      for (const alias of aliasKeys) {
        const aliasItem = this.itemKeyIndex.get(alias);
        if (aliasItem) {
          this.itemKeyIndex.set(alias, {
            ...aliasItem,
            status: "completed",
            percent: 100
          });
        }
      }
    }
    this.notify();
  }

  public failItem(taskId: string, itemKey: string, error?: string, aliasKeys?: string[]) {
    const task = this.tasks.get(taskId);
    if (task) {
      const failedCount = task.failedCount + 1;
      const progressCount = task.completedCount + failedCount;
      const calculatedPercent = Math.min(100, Math.max(0, Math.round((progressCount / task.totalCount) * 100)));
      const overallPercent = Math.min(100, Math.max(task.overallPercent, calculatedPercent));
      const updatedTask: ImportTaskGroup = {
        ...task,
        failedCount,
        overallPercent,
        currentStagePercent: (task.completedCount + failedCount) >= task.totalCount ? 100 : 0
      };
      this.tasks.set(taskId, updatedTask);
    }

    const item = this.itemKeyIndex.get(itemKey);
    if (item) {
      this.itemKeyIndex.set(itemKey, {
        ...item,
        status: "failed",
        error
      });
    }
    if (aliasKeys) {
      for (const alias of aliasKeys) {
        const aliasItem = this.itemKeyIndex.get(alias);
        if (aliasItem) {
          this.itemKeyIndex.set(alias, {
            ...aliasItem,
            status: "failed",
            error
          });
        }
      }
    }
    this.notify();
  }

  public getAbortSignal(taskId: string): AbortSignal | undefined {
    return this.abortControllers.get(taskId)?.signal;
  }

  public cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") {
      return false;
    }

    const controller = this.abortControllers.get(taskId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new DOMException("Import task was cancelled.", "AbortError"));
    }

    const updatedTask: ImportTaskGroup = {
      ...task,
      status: "cancelled",
      finishedAt: Date.now(),
      currentStage: "已取消"
    };
    this.tasks.set(taskId, updatedTask);

    for (const key of task.itemKeys) {
      this.itemKeyIndex.delete(key);
    }

    const timer = setTimeout(() => {
      this.tasks.delete(taskId);
      this.cleanupTimers.delete(taskId);
      this.abortControllers.delete(taskId);
      this.notify();
    }, this.finishCooldownMs);

    this.cleanupTimers.set(taskId, timer);
    this.notify();
    return true;
  }

  public cancelAllTasks(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        this.cancelTask(task.id);
      }
    }
  }

  public finishTask(taskId: string, options?: { error?: string }) {
    const task = this.tasks.get(taskId);
    if (!task || task.status === "cancelled") return;

    const finishedAt = Date.now();
    const isFailed = Boolean(options?.error || (task.failedCount > 0 && task.completedCount === 0));
    const status: ImportTaskStatus = isFailed ? "failed" : "completed";
    const error = isFailed ? (options?.error ?? "导入失败") : undefined;
    const completedCount = isFailed ? task.completedCount : task.totalCount;

    const updatedTask: ImportTaskGroup = {
      ...task,
      finishedAt,
      status,
      error,
      completedCount,
      overallPercent: 100,
      currentStagePercent: 100
    };
    this.tasks.set(taskId, updatedTask);

    // Clean item index for this task's items
    for (const key of task.itemKeys) {
      this.itemKeyIndex.delete(key);
    }

    // Schedule task removal from visible tasks
    const timer = setTimeout(() => {
      this.tasks.delete(taskId);
      this.cleanupTimers.delete(taskId);
      this.notify();
    }, this.finishCooldownMs);

    this.cleanupTimers.set(taskId, timer);
    this.notify();
  }

  public removeTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (task) {
      for (const key of task.itemKeys) {
        this.itemKeyIndex.delete(key);
      }
    }
    const controller = this.abortControllers.get(taskId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    this.abortControllers.delete(taskId);
    const timer = this.cleanupTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.cleanupTimers.delete(taskId);
    }
    this.tasks.delete(taskId);
    this.notify();
  }

  public clearAll() {
    for (const controller of this.abortControllers.values()) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
    this.abortControllers.clear();
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.cleanupTimers.clear();
    this.tasks.clear();
    this.itemKeyIndex.clear();
    this.notify();
  }
}

export const importTaskStore = new ImportTaskStore();

export function useVisibleImportTasks(): ImportTaskGroup[] {
  return useSyncExternalStore(
    importTaskStore.subscribe,
    importTaskStore.getVisibleSnapshot,
    () => []
  );
}

export function useItemImportStatus(itemKey: string | null | undefined): ItemImportStatus {
  return useSyncExternalStore(
    importTaskStore.subscribe,
    () => importTaskStore.getItemStatus(itemKey),
    () => IDLE_ITEM_STATUS
  );
}

export function useIsItemImporting(itemKey: string | null | undefined): boolean {
  return useSyncExternalStore(
    importTaskStore.subscribe,
    () => importTaskStore.isItemImporting(itemKey),
    () => false
  );
}

export function isCandidateImporting(candidate: {
  provider?: string | null;
  providerTrackId?: string | null;
  title?: string | null;
  fileHash?: string | null;
  id?: string | null;
}): boolean {
  if (candidate.fileHash && importTaskStore.isItemImporting(candidate.fileHash)) return true;
  if (candidate.id && importTaskStore.isItemImporting(candidate.id)) return true;
  if (candidate.provider && candidate.providerTrackId) {
    if (importTaskStore.isItemImporting(`${candidate.provider}:${candidate.providerTrackId}`)) return true;
    if (importTaskStore.isItemImporting(`provider:${candidate.provider}:${candidate.providerTrackId}`)) return true;
    if (importTaskStore.isItemImporting(candidate.providerTrackId)) return true;
  }
  if (candidate.title && importTaskStore.isItemImporting(candidate.title)) return true;
  return false;
}

export function mapAssetPreparationProgress(
  stage: string,
  completed: number,
  total: number,
  mode: "provider" | "local" = "provider"
): { stageLabel: string; percent: number } {
  const fraction = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
  if (mode === "local") {
    switch (stage) {
      case "inspecting":
        return { stageLabel: "检查音频资源", percent: 5 + Math.round(fraction * 10) }; // 5% ~ 15%
      case "hashing":
      case "persisting-original":
        return { stageLabel: "校验源文件", percent: 15 + Math.round(fraction * 25) }; // 15% ~ 40%
      case "decoding":
        return { stageLabel: "解码音频采样", percent: 40 + Math.round(fraction * 30) }; // 40% ~ 70%
      case "encoding":
      case "persisting-playback":
        return { stageLabel: "生成播放分片", percent: 70 + Math.round(fraction * 20) }; // 70% ~ 90%
      default:
        return { stageLabel: "处理音频数据", percent: 50 };
    }
  }

  // Provider mode: network download occupied 5% ~ 45%
  switch (stage) {
    case "inspecting":
      return { stageLabel: "检查音频资源", percent: 45 + Math.round(fraction * 4) }; // 45% ~ 49%
    case "hashing":
    case "persisting-original":
      return { stageLabel: "校验源文件", percent: 49 + Math.round(fraction * 15) }; // 49% ~ 64%
    case "decoding":
      return { stageLabel: "解码音频采样", percent: 64 + Math.round(fraction * 11) }; // 64% ~ 75%
    case "encoding":
    case "persisting-playback":
      return { stageLabel: "生成播放分片", percent: 75 + Math.round(fraction * 12) }; // 75% ~ 87%
    default:
      return { stageLabel: "处理音频数据", percent: 60 };
  }
}

