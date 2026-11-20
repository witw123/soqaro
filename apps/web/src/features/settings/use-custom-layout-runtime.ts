"use client";

import { useEffect } from "react";
import {
  appSettingsChangeEvent,
  customLayoutCanvas,
  getAppSettings,
  getCustomLayoutPageId
} from "@/features/settings/settings-store";

const layoutItemIds = ["sidebar", "content", "player", "mobile-navigation", "room-stage", "room-panel"] as const;

function getVisibilityDatasetKey(itemId: string) {
  return `customLayout${itemId.replace(/(^|-)([a-z])/g, (_match: string, _separator: string, letter: string) => letter.toUpperCase())}Visible` as keyof DOMStringMap;
}

/** Publishes the selected page layout without changing the mobile navigation contract. */
export function useCustomLayoutRuntime(pathname: string | null) {
  useEffect(() => {
    const root = document.documentElement;
    const pageId = getCustomLayoutPageId(pathname);
    const isWorkspaceRoute = pathname === "/rooms" || pathname?.startsWith("/app") === true || pathname?.startsWith("/room/") === true;
    let hadAppliedCustomVars = root.dataset.customLayoutEnabled === "true";

    const clearLayoutVariables = () => {
      if (!hadAppliedCustomVars) return;
      for (const itemId of layoutItemIds) {
        for (const property of ["x", "y", "width", "height"]) {
          root.style.removeProperty(`--custom-${itemId}-${property}`);
        }
        delete root.dataset[getVisibilityDatasetKey(itemId)];
      }
      hadAppliedCustomVars = false;
    };

    const syncLayout = () => {
      const settings = getAppSettings();
      const enabled = isWorkspaceRoute && settings.layout.customLayout.enabled;
      const enabledStr = String(enabled);
      if (root.dataset.customLayoutEnabled !== enabledStr) {
        root.dataset.customLayoutEnabled = enabledStr;
      }
      if (root.dataset.customLayoutPage !== pageId) {
        root.dataset.customLayoutPage = pageId;
      }

      if (!enabled) {
        clearLayoutVariables();
        return;
      }

      hadAppliedCustomVars = true;
      const page = settings.layout.customLayout.pages[pageId];
      for (const itemId of layoutItemIds) {
        const item = page[itemId];
        const visKey = getVisibilityDatasetKey(itemId);
        const visStr = String(item.visible);
        if (root.dataset[visKey] !== visStr) {
          root.dataset[visKey] = visStr;
        }
        for (const property of ["x", "y", "width", "height"] as const) {
          const base = property === "x" || property === "width" ? customLayoutCanvas.width : customLayoutCanvas.height;
          const nextValue = `${(item[property] / base) * 100}%`;
          if (root.style.getPropertyValue(`--custom-${itemId}-${property}`) !== nextValue) {
            root.style.setProperty(`--custom-${itemId}-${property}`, nextValue);
          }
        }
      }
    };

    syncLayout();
    window.addEventListener(appSettingsChangeEvent, syncLayout);
    window.addEventListener("storage", syncLayout);
    return () => {
      window.removeEventListener(appSettingsChangeEvent, syncLayout);
      window.removeEventListener("storage", syncLayout);
      if (hadAppliedCustomVars) {
        clearLayoutVariables();
        root.dataset.customLayoutEnabled = "false";
        delete root.dataset.customLayoutPage;
      }
    };
  }, [pathname]);
}
