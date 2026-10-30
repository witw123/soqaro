import { describe, it, expect, beforeEach, vi } from "vitest";
import { importTaskStore } from "./import-task-store";

describe("importTaskStore", () => {
  beforeEach(() => {
    importTaskStore.clearAll();
    vi.useFakeTimers();
  });

  it("creates a new import task and indexes item keys", () => {
    const taskId = importTaskStore.startTask({
      type: "provider_batch",
      title: "导入选中歌曲",
      totalCount: 3,
      itemKeys: ["netease:1001", "netease:1002", "netease:1003"],
      currentTitle: "歌曲1",
      currentStage: "正在预取"
    });

    expect(taskId).toBeDefined();
    const tasks = importTaskStore.getActiveTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe("导入选中歌曲");
    expect(tasks[0].totalCount).toBe(3);
    expect(tasks[0].status).toBe("running");

    expect(importTaskStore.isItemImporting("netease:1001")).toBe(true);
    expect(importTaskStore.isItemImporting("netease:1002")).toBe(true);
    expect(importTaskStore.isItemImporting("netease:9999")).toBe(false);
  });

  it("updates task progress and calculates overall percentage smoothly", () => {
    const taskId = importTaskStore.startTask({
      type: "provider_batch",
      title: "导入专辑",
      totalCount: 2,
      itemKeys: ["qqmusic:001", "qqmusic:002"]
    });

    // 0 completed, item 1 is at 50%
    importTaskStore.updateTaskProgress(taskId, {
      currentTitle: "晴天",
      currentStage: "正在解码",
      currentStagePercent: 50,
      activeItemKey: "qqmusic:001"
    });

    let task = importTaskStore.getActiveTasks()[0];
    // (0 + 0.5) / 2 = 25%
    expect(task.overallPercent).toBe(25);
    expect(task.currentTitle).toBe("晴天");
    expect(task.currentStage).toBe("正在解码");

    const itemStatus = importTaskStore.getItemStatus("qqmusic:001");
    expect(itemStatus.isImporting).toBe(true);
    expect(itemStatus.percent).toBe(50);
    expect(itemStatus.stage).toBe("正在解码");

    // Complete item 1
    importTaskStore.completeItem(taskId, "qqmusic:001");
    task = importTaskStore.getActiveTasks()[0];
    // 1 completed / 2 = 50%
    expect(task.overallPercent).toBe(50);

    // Item 2 at 80%
    importTaskStore.updateTaskProgress(taskId, {
      currentTitle: "七里香",
      currentStage: "生成分片",
      currentStagePercent: 80,
      activeItemKey: "qqmusic:002"
    });
    task = importTaskStore.getActiveTasks()[0];
    // (1 + 0.8) / 2 = 90%
    expect(task.overallPercent).toBe(90);

    // Complete item 2
    importTaskStore.completeItem(taskId, "qqmusic:002");
    task = importTaskStore.getActiveTasks()[0];
    expect(task.overallPercent).toBe(100);
  });

  it("finishes task, keeps visible during cooldown, and cleans up after timer", () => {
    const taskId = importTaskStore.startTask({
      type: "local_files",
      title: "导入本地音频",
      totalCount: 1,
      itemKeys: ["file-hash-1"]
    });

    expect(importTaskStore.isItemImporting("file-hash-1")).toBe(true);

    importTaskStore.finishTask(taskId);

    // Item key index is cleared so UI buttons can be re-enabled
    expect(importTaskStore.isItemImporting("file-hash-1")).toBe(false);

    // Still in visible tasks for feedback
    let visible = importTaskStore.getVisibleTasks();
    expect(visible).toHaveLength(1);
    expect(visible[0].status).toBe("completed");

    // Advance time past cooldown
    vi.advanceTimersByTime(2600);

    visible = importTaskStore.getVisibleTasks();
    expect(visible).toHaveLength(0);
  });

  it("supports alias keys for flexible matching", () => {
    const taskId = importTaskStore.startTask({
      type: "provider_track",
      title: "导入单曲",
      totalCount: 1,
      itemKeys: ["netease:12345"]
    });

    importTaskStore.updateTaskProgress(taskId, {
      activeItemKey: "netease:12345",
      activeItemAliasKeys: ["12345"],
      currentStage: "下载音频",
      currentStagePercent: 30
    });

    expect(importTaskStore.isItemImporting("netease:12345")).toBe(true);
    expect(importTaskStore.isItemImporting("12345")).toBe(true);
    expect(importTaskStore.getItemStatus("12345").stage).toBe("下载音频");
  });

  it("produces new snapshot and task references on update for useSyncExternalStore", () => {
    const taskId = importTaskStore.startTask({
      type: "provider_track",
      title: "测试单曲",
      totalCount: 1
    });

    const snapshot1 = importTaskStore.getVisibleSnapshot();
    const task1 = snapshot1[0];
    expect(task1.overallPercent).toBe(0);

    // Snapshot reference is stable if nothing changed
    expect(importTaskStore.getVisibleSnapshot()).toBe(snapshot1);

    // Update progress
    importTaskStore.updateTaskProgress(taskId, {
      currentStagePercent: 30,
      currentStage: "下载中"
    });

    const snapshot2 = importTaskStore.getVisibleSnapshot();
    const task2 = snapshot2[0];

    // Array reference must be brand new
    expect(snapshot2).not.toBe(snapshot1);
    // Task object reference must be brand new
    expect(task2).not.toBe(task1);
    expect(task2.overallPercent).toBe(30);
    expect(task2.currentStage).toBe("下载中");

    // Item status referential stability
    const status1 = importTaskStore.getItemStatus("test-key");
    const status2 = importTaskStore.getItemStatus("test-key");
    expect(status1).toBe(status2);
  });

  it("cancels running task, aborts signal, and preserves cancelled state against finishTask", () => {
    const taskId = importTaskStore.startTask({
      type: "provider_batch",
      title: "批量导入",
      totalCount: 5,
      itemKeys: ["track-1", "track-2"]
    });

    const signal = importTaskStore.getAbortSignal(taskId);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);

    const cancelled = importTaskStore.cancelTask(taskId);
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);

    const task = importTaskStore.getVisibleTasks()[0];
    expect(task.status).toBe("cancelled");
    expect(task.currentStage).toBe("已取消");
    expect(importTaskStore.isItemImporting("track-1")).toBe(false);

    // finishTask should not override cancelled status
    importTaskStore.finishTask(taskId, { error: "something failed" });
    expect(importTaskStore.getVisibleTasks()[0].status).toBe("cancelled");

    // Cleaned up after cooldown
    vi.advanceTimersByTime(2600);
    expect(importTaskStore.getVisibleTasks()).toHaveLength(0);
  });
});
