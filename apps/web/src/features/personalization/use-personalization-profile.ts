"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { soqaroApi } from "@/lib/network/soqaro-api";
import { useSessionIdentity } from "@/features/session/use-session-identity";
import { useWorkspacePageActive } from "@/features/workspace/page-activity";
import { personalizationChangedEvent } from "./use-personalization-reporter";
import {
  getLocalStoredProfile,
  mergeProfileWithServer
} from "./local-personalization-store";

export function usePersonalizationProfile() {
  const pageActive = useWorkspacePageActive();
  const { activeSession } = useSessionIdentity({
    sessionStorageKey: "soqaro-session",
    initialStatusMessage: ""
  });
  const userId = activeSession?.userId ?? null;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["personalization", userId, "profile"],
    queryFn: ({ signal }) => soqaroApi.getPersonalizationProfile(signal),
    enabled: pageActive && Boolean(activeSession)
  });
  const [localProfile, setLocalProfile] = useState(() => getLocalStoredProfile(userId));

  useEffect(() => {
    setLocalProfile(getLocalStoredProfile(userId));
  }, [userId]);

  useEffect(() => {
    if (!pageActive) {
      void queryClient.cancelQueries({ queryKey: ["personalization"], type: "inactive" });
      return;
    }
    const refresh = () => {
      setLocalProfile(getLocalStoredProfile(userId));
      void queryClient.invalidateQueries({ queryKey: ["personalization", userId] });
    };
    refresh();
    window.addEventListener(personalizationChangedEvent, refresh);
    return () => window.removeEventListener(personalizationChangedEvent, refresh);
  }, [pageActive, queryClient, userId]);

  const profile = useMemo(
    () => query.data ? mergeProfileWithServer(localProfile, query.data, userId) ?? query.data : localProfile,
    [localProfile, query.data, userId]
  );
  return { profile, loading: !profile && query.isLoading };
}
