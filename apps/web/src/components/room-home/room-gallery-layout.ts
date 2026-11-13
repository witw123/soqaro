import type { RoomDirectoryItem, RoomType } from "@soqaro/shared";

export type RoomFilterValue = "all" | RoomType;

export const ROOM_FILTER_ORDER: readonly RoomFilterValue[] = [
  "all",
  "interactive",
  "request",
  "radio"
];

export type RoomChannelSignalTheme = {
  accent: string;
  softBg: string;
  border: string;
  topLine: string;
};

export const ROOM_CHANNEL_THEMES: Record<RoomFilterValue, RoomChannelSignalTheme> = {
  all: {
    accent: "var(--accent)",
    softBg: "color-mix(in srgb, var(--accent) 14%, transparent)",
    border: "color-mix(in srgb, var(--accent) 42%, transparent)",
    topLine:
      "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--accent) 65%, transparent) 30%, color-mix(in srgb, var(--accent-hover) 55%, transparent) 70%, transparent 100%)"
  },
  interactive: {
    accent: "var(--blue-9)",
    softBg: "color-mix(in srgb, var(--blue-9) 14%, transparent)",
    border: "color-mix(in srgb, var(--blue-9) 45%, transparent)",
    topLine:
      "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--blue-9) 75%, transparent) 50%, transparent 100%)"
  },
  request: {
    accent: "#ab4aba",
    softBg: "rgba(171, 74, 186, 0.14)",
    border: "rgba(171, 74, 186, 0.45)",
    topLine: "linear-gradient(90deg, transparent 0%, rgba(171, 74, 186, 0.75) 50%, transparent 100%)"
  },
  radio: {
    accent: "#00a2c7",
    softBg: "rgba(0, 162, 199, 0.14)",
    border: "rgba(0, 162, 199, 0.45)",
    topLine: "linear-gradient(90deg, transparent 0%, rgba(0, 162, 199, 0.75) 50%, transparent 100%)"
  }
};

export type MosaicTileSpan = {
  lgSpan: 3 | 4 | 5 | 6 | 7;
  mdSpan: 3 | 4 | 5 | 6 | 8;
};

export type MosaicPackedRoom = {
  item: RoomDirectoryItem;
  span: MosaicTileSpan;
  textScore: number;
  isLgRowEnd: boolean;
  isLgRowBottom: boolean;
  isMdRowEnd: boolean;
  isMdRowBottom: boolean;
  isMobileBottom: boolean;
};

const DESKTOP_TRIPLE_ROWS: ReadonlyArray<readonly [3 | 4 | 5, 3 | 4 | 5, 3 | 4 | 5]> = [
  [5, 4, 3], // seams at 5, 9
  [3, 5, 4], // seams at 3, 8
  [4, 3, 5]  // seams at 4, 7
];

/**
 * Computes visual character width (CJK / full-width = 2, ASCII = 1).
 */
export function measureVisualTextLength(text: string | null | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  let total = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    total += code > 0xff ? 2 : 1;
  }
  return total;
}

/**
 * Scores a room's textual density from its own title length and description length
 * (in CJK-character equivalents: 1 CJK char = 1 unit, 1 ASCII char = 0.5 unit)
 * so longer-copy rooms receive wider mosaic slots (`5`–`7` cols) and short-copy rooms
 * receive compact slots (`3` cols) without wasted blank space.
 */
export function computeRoomTextScore(item: RoomDirectoryItem): number {
  const { room } = item;
  const titleChars = measureVisualTextLength(room.name) / 2;
  const descChars = measureVisualTextLength(room.description) / 2;

  return titleChars * 1.5 + descChars;
}

/**
 * Computes an interlocking Bento Mosaic span pattern for `count` cards:
 * - Cycles through `[5, 4, 3] -> [3, 5, 4] -> [4, 3, 5]` on 12-column desktop grids
 *   so vertical seams never align across consecutive rows.
 * - Seals tail rows (`count % 3 === 1` or `2`) into full 12-column paired rows
 *   (`[6, 6]`, `[7, 5]`, `[5, 7]`) so the outer mosaic boundary is always flush.
 */
