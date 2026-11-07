"use client";

export interface ProgressiveRoomLoadingState {
  stageReady: boolean;
  panelsReady: boolean;
  phase: number;
}

export function useProgressiveRoomLoading(): ProgressiveRoomLoadingState {
  return {
    stageReady: true,
    panelsReady: true,
    phase: 2
  };
}
