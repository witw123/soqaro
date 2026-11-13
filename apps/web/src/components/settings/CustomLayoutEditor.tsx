"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useBackHandler } from "@/lib/desktop/use-back-handler";
import {
  customLayoutCanvas,
  customLayoutItemLabels,
  customLayoutItemMinimumSizes,
  customLayoutPageIds,
  customLayoutPageLabels,
  getCustomLayoutItemIds,
  getDefaultCustomLayoutSettings,
  normalizeCustomLayoutSettings,
  type CustomLayoutItem,
  type CustomLayoutItemId,
  type CustomLayoutPageId,
  type CustomLayoutSettings
} from "@/features/settings/settings-store";

type CustomLayoutEditorProps = {
  value: CustomLayoutSettings;
  onApply: (value: CustomLayoutSettings) => void;
  onReset: () => void;
  onClose: () => void;
};

type DragState = {
  pointerId: number;
  itemId: CustomLayoutItemId;
  mode: "move" | "resize";
  handle?: ResizeHandle;
  startX: number;
  startY: number;
  initialItem: CustomLayoutItem;
};

type ResizeHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const resizeHandles: Array<{ id: ResizeHandle; className: string; cursor: string }> = [
  { id: "n", className: "-top-1.5 left-1/2 h-3 w-8 -translate-x-1/2", cursor: "ns-resize" },
  { id: "ne", className: "-right-1.5 -top-1.5 h-4 w-4", cursor: "nesw-resize" },
  { id: "e", className: "-right-1.5 top-1/2 h-8 w-3 -translate-y-1/2", cursor: "ew-resize" },
  { id: "se", className: "-bottom-1.5 -right-1.5 h-4 w-4", cursor: "nwse-resize" },
  { id: "s", className: "-bottom-1.5 left-1/2 h-3 w-8 -translate-x-1/2", cursor: "ns-resize" },
  { id: "sw", className: "-bottom-1.5 -left-1.5 h-4 w-4", cursor: "nesw-resize" },
  { id: "w", className: "-left-1.5 top-1/2 h-8 w-3 -translate-y-1/2", cursor: "ew-resize" },
  { id: "nw", className: "-left-1.5 -top-1.5 h-4 w-4", cursor: "nwse-resize" }
];

const gridSize = 8;
const itemColors: Record<CustomLayoutItemId, string> = {
  sidebar: "#8b5cf6",
  content: "#007aff",
  player: "#f59e0b",
  "mobile-navigation": "#10b981",
  "room-stage": "#ec4899",
  "room-panel": "#14b8a6"
};