export function resolveMosaicSpanPattern(count: number): MosaicTileSpan[] {
  if (count <= 0) return [];

  if (count === 1) {
    return [{ lgSpan: 6, mdSpan: 6 }];
  }

  if (count === 2) {
    return [
      { lgSpan: 7, mdSpan: 5 },
      { lgSpan: 5, mdSpan: 3 }
    ];
  }

  const lgSpans: Array<3 | 4 | 5 | 6 | 7> = [];
  const remainder = count % 3;

  if (remainder === 0) {
    const fullTriples = count / 3;
    for (let row = 0; row < fullTriples; row += 1) {
      lgSpans.push(...DESKTOP_TRIPLE_ROWS[row % DESKTOP_TRIPLE_ROWS.length]!);
    }
  } else if (remainder === 2) {
    const fullTriples = (count - 2) / 3;
    for (let row = 0; row < fullTriples; row += 1) {
      lgSpans.push(...DESKTOP_TRIPLE_ROWS[row % DESKTOP_TRIPLE_ROWS.length]!);
    }
    const lastRowMod = (fullTriples - 1 + DESKTOP_TRIPLE_ROWS.length) % DESKTOP_TRIPLE_ROWS.length;
    if (lastRowMod === 0) {
      lgSpans.push(7, 5);
    } else if (lastRowMod === 1) {
      lgSpans.push(5, 7);
    } else {
      lgSpans.push(6, 6);
    }
  } else {
    const fullTriples = (count - 4) / 3;
    for (let row = 0; row < fullTriples; row += 1) {
      lgSpans.push(...DESKTOP_TRIPLE_ROWS[row % DESKTOP_TRIPLE_ROWS.length]!);
    }
    const lastRowMod =
      fullTriples > 0
        ? (fullTriples - 1) % DESKTOP_TRIPLE_ROWS.length
        : -1;
    if (lastRowMod === 0) {
      lgSpans.push(6, 6, 7, 5);
    } else if (lastRowMod === 1) {
      lgSpans.push(6, 6, 5, 7);
    } else {
      lgSpans.push(5, 7, 7, 5);
    }
  }

  const mdSpans: Array<3 | 4 | 5 | 6 | 8> = [];
  const mdPairs = Math.floor(count / 2);
  for (let pairIndex = 0; pairIndex < mdPairs; pairIndex += 1) {
    if (pairIndex % 2 === 0) {
      mdSpans.push(5, 3);
    } else {
      mdSpans.push(3, 5);
    }
  }
  if (count % 2 === 1) {
    mdSpans.push(8);
  }

  return lgSpans.map((lgSpan, index) => ({
    lgSpan,
    mdSpan: mdSpans[index] ?? 4
  }));
}

/**
 * Content-aware Bento Mosaic packer:
 * Partitions curated rooms into 12-column mosaic rows (`[5,4,3]`, `[3,5,4]`, `[4,3,5]`,
 * and paired tail rows) and assigns each room within a row to the slot width that matches
 * its title + description length rank (longest copy -> widest slot, shortest copy -> compact slot),
 * while preserving the away room in the very first slot if present.
 */
