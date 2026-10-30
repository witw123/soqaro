"use client";

import { memo } from "react";
import { useVisibleImportTasks, importTaskStore } from "@/features/upload/import-task-store";
import { CheckIcon } from "@/components/icons/DiscoverIcons";

function RoomImportProgressBarBase() {
  const tasks = useVisibleImportTasks();

  if (tasks.length === 0) {
    return null;
  }

  // Prioritize any actively running task; otherwise show the latest finished one
  const activeTask = tasks.find((t) => t.status === "running") ?? tasks[tasks.length - 1];
  if (!activeTask) {
    return null;
  }

  const isRunning = activeTask.status === "running";
  const isCompleted = activeTask.status === "completed";
  const isFailed = activeTask.status === "failed";
  const isCancelled = activeTask.status === "cancelled";

  const total = activeTask.totalCount;
  const current = Math.min(total, activeTask.completedCount + 1);

  let label = "";
  if (isRunning) {
    const stagePercent =
      typeof activeTask.currentStagePercent === "number" && activeTask.currentStagePercent > 0
        ? ` ${activeTask.currentStagePercent}%`
        : "";
    const stageText = activeTask.currentStage ? ` (${activeTask.currentStage}${stagePercent})` : "";

    if (total > 1) {
      const itemTitle = activeTask.currentTitle ? `《${activeTask.currentTitle}》` : "";
      label = `正在导入 (${current}/${total})：${itemTitle}${stageText}`;
    } else {
      let rawTitle = activeTask.currentTitle || activeTask.title;
      rawTitle = rawTitle.replace(/^导入/, "").replace(/^《|》$/g, "").trim();
      const itemTitle = rawTitle ? `《${rawTitle}》` : "";
      label = `正在导入：${itemTitle}${stageText}`;
    }
  } else if (isCompleted) {
    label = `导入完成 (共 ${activeTask.completedCount} 首)`;
  } else if (isCancelled) {
    label =
      activeTask.completedCount > 0
        ? `已取消导入（已完成 ${activeTask.completedCount} 首）`
        : "已取消导入";
  } else {
    label = activeTask.error ? `导入失败：${activeTask.error}` : "导入失败";
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="my-1.5 flex flex-col gap-1 rounded-lg border border-surface-border/50 bg-surface/80 px-2.5 py-1.5 backdrop-blur-md transition-all shadow-xs"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex min-w-0 items-center gap-1.5">
          {isRunning ? (
            <svg
              className="h-3.5 w-3.5 shrink-0 animate-spin text-accent"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
          ) : isCompleted ? (
            <CheckIcon className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          ) : isCancelled ? (
            <svg
              className="h-3.5 w-3.5 shrink-0 text-foreground-muted"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
            </svg>
          ) : (
            <svg
              className="h-3.5 w-3.5 shrink-0 text-red-500"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          )}
          <span className="truncate text-xs font-medium text-foreground tabular-nums">
            {label}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-xs font-semibold text-accent tabular-nums">
            {isCompleted ? "100%" : isCancelled ? `${activeTask.overallPercent}%` : `${Math.min(99, activeTask.overallPercent)}%`}
          </span>
          {isRunning ? (
            <button
              type="button"
              onClick={() => importTaskStore.cancelTask(activeTask.id)}
              className="rounded px-1.5 py-0.5 text-xs text-foreground-muted hover:bg-surface-border/40 hover:text-foreground active:opacity-80 transition-colors"
              aria-label="取消导入"
            >
              取消
            </button>
          ) : isFailed || isCancelled ? (
            <button
              type="button"
              onClick={() => importTaskStore.removeTask(activeTask.id)}
              className="p-0.5 text-foreground-muted hover:text-foreground"
              aria-label="关闭提示"
            >
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      <div className="h-1 w-full overflow-hidden rounded-full bg-surface-border/40">
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out ${
            isFailed
              ? "bg-red-500"
              : isCancelled
                ? "bg-foreground-muted/40"
                : isCompleted
                  ? "bg-emerald-500"
                  : "bg-accent"
          }`}
          style={{ width: `${Math.max(2, activeTask.overallPercent)}%` }}
        />
      </div>
    </div>
  );
}

export const RoomImportProgressBar = memo(RoomImportProgressBarBase);