export function CustomLayoutEditor({ value, onApply, onReset, onClose }: CustomLayoutEditorProps) {
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const [pageId, setPageId] = useState<CustomLayoutPageId>("home");
  const [selectedItemId, setSelectedItemId] = useState<CustomLayoutItemId>("content");
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);

  const setDraftValue = useCallback((next: CustomLayoutSettings) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  const updatePageItem = useCallback((
    targetPageId: CustomLayoutPageId,
    itemId: CustomLayoutItemId,
    item: CustomLayoutItem
  ) => {
    const next = {
      ...draftRef.current,
      pages: {
        ...draftRef.current.pages,
        [targetPageId]: {
          ...draftRef.current.pages[targetPageId],
          [itemId]: item
        }
      }
    };
    setDraftValue(next);
  }, [setDraftValue]);

  useEffect(() => {
    setPortalTarget(document.body);
  }, []);

  useEffect(() => {
    draftRef.current = value;
    setDraft(value);
  }, [value]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (!selectedItemId || dragRef.current) return;
      if (!canvasRef.current || (document.activeElement !== canvasRef.current && !canvasRef.current.contains(document.activeElement))) return;
      const direction = getKeyboardDirection(event.key);
      if (!direction) return;
      const item = draftRef.current.pages[pageId][selectedItemId];
      if (item.locked) return;
      event.preventDefault();
      const amount = event.shiftKey ? gridSize * 4 : gridSize;
      const nextItem = clampItem({
        ...item,
        x: item.x + direction.x * amount,
        y: item.y + direction.y * amount
      }, selectedItemId);
      updatePageItem(pageId, selectedItemId, nextItem);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, pageId, selectedItemId, updatePageItem]);

  useBackHandler(onClose);

  const currentPage = draft.pages[pageId];
  const availableItemIds = getCustomLayoutItemIds(pageId);
  const selectedItem = currentPage[selectedItemId];

  function selectPage(nextPageId: CustomLayoutPageId) {
    setPageId(nextPageId);
    setSelectedItemId(getCustomLayoutItemIds(nextPageId)[0]);
  }

  function updateSelectedItem(itemId: CustomLayoutItemId, patch: Partial<CustomLayoutItem>) {
    const item = draftRef.current.pages[pageId][itemId];
    updatePageItem(pageId, itemId, { ...item, ...patch });
  }

  function restorePage() {
    const defaults = getDefaultCustomLayoutSettings();
    const next = {
      ...draftRef.current,
      pages: {
        ...draftRef.current.pages,
        [pageId]: defaults.pages[pageId]
      }
    };
    setDraftValue(next);
  }

  function restoreAll() {
    setDraftValue(getDefaultCustomLayoutSettings());
  }

  function handleCanvasPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = getCanvasPoint(event, canvasRef.current);
    if (!point) return;

    const dx = snap(point.x - drag.startX);
    const dy = snap(point.y - drag.startY);
    const nextItem = drag.mode === "move"
      ? clampItem({
          ...drag.initialItem,
          x: drag.initialItem.x + dx,
          y: drag.initialItem.y + dy
        }, drag.itemId)
      : resizeItem(
          drag.initialItem,
          drag.itemId,
          drag.handle ?? "se",
          dx,
          dy,
          event.shiftKey
        );
    updatePageItem(pageId, drag.itemId, nextItem);
  }

  function handleCanvasPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (canvasRef.current?.hasPointerCapture(event.pointerId)) {
      canvasRef.current.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  function beginDrag(
    event: ReactPointerEvent<HTMLElement>,
    itemId: CustomLayoutItemId,
    mode: DragState["mode"],
    handle?: ResizeHandle
  ) {
    event.stopPropagation();
    canvasRef.current?.focus({ preventScroll: true });
    setSelectedItemId(itemId);
    const item = draftRef.current.pages[pageId][itemId];
    if (item.locked) return;
    const point = getCanvasPoint(event, canvasRef.current);
    if (!point) return;
    // Keep the drag on the canvas. The resize handle is rerendered as the
    // draft changes, so capturing on the handle itself can lose move events.
    canvasRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      itemId,
      mode,
      handle,
      startX: point.x,
      startY: point.y,
      initialItem: { ...item }
    };
  }

  const editor = (
    <div aria-label="自定义界面编辑器" aria-modal="true" className="fixed inset-0 z-[120] flex flex-col bg-background/95 text-foreground md:backdrop-blur-2xl" role="dialog">
      <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-surface-border px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/12 text-accent">
            <LayoutIcon />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">自定义界面</h2>
            <p className="truncate text-xs text-foreground-muted">编辑 {customLayoutPageLabels[pageId]} 的桌面布局</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button className="gap-2" onClick={restorePage} size="sm" type="button" variant="outline">
            <ResetIcon />
            恢复当前页
          </Button>
          <Button className="hidden gap-2 sm:inline-flex" onClick={restoreAll} size="sm" type="button" variant="outline">
            <ResetIcon />
            恢复全部
          </Button>
          <Button className="hidden gap-2 md:inline-flex" onClick={onReset} size="sm" type="button" variant="ghost">
            <CloseIcon />
            退出并还原默认
          </Button>
          <Button className="gap-2" onClick={() => onApply(normalizeCustomLayoutSettings(draftRef.current))} size="sm" type="button">
            <CheckIcon />
            应用布局
          </Button>
          <Button aria-label="关闭自定义界面编辑器" onClick={onClose} size="icon" title="关闭编辑器" type="button" variant="ghost">
            <CloseIcon />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <aside className="flex shrink-0 gap-1 overflow-x-auto border-b border-surface-border px-3 py-2 lg:w-44 lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r lg:px-2 lg:py-4">
          <p className="hidden px-2 pb-2 text-xs font-medium text-foreground-muted lg:block">页面</p>
          {customLayoutPageIds.map((item) => (
            <button
              aria-current={pageId === item ? "page" : undefined}
              className={`flex h-10 shrink-0 items-center rounded-lg px-3 text-left text-xs font-medium transition-colors ${pageId === item ? "bg-accent text-white shadow-xs" : "text-foreground-muted hover:bg-surface-hover hover:text-foreground"}`}
              key={item}
              onClick={() => selectPage(item)}
              type="button"
            >
              {customLayoutPageLabels[item]}
            </button>
          ))}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-3 py-4 sm:px-6 sm:py-6">
          <div className="mx-auto flex w-full max-w-[1120px] min-w-[720px] flex-1 flex-col justify-center gap-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-foreground-muted">
                <GridIcon />
                <span>网格吸附 / 1440 × 900</span>
              </div>
            </div>
            <div
              className="relative w-full overflow-hidden rounded-xl border border-surface-border bg-background-secondary shadow-xl touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
              onPointerDown={(event) => {
                canvasRef.current?.focus({ preventScroll: true });
                if (event.target === event.currentTarget) setSelectedItemId("content");
              }}
              onPointerMove={handleCanvasPointerMove}
              onPointerCancel={handleCanvasPointerUp}
              onPointerUp={handleCanvasPointerUp}
              tabIndex={0}
              ref={canvasRef}
              style={{ aspectRatio: `${customLayoutCanvas.width} / ${customLayoutCanvas.height}` }}
            >
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-40" style={{ backgroundImage: "linear-gradient(to right, color-mix(in srgb, var(--foreground) 7%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--foreground) 7%, transparent) 1px, transparent 1px)", backgroundSize: `${(gridSize / customLayoutCanvas.width) * 100}% ${(gridSize / customLayoutCanvas.height) * 100}%` }} />
              {availableItemIds.map((itemId) => {
                const item = currentPage[itemId];
                return (
                <LayoutCanvasItem
                  item={item}
                  itemId={itemId}
                  key={itemId}
                  onPointerDown={beginDrag}
                  selected={selectedItemId === itemId}
                />
                );
              })}
            </div>
          </div>
        </main>

        <aside className="w-full shrink-0 border-t border-surface-border bg-surface/25 px-4 py-3 lg:w-72 lg:overflow-y-auto lg:border-l lg:border-t-0 lg:px-4 lg:py-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-xs font-semibold">组件</h3>
              <p className="mt-1 text-xs text-foreground-muted">当前页布局</p>
            </div>
            <span className="text-xs tabular-nums text-foreground-muted">{availableItemIds.length}</span>
          </div>
          <div className="space-y-2">
            {availableItemIds.map((itemId) => {
              const item = currentPage[itemId];
              return (
              <div className={`rounded-xl border p-2 transition-colors ${selectedItemId === itemId ? "border-accent/60 bg-accent/8" : "border-surface-border bg-background-secondary/45"}`} key={itemId}>
                <button className="flex w-full min-w-0 items-center gap-2 text-left" onClick={() => setSelectedItemId(itemId)} type="button">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: itemColors[itemId] }} />
                  <span className={`min-w-0 flex-1 truncate text-xs font-medium ${item.visible ? "text-foreground" : "text-foreground-muted line-through"}`}>{customLayoutItemLabels[itemId]}</span>
                  <span className="text-xs tabular-nums text-foreground-muted">{item.width} × {item.height}</span>
                </button>
                <div className="mt-2 flex items-center justify-end gap-1">
                  <button aria-label={`${item.visible ? "隐藏" : "显示"}${customLayoutItemLabels[itemId]}`} className="flex h-8 w-8 items-center justify-center rounded-lg text-foreground-muted transition hover:bg-surface-hover hover:text-foreground" onClick={() => updateSelectedItem(itemId, { visible: !item.visible })} title={item.visible ? "隐藏" : "显示"} type="button">
                    {item.visible ? <EyeIcon /> : <EyeOffIcon />}
                  </button>
                  <button aria-label={`${item.locked ? "解锁" : "锁定"}${customLayoutItemLabels[itemId]}`} className="flex h-8 w-8 items-center justify-center rounded-lg text-foreground-muted transition hover:bg-surface-hover hover:text-foreground" onClick={() => updateSelectedItem(itemId, { locked: !item.locked })} title={item.locked ? "解锁" : "锁定"} type="button">
                    {item.locked ? <LockIcon /> : <UnlockIcon />}
                  </button>
                </div>
              </div>
              );
            })}
          </div>
          {selectedItem ? (
            <div className="mt-5 border-t border-surface-border pt-4">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: itemColors[selectedItemId] }} />
                <h3 className="text-xs font-semibold">{customLayoutItemLabels[selectedItemId]}</h3>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-foreground-muted">
                <Metric label="横坐标" value={selectedItem.x} />
                <Metric label="纵坐标" value={selectedItem.y} />
                <Metric label="宽度" value={selectedItem.width} />
                <Metric label="高度" value={selectedItem.height} />
              </div>
              <p className="mt-3 text-xs leading-4 text-foreground-muted">{selectedItem.locked ? "组件已锁定" : "组件可编辑"}</p>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );

  return portalTarget ? createPortal(editor, portalTarget) : null;
}