export function packRoomsIntoContentMosaic(
  rooms: readonly RoomDirectoryItem[],
  awayRoomId?: string | null
): MosaicPackedRoom[] {
  const count = rooms.length;
  if (count === 0) return [];

  const spans = resolveMosaicSpanPattern(count);
  const scored = rooms.map((item) => ({
    item,
    textScore: computeRoomTextScore(item),
    isAway: Boolean(awayRoomId && item.room.id === awayRoomId)
  }));

  // Walk row by row (each row sums to 12 on lg, or single card when count === 1)
  const result: MosaicPackedRoom[] = [];
  let cursor = 0;

  while (cursor < count) {
    let rowSum = 0;
    let rowEnd = cursor;
    while (rowEnd < count && rowSum + spans[rowEnd]!.lgSpan <= 12) {
      rowSum += spans[rowEnd]!.lgSpan;
      rowEnd += 1;
      if (rowSum === 12) break;
    }

    const rowLength = Math.max(1, rowEnd - cursor);
    const rowItems = scored.slice(cursor, cursor + rowLength);
    const rowSpans = spans.slice(cursor, cursor + rowLength);

    if (rowLength === 1) {
      result.push({
        item: rowItems[0]!.item,
        span: rowSpans[0]!,
        textScore: rowItems[0]!.textScore,
        isLgRowEnd: false,
        isLgRowBottom: false,
        isMdRowEnd: false,
        isMdRowBottom: false,
        isMobileBottom: false
      });
    } else {
      // Match items to row slot spans by textScore rank:
      // Longest title+description gets the widest lgSpan in this row;
      // shortest title+description gets the narrowest lgSpan in this row.
      // If the row contains the active awayRoom at index 0, keep it at slot 0.
      const slotIndices = Array.from({ length: rowLength }, (_, idx) => idx);
      const placed: Array<(typeof rowItems)[number] | null> = new Array(rowLength).fill(null);
      const remainingItems = [...rowItems];

      if (remainingItems[0]?.isAway) {
        placed[0] = remainingItems.shift()!;
      }

      const availableSlots = slotIndices
        .filter((slotIdx) => placed[slotIdx] === null)
        .sort((a, b) => rowSpans[b]!.lgSpan - rowSpans[a]!.lgSpan);

      const sortedByTextLength = remainingItems
        .map((entry, rowOrder) => ({
          entry,
          rowOrder,
          band: Math.floor(entry.textScore / 10)
        }))
        .sort((a, b) => b.band - a.band || a.rowOrder - b.rowOrder)
        .map((wrapped) => wrapped.entry);

      for (let i = 0; i < availableSlots.length; i += 1) {
        const targetSlot = availableSlots[i]!;
        placed[targetSlot] = sortedByTextLength[i]!;
      }

      for (let slotIdx = 0; slotIdx < rowLength; slotIdx += 1) {
        const entry = placed[slotIdx]!;
        result.push({
          item: entry.item,
          span: rowSpans[slotIdx]!,
          textScore: entry.textScore,
          isLgRowEnd: false,
          isLgRowBottom: false,
          isMdRowEnd: false,
          isMdRowBottom: false,
          isMobileBottom: false
        });
      }
    }

    cursor += rowLength;
  }

  // Annotate desktop (lg: 12-col) row-end and bottom-row boundaries
  let lgSum = 0;
  for (let i = 0; i < count; i += 1) {
    lgSum += result[i]!.span.lgSpan;
    if (lgSum >= 12 || i === count - 1) {
      result[i]!.isLgRowEnd = true;
      lgSum = 0;
    }
  }

  let lastLgSum = 0;
  for (let i = count - 1; i >= 0; i -= 1) {
    result[i]!.isLgRowBottom = true;
    lastLgSum += result[i]!.span.lgSpan;
    if (lastLgSum >= 12) break;
  }

  // Annotate tablet (md: 8-col) row-end and bottom-row boundaries
  let mdSum = 0;
  for (let i = 0; i < count; i += 1) {
    mdSum += result[i]!.span.mdSpan;
    if (mdSum >= 8 || i === count - 1) {
      result[i]!.isMdRowEnd = true;
      mdSum = 0;
    }
  }

  let lastMdSum = 0;
  for (let i = count - 1; i >= 0; i -= 1) {
    result[i]!.isMdRowBottom = true;
    lastMdSum += result[i]!.span.mdSpan;
    if (lastMdSum >= 8) break;
  }

  // Annotate mobile bottom boundary (single-column layout)
  for (let i = 0; i < count; i += 1) {
    result[i]!.isMobileBottom = i === count - 1;
  }

  return result;
}

export function isRoomActivelyPlaying(item: RoomDirectoryItem): boolean {
  const { room } = item;
  return room.playbackStatus === "playing" || room.directoryBroadcastState === "on_air";
}

/**
 * Deterministic curatorial ranking:
 * 1. Away room currently synced in background (immediate return path)
 * 2. Actively playing / broadcasting rooms before idle rooms
 * 3. Higher online listener count
 * 4. Deeper active queue / pending request activity as tie-breaker
 */
export function sortCuratedRooms(
  rooms: readonly RoomDirectoryItem[],
  awayRoomId?: string | null
): RoomDirectoryItem[] {
  return [...rooms].sort((left, right) => {
    const leftIsAway = Boolean(awayRoomId && left.room.id === awayRoomId);
    const rightIsAway = Boolean(awayRoomId && right.room.id === awayRoomId);
    if (leftIsAway !== rightIsAway) return leftIsAway ? -1 : 1;

    const leftActive = isRoomActivelyPlaying(left);
    const rightActive = isRoomActivelyPlaying(right);
    if (leftActive !== rightActive) return leftActive ? -1 : 1;

    const onlineDiff =
      right.room.directoryOnlineMemberCount - left.room.directoryOnlineMemberCount;
    if (onlineDiff !== 0) return onlineDiff;

    const activityLeft =
      left.room.directoryQueueDepth + left.room.directoryPendingRequestCount;
    const activityRight =
      right.room.directoryQueueDepth + right.room.directoryPendingRequestCount;
    return activityRight - activityLeft;
  });
}

