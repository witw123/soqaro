"use client";

import { useCallback, useReducer, type SetStateAction } from "react";
import type {
  IceConfigResponse,
  Playlist,
  RoomDirectoryItem
} from "@soqaro/shared";

export type RoomPageState = {
  activeDashboardTab: "library" | "search" | "local" | "members";
  isDiagnosticsPanelOpen: boolean;
  isPageVisible: boolean;
  availableRooms: RoomDirectoryItem[];
  playlists: Playlist[];
  connectedPeers: string[];
  mediaConnectedPeers: string[];
  suppressRoomRecovery: boolean;
  isRecoveringRoom: boolean;
  isNavigatingRoomExit: boolean;
  iceConfig: IceConfigResponse | null;
  iceConfigResolved: boolean;
  volume: number;
  playerResetEpoch: number;
  audioUnlocked: boolean;
  audioBlockedOverlay: boolean;
};

type RoomPageStateKey = keyof RoomPageState;

type RoomPageStateAction = {
  [TKey in RoomPageStateKey]: {
    type: "set";
    key: TKey;
    value: SetStateAction<RoomPageState[TKey]>;
  };
}[RoomPageStateKey];

export function createInitialRoomPageState(input: {
  documentHidden: boolean;
  audioUnlocked?: boolean;
}): RoomPageState {
  return {
    activeDashboardTab: "library",
    isDiagnosticsPanelOpen: false,
    isPageVisible: !input.documentHidden,
    availableRooms: [],
    playlists: [],
    connectedPeers: [],
    mediaConnectedPeers: [],
    suppressRoomRecovery: false,
    isRecoveringRoom: false,
    isNavigatingRoomExit: false,
    iceConfig: null,
    iceConfigResolved: false,
    volume: 0.72,
    playerResetEpoch: 0,
    audioUnlocked: input.audioUnlocked ?? false,
    audioBlockedOverlay: false
  };
}

function resolveSetStateAction<TValue>(current: TValue, value: SetStateAction<TValue>) {
  return typeof value === "function" ? (value as (current: TValue) => TValue)(current) : value;
}

export function roomPageStateReducer(
  state: RoomPageState,
  action: RoomPageStateAction
): RoomPageState {
  const currentValue = state[action.key];
  const nextValue = resolveSetStateAction(
    currentValue,
    action.value as SetStateAction<typeof currentValue>
  );
  return Object.is(nextValue, currentValue)
    ? state
    : {
        ...state,
        [action.key]: nextValue
      };
}

export function useRoomPageState(input: { audioUnlocked?: boolean } = {}) {
  const [state, dispatch] = useReducer(
    roomPageStateReducer,
    undefined,
    () =>
      createInitialRoomPageState({
        documentHidden: typeof document !== "undefined" && document.hidden,
        audioUnlocked: input.audioUnlocked
      })
  );

  const setAvailableRooms = useCallback(
    (value: SetStateAction<RoomDirectoryItem[]>) =>
      dispatch({ type: "set", key: "availableRooms", value }),
    []
  );
  const setPlaylists = useCallback(
    (value: SetStateAction<Playlist[]>) => dispatch({ type: "set", key: "playlists", value }),
    []
  );
  const setConnectedPeers = useCallback(
    (value: SetStateAction<string[]>) => dispatch({ type: "set", key: "connectedPeers", value }),
    []
  );
  const setMediaConnectedPeers = useCallback(
    (value: SetStateAction<string[]>) =>
      dispatch({ type: "set", key: "mediaConnectedPeers", value }),
    []
  );
  const setSuppressRoomRecovery = useCallback(
    (value: SetStateAction<boolean>) =>
      dispatch({ type: "set", key: "suppressRoomRecovery", value }),
    []
  );
  const setIsRecoveringRoom = useCallback(
    (value: SetStateAction<boolean>) =>
      dispatch({ type: "set", key: "isRecoveringRoom", value }),
    []
  );
  const setIsNavigatingRoomExit = useCallback(
    (value: SetStateAction<boolean>) =>
      dispatch({ type: "set", key: "isNavigatingRoomExit", value }),
    []
  );
  const setIceConfig = useCallback(
    (value: SetStateAction<IceConfigResponse | null>) =>
      dispatch({ type: "set", key: "iceConfig", value }),
    []
  );
  const setIceConfigResolved = useCallback(
    (value: SetStateAction<boolean>) =>
      dispatch({ type: "set", key: "iceConfigResolved", value }),
    []
  );
  const setActiveDashboardTab = useCallback(
    (value: SetStateAction<RoomPageState["activeDashboardTab"]>) =>
      dispatch({ type: "set", key: "activeDashboardTab", value }),
    []
  );
  const setIsDiagnosticsPanelOpen = useCallback(
    (value: SetStateAction<boolean>) =>
      dispatch({ type: "set", key: "isDiagnosticsPanelOpen", value }),
    []
  );
  const setIsPageVisible = useCallback(
    (value: SetStateAction<boolean>) => dispatch({ type: "set", key: "isPageVisible", value }),
    []
  );
  const setVolume = useCallback(
    (value: SetStateAction<number>) => dispatch({ type: "set", key: "volume", value }),
    []
  );
  const setPlayerResetEpoch = useCallback(
    (value: SetStateAction<number>) => dispatch({ type: "set", key: "playerResetEpoch", value }),
    []
  );
  const setAudioUnlocked = useCallback(
    (value: SetStateAction<boolean>) => dispatch({ type: "set", key: "audioUnlocked", value }),
    []
  );
  const setAudioBlockedOverlay = useCallback(
    (value: SetStateAction<boolean>) =>
      dispatch({ type: "set", key: "audioBlockedOverlay", value }),
    []
  );

  return {
    ...state,
    setAvailableRooms,
    setPlaylists,
    setConnectedPeers,
    setMediaConnectedPeers,
    setSuppressRoomRecovery,
    setIsRecoveringRoom,
    setIsNavigatingRoomExit,
    setIceConfig,
    setIceConfigResolved,
    setActiveDashboardTab,
    setIsDiagnosticsPanelOpen,
    setIsPageVisible,
    setVolume,
    setPlayerResetEpoch,
    setAudioUnlocked,
    setAudioBlockedOverlay
  };
}