function LayoutCanvasItem({
  item,
  itemId,
  onPointerDown,
  selected
}: {
  item: CustomLayoutItem;
  itemId: CustomLayoutItemId;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, itemId: CustomLayoutItemId, mode: DragState["mode"], handle?: ResizeHandle) => void;
  selected: boolean;
}) {
  const color = itemColors[itemId];
  return (
    <div
      aria-label={customLayoutItemLabels[itemId]}
      className={`absolute select-none overflow-visible rounded-lg border text-xs font-semibold shadow-lg transition-[box-shadow,opacity] ${selected ? "z-20 shadow-[0_0_0_2px_var(--accent),0_12px_30px_rgba(0,0,0,0.25)]" : "z-10"} ${item.visible ? "opacity-100" : "opacity-35"}`}
      onPointerDown={(event) => onPointerDown(event, itemId, "move")}
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 18%, var(--background-secondary))`,
        borderColor: selected ? "var(--accent)" : `color-mix(in srgb, ${color} 55%, transparent)`,
        color,
        height: `${(item.height / customLayoutCanvas.height) * 100}%`,
        left: `${(item.x / customLayoutCanvas.width) * 100}%`,
        minWidth: 36,
        top: `${(item.y / customLayoutCanvas.height) * 100}%`,
        width: `${(item.width / customLayoutCanvas.width) * 100}%`
      }}
    >
      <div className="flex h-full min-w-0 items-center gap-1.5 px-2">
        <MoveIcon />
        <span className="truncate">{customLayoutItemLabels[itemId]}</span>
        {item.locked ? <LockIcon /> : null}
      </div>
      {selected && !item.locked
        ? resizeHandles.map((handle) => (
            <button
              aria-label={`从${handle.id}方向调整${customLayoutItemLabels[itemId]}大小`}
              className={`absolute z-10 rounded-sm border border-transparent bg-transparent ${handle.className}`}
              key={handle.id}
              onPointerDown={(event) => onPointerDown(event, itemId, "resize", handle.id)}
              style={{ cursor: handle.cursor }}
              title="调整大小"
              type="button"
            >
              <span className="pointer-events-none absolute inset-1 rounded-sm" style={{ backgroundColor: color }} />
            </button>
          ))
        : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-surface-border bg-background-secondary/55 px-2.5 py-2">
      <span className="block text-xs">{label}</span>
      <span className="mt-1 block tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function getCanvasPoint(event: ReactPointerEvent, canvas: HTMLDivElement | null) {
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (customLayoutCanvas.width / rect.width),
    y: (event.clientY - rect.top) * (customLayoutCanvas.height / rect.height)
  };
}

function snap(value: number) {
  return Math.round(value / gridSize) * gridSize;
}

function resizeItem(
  item: CustomLayoutItem,
  itemId: CustomLayoutItemId,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  keepRatio: boolean
): CustomLayoutItem {
  const minimum = customLayoutItemMinimumSizes[itemId];
  const fromLeft = handle.includes("w");
  const fromTop = handle.includes("n");
  const fromRight = handle.includes("e");
  const fromBottom = handle.includes("s");

  if (keepRatio && handle.length === 2) {
    const ratio = item.width / item.height;
    const widthFromPointer = item.width + (fromRight ? dx : -dx);
    const heightFromPointer = item.height + (fromBottom ? dy : -dy);
    const widthDelta = Math.abs(widthFromPointer - item.width) / item.width;
    const heightDelta = Math.abs(heightFromPointer - item.height) / item.height;
    let width = widthDelta >= heightDelta ? widthFromPointer : heightFromPointer * ratio;
    let height = width / ratio;

    if (height < minimum.height) {
      height = minimum.height;
      width = height * ratio;
    }
    if (width < minimum.width) {
      width = minimum.width;
      height = width / ratio;
    }

    const next = {
      ...item,
      x: fromLeft ? item.x + item.width - width : item.x,
      y: fromTop ? item.y + item.height - height : item.y,
      width: snap(width),
      height: snap(height)
    };
    return clampItem(next, itemId);
  }

  let left = item.x;
  let top = item.y;
  let right = item.x + item.width;
  let bottom = item.y + item.height;
  if (fromLeft) left = snap(item.x + dx);
  if (fromRight) right = snap(item.x + item.width + dx);
  if (fromTop) top = snap(item.y + dy);
  if (fromBottom) bottom = snap(item.y + item.height + dy);

  if (right - left < minimum.width) {
    if (fromLeft) left = right - minimum.width;
    else right = left + minimum.width;
  }
  if (bottom - top < minimum.height) {
    if (fromTop) top = bottom - minimum.height;
    else bottom = top + minimum.height;
  }

  return clampItem({
    ...item,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top
  }, itemId);
}

function clampItem(item: CustomLayoutItem, itemId: CustomLayoutItemId): CustomLayoutItem {
  const minimum = customLayoutItemMinimumSizes[itemId];
  const width = Math.min(customLayoutCanvas.width, Math.max(minimum.width, Math.round(item.width)));
  const height = Math.min(customLayoutCanvas.height, Math.max(minimum.height, Math.round(item.height)));
  return {
    ...item,
    x: Math.min(customLayoutCanvas.width - width, Math.max(0, snap(item.x))),
    y: Math.min(customLayoutCanvas.height - height, Math.max(0, snap(item.y))),
    width,
    height
  };
}

function getKeyboardDirection(key: string) {
  if (key === "ArrowLeft") return { x: -1, y: 0 };
  if (key === "ArrowRight") return { x: 1, y: 0 };
  if (key === "ArrowUp") return { x: 0, y: -1 };
  if (key === "ArrowDown") return { x: 0, y: 1 };
  return null;
}

function LayoutIcon() {
  return <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18"><rect height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" width="7" x="3" y="3" /><rect height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" width="7" x="14" y="3" /><rect height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" width="7" x="3" y="14" /><rect height="7" rx="1.5" stroke="currentColor" strokeWidth="1.8" width="7" x="14" y="14" /></svg>;
}

function GridIcon() {
  return <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14"><path d="M4 4h16M4 12h16M4 20h16M4 4v16M12 4v16M20 4v16" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" /></svg>;
}

function MoveIcon() {
  return <svg aria-hidden="true" fill="none" height="12" viewBox="0 0 24 24" width="12"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>;
}

function EyeIcon() {
  return <svg aria-hidden="true" fill="none" height="15" viewBox="0 0 24 24" width="15"><path d="M2.5 12s3.4-6 9.5-6 9.5 6 9.5 6-3.4 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" strokeWidth="1.7" /><circle cx="12" cy="12" r="2.5" stroke="currentColor" strokeWidth="1.7" /></svg>;
}

function EyeOffIcon() {
  return <svg aria-hidden="true" fill="none" height="15" viewBox="0 0 24 24" width="15"><path d="m3 3 18 18M10.6 6.2A9.5 9.5 0 0 1 12 6c6.1 0 9.5 6 9.5 6a17 17 0 0 1-3.2 3.8M6.2 6.7C3.8 8.4 2.5 12 2.5 12s3.4 6 9.5 6c1 0 1.9-.2 2.7-.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>;
}

function LockIcon() {
  return <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14"><rect height="10" rx="2" stroke="currentColor" strokeWidth="1.7" width="14" x="5" y="10" /><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" /></svg>;
}

function UnlockIcon() {
  return <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14"><rect height="10" rx="2" stroke="currentColor" strokeWidth="1.7" width="14" x="5" y="10" /><path d="M8 10V7a4 4 0 0 1 7.4-2.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" /></svg>;
}

function ResetIcon() {
  return <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14"><path d="M4 5v5h5M5 10a8 8 0 1 1 2.3 7.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" /></svg>;
}

function CloseIcon() {
  return <svg aria-hidden="true" fill="none" height="18" viewBox="0 0 24 24" width="18"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" /></svg>;
}

function CheckIcon() {
  return <svg aria-hidden="true" fill="none" height="14" viewBox="0 0 24 24" width="14"><path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg>;
}