export function countRoomsByFilter(
  rooms: readonly RoomDirectoryItem[]
): Record<RoomFilterValue, number> {
  const counts: Record<RoomFilterValue, number> = {
    all: rooms.length,
    interactive: 0,
    request: 0,
    radio: 0
  };

  for (const item of rooms) {
    counts[item.room.roomType] += 1;
  }

  return counts;
}

function areNowPlayingEqual(
  left: RoomDirectoryItem["room"]["directoryNowPlaying"],
  right: RoomDirectoryItem["room"]["directoryNowPlaying"]
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.title === right.title &&
    left.artist === right.artist &&
    left.artworkUrl === right.artworkUrl
  );
}

export function areRoomDirectoryItemsEqual(
  left: RoomDirectoryItem,
  right: RoomDirectoryItem
): boolean {
  if (left === right) return true;
  const a = left.room;
  const b = right.room;
  return (
    a.id === b.id &&
    a.joinCode === b.joinCode &&
    a.name === b.name &&
    a.description === b.description &&
    a.hasPassword === b.hasPassword &&
    a.visibility === b.visibility &&
    a.roomType === b.roomType &&
    a.directoryHostNickname === b.directoryHostNickname &&
    a.directoryMemberCount === b.directoryMemberCount &&
    a.directoryOnlineMemberCount === b.directoryOnlineMemberCount &&
    a.directoryIsMember === b.directoryIsMember &&
    a.directoryQueueDepth === b.directoryQueueDepth &&
    a.directoryPendingRequestCount === b.directoryPendingRequestCount &&
    a.directoryBroadcastState === b.directoryBroadcastState &&
    a.playbackStatus === b.playbackStatus &&
    areNowPlayingEqual(a.directoryNowPlaying, b.directoryNowPlaying)
  );
}

/**
 * Reuses existing `RoomDirectoryItem` object references for unchanged rooms and
 * returns the previous array reference when order and fields are identical so
 * periodic directory polling does not defeat `memo(RoomDirectoryCard)`.
 */
export function reconcileRoomDirectoryItems(
  prev: readonly RoomDirectoryItem[],
  next: readonly RoomDirectoryItem[]
): RoomDirectoryItem[] {
  if (next.length === 0) {
    return prev.length === 0 ? (prev as RoomDirectoryItem[]) : [];
  }

  const prevById = new Map<string, RoomDirectoryItem>();
  for (const item of prev) {
    prevById.set(item.room.id, item);
  }

  let allSame = prev.length === next.length;
  const reconciled = new Array<RoomDirectoryItem>(next.length);

  for (let i = 0; i < next.length; i += 1) {
    const candidate = next[i]!;
    const previous = prevById.get(candidate.room.id);
    if (previous && areRoomDirectoryItemsEqual(previous, candidate)) {
      reconciled[i] = previous;
      if (allSame && prev[i] !== previous) {
        allSame = false;
      }
    } else {
      reconciled[i] = candidate;
      allSame = false;
    }
  }

  return allSame ? (prev as RoomDirectoryItem[]) : reconciled;
}

export function toSafeViewTransitionToken(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function formatRoomLiveMetric(item: RoomDirectoryItem): {
  label: string;
  value: string;
} {
  const { room } = item;
  if (room.roomType === "request") {
    return {
      label: "点歌动态",
      value:
        room.directoryPendingRequestCount > 0
          ? `待处理 ${room.directoryPendingRequestCount} / 队列 ${room.directoryQueueDepth}`
          : `队列 ${room.directoryQueueDepth} 首`
    };
  }

  if (room.roomType === "radio") {
    return {
      label: "电台信号",
      value: room.directoryBroadcastState === "on_air" ? "正在播出" : "待机静默"
    };
  }

  return {
    label: "共享队列",
    value: `${room.directoryQueueDepth} 首曲目`
  };
}
