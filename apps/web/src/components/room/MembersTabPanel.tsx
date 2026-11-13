"use client";

import { memo, useEffect, useState } from "react";
import type {
  PeerDiagnosticsSnapshot,
  PeerRecentEvent,
  RoomMember,
  RoomMemberPermissions,
  RoomSnapshot
} from "@soqaro/shared";
import type { LocalMemberPanelState } from "./MembersPanel";
import { MembersPanel } from "./MembersPanel";
import { MeshStatusPanel } from "./MeshStatusPanel";

type MembersTabPanelProps = {
  members: RoomMember[];
  now?: number;
  activeSessionId: string | null;
  isHost: boolean;
  onUpdateMemberPermissions: (memberId: string, permissions: RoomMemberPermissions) => Promise<boolean>;
  onRemoveMember: (memberId: string) => Promise<boolean>;
  peerDiagnostics: PeerDiagnosticsSnapshot[];
  peerRecentEvents: PeerRecentEvent[];
  localMemberState: LocalMemberPanelState | null;
  playbackStatus: RoomSnapshot["room"]["playback"]["status"];
  sourceSessionId: string | null;
  sourcePeerId: string | null;
  iceConfigSource: string;
  iceConfigStatus: string;
  onDiagnosticsVisibilityChange?: (open: boolean) => void;
};

function MembersTabPanelBase({
  members,
  now,
  activeSessionId,
  isHost,
  onUpdateMemberPermissions,
  onRemoveMember,
  peerDiagnostics,
  peerRecentEvents,
  localMemberState,
  playbackStatus,
  sourceSessionId,
  sourcePeerId,
  iceConfigSource,
  iceConfigStatus,
  onDiagnosticsVisibilityChange
}: MembersTabPanelProps) {
  const [localNow, setLocalNow] = useState(() => Date.now());

  useEffect(() => {
    if (typeof now === "number") return;
    setLocalNow(Date.now());
    const timer = window.setInterval(() => setLocalNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [now]);

  return (
    <div className="animate-fade-in flex w-full flex-col gap-5">
      <MembersPanel
        members={members}
        now={now ?? localNow}
        activeSessionId={activeSessionId}
        isHost={isHost}
        onUpdateMemberPermissions={onUpdateMemberPermissions}
        onRemoveMember={onRemoveMember}
      />

      <MeshStatusPanel
        members={members}
        activeSessionId={activeSessionId}
        peerDiagnostics={peerDiagnostics}
        localMemberState={localMemberState}
        playbackStatus={playbackStatus}
        sourceSessionId={sourceSessionId}
        sourcePeerId={sourcePeerId}
        recentEvents={peerRecentEvents}
        iceConfigSource={iceConfigSource}
        iceConfigStatus={iceConfigStatus}
        onVisibilityChange={onDiagnosticsVisibilityChange}
      />
    </div>
  );
}

export const MembersTabPanel = memo(MembersTabPanelBase);
