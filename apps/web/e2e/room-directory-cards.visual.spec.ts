import { expect, test, type Page } from "@playwright/test";
import { authorizeStorageRoot, stubStorageRootPicker } from "./storage-root";

const session = {
  id: "session_directory_visual",
  userId: "user_directory_visual",
  username: "directory_visual",
  nickname: "夜航主持",
  token: "visual-test-token",
  createdAt: "2026-08-15T00:00:00.000Z"
};

const rooms = [
  {
    room: {
      id: "room_interactive",
      joinCode: "SYNC01",
      name: "深夜共听局",
      description: "一起听歌、聊天，把下一首交给房间。",
      hasPassword: false,
      visibility: "public",
      roomType: "interactive",
      radioAutopilot: { enabled: false },
      directoryHostNickname: "夜航主持",
      directoryMemberCount: 12,
      directoryOnlineMemberCount: 12,
      directoryIsMember: false,
      directoryQueueDepth: 4,
      directoryPendingRequestCount: 0,
      directoryBroadcastState: null,
      directoryNowPlaying: {
        title: "Midnight City",
        artist: "M83",
        artworkUrl: null
      },
      playbackStatus: "playing"
    }
  },
  {
    room: {
      id: "room_request",
      joinCode: "REQ002",
      name: "星空点歌台",
      description: "你点歌，我来放。",
      hasPassword: false,
      visibility: "public",
      roomType: "request",
      radioAutopilot: { enabled: false },
      directoryHostNickname: "夜航主持",
      directoryMemberCount: 8,
      directoryOnlineMemberCount: 8,
      directoryIsMember: false,
      directoryQueueDepth: 3,
      directoryPendingRequestCount: 5,
      directoryBroadcastState: null,
      directoryNowPlaying: {
        title: "The Less I Know The Better",
        artist: "Tame Impala",
        artworkUrl: null
      },
      playbackStatus: "playing"
    }
  },
  {
    room: {
      id: "room_radio",
      joinCode: "AIR003",
      name: "音乐自由台",
      description: "主持人策展播出，陪你听完这一段夜色。",
      hasPassword: false,
      visibility: "public",
      roomType: "radio",
      radioAutopilot: { enabled: false },
      directoryHostNickname: "夜航主持",
      directoryMemberCount: 6,
      directoryOnlineMemberCount: 6,
      directoryIsMember: false,
      directoryQueueDepth: 7,
      directoryPendingRequestCount: 0,
      directoryBroadcastState: "on_air",
      directoryNowPlaying: {
        title: "Everybody Wants To Rule The World",
        artist: "Tears For Fears",
        artworkUrl: null
      },
      playbackStatus: "playing"
    }
  }
];

async function mockDirectoryApi(page: Page) {
  // Single catch-all handler for every /v1 request. Stray authenticated calls
  // (personalization, activities, …) must NOT reach the real server: a live
  // 401 dispatches the auth-expired event, which wipes the mocked session and
  // redirects the page to the login screen mid-test.
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/v1/auth/me")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(session) });
      return;
    }
    if (pathname.endsWith("/v1/rooms")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(rooms) });
      return;
    }
    if (pathname.endsWith("/v1/auth/config")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ enabled: false, siteKey: "" }) });
      return;
    }
    if (pathname.endsWith("/v1/playlists")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify([]) });
      return;
    }
    if (pathname.includes("/v1/rooms/recent")) {
      await route.fulfill({ contentType: "application/json", body: "null" });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "not_found", message: "Not mocked in this e2e scenario." } })
    });
  });
}

test("room directory cards match the visual hierarchy at desktop and mobile", async ({ page }, testInfo) => {
  await stubStorageRootPicker(page);
  await mockDirectoryApi(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app");
  const cards = page.getByTestId("room-directory-card");
  await authorizeStorageRoot(page, cards.first());
  await expect(cards).toHaveCount(3);
  await expect(page.locator('[data-room-type="interactive"] [data-card-scene="interactive"]')).toBeVisible();
  await expect(page.locator('[data-room-type="request"] [data-card-scene="request"]')).toBeVisible();
  await expect(page.locator('[data-room-type="radio"] [data-card-scene="radio"]')).toBeVisible();
  await expect(page.getByText("点歌审核", { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-room-type="request"]')).toContainText("点歌房");

  for (const card of await cards.all()) {
    await expect(card.getByText(/\d+ 人在线/)).toHaveCount(1);
    await expect(card.locator('[data-testid="room-directory-online-members"]')).toHaveCount(0);
    await expect(card.getByTestId("room-directory-open")).toBeVisible();
    await expect(card.getByText(/OFF AIR|正在收集点歌|等待下一首/)).toHaveCount(0);
  }

  await page.screenshot({ path: testInfo.outputPath("room-directory-reference-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cards.first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("room-directory-reference-mobile.png"), fullPage: true });

  await cards.first().getByTestId("room-directory-open").click();
  await expect(page.getByRole("dialog")).toContainText(rooms[0].room.name);
});

test("room directory grid and threshold sheet preserve clean hierarchy across short and long content", async ({ page }, testInfo) => {
  const manyRooms = Array.from({ length: 10 }, (_, index) => {
    const roomTypes = ["interactive", "request", "radio"] as const;
    const isProgRockRoom = index === 0;
    const isShortBioRoom = index === 1;
    const roomType = isProgRockRoom || isShortBioRoom ? "interactive" : roomTypes[index % 3]!;
    const variedDescriptions = [
      "多人实时同步收听，共享深夜曲库。",
      "黑胶母带与合成器浪潮连播，适合深夜写代码与专注工作时收听。",
      "即兴点歌。",
      "后摇滚与独立流行专题夜，欢迎投递你私藏的冷门现场版本与器乐曲目。",
      "周末晚间自由广播，主理人实时混音。",
      "纯音乐轻听。",
      "爵士融合与复古都市流行精选，从傍晚日落一直播放到午夜收台。",
      "安静听歌。"
    ];
    return {
      room: {
        id: `room_multi_${index + 1}`,
        joinCode: isShortBioRoom ? "MKRDDD" : `GAL0${String(index + 1).padStart(2, "0")}`,
        name: isProgRockRoom
          ? "前卫摇滚听歌房"
          : isShortBioRoom
            ? "系错听歌房 (原XICBGM)"
            : `夜航声学展厅 ${index + 1}`,
        description: isProgRockRoom
          ? "听点前卫的（以及器乐长篇组曲鉴赏）。可作为通勤、工作、学习或睡觉时的背景音乐，适合于沙发、电梯间、候车厅、咖啡馆、理发店等地点。"
          : isShortBioRoom
            ? "随机播放，可以刷歌"
            : variedDescriptions[(index - 2) % variedDescriptions.length]!,
        hasPassword: false,
        visibility: "public" as const,
        roomType,
        directoryHostNickname: isProgRockRoom || isShortBioRoom ? "系错" : "夜航主持",
        directoryMemberCount: 16 - index,
        directoryOnlineMemberCount: isShortBioRoom ? 0 : Math.max(1, 16 - index),
        directoryIsMember: false,
        directoryQueueDepth: isShortBioRoom ? 56 : (index + 1) * 3,
        directoryPendingRequestCount: roomType === "request" ? 2 : 0,
        directoryBroadcastState: roomType === "radio" ? ("on_air" as const) : null,
        directoryNowPlaying: {
          title: isProgRockRoom
            ? "I. The Solid Time of Change, II. Total Mass Retain, III. I Get up I Get Down, IV. Seasons of Man"
            : isShortBioRoom
              ? "Your Eyes"
              : `Track Sequence ${index + 1}`,
          artist: isProgRockRoom ? "Yes" : isShortBioRoom ? "山下達郎" : "M83",
          artworkUrl: null
        },
        playbackStatus: "playing" as const
      }
    };
  });

  await stubStorageRootPicker(page);
  await page.route("**/v1/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/v1/auth/me")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(session) });
      return;
    }
    if (pathname.endsWith("/v1/rooms")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(manyRooms) });
      return;
    }
    if (pathname.endsWith("/v1/auth/config")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ enabled: false, siteKey: "" }) });
      return;
    }
    if (pathname.endsWith("/v1/playlists")) {
      await route.fulfill({ contentType: "application/json", body: JSON.stringify([]) });
      return;
    }
    if (pathname.includes("/v1/rooms/recent")) {
      await route.fulfill({ contentType: "application/json", body: "null" });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "not_found", message: "Not mocked in this e2e scenario." } })
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app");
  const cards = page.getByTestId("room-directory-card");
  await authorizeStorageRoot(page, cards.first());
  await expect(cards).toHaveCount(10);

  const canvasTray = page.getByTestId("room-mosaic-canvas-tray");
  await expect(canvasTray).toBeVisible();

  const grid = page.getByTestId("room-directory-grid");
  await expect(grid).toBeVisible();

  // Verify Bento Mosaic interlocking row geometry (5:4:3 on Row 1, 3:5:4 on Row 2, flush heights)
  const mosaicGeometry = await grid.evaluate((gridEl) => {
    const tiles = Array.from(gridEl.querySelectorAll<HTMLElement>("[data-mosaic-slot-id]"));
    const rects = tiles.slice(0, 6).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        span: Number(el.dataset.mosaicSpan),
        left: Math.round(r.left),
        right: Math.round(r.right),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        width: Math.round(r.width),
        height: Math.round(r.height)
      };
    });
    return rects;
  });

  expect(mosaicGeometry.map((t) => t.span)).toEqual([5, 4, 3, 3, 5, 4]);
  // Row 1 tiles share identical top and bottom edges and descending widths (5 > 4 > 3)
  expect(Math.abs(mosaicGeometry[0]!.top - mosaicGeometry[1]!.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(mosaicGeometry[1]!.top - mosaicGeometry[2]!.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(mosaicGeometry[0]!.bottom - mosaicGeometry[2]!.bottom)).toBeLessThanOrEqual(1);
  expect(mosaicGeometry[0]!.width).toBeGreaterThan(mosaicGeometry[1]!.width + 30);
  expect(mosaicGeometry[1]!.width).toBeGreaterThan(mosaicGeometry[2]!.width + 30);
  // Row 1 and Row 2 vertical seams are staggered (Row 1 first right edge != Row 2 first right edge)
  expect(Math.abs(mosaicGeometry[0]!.right - mosaicGeometry[3]!.right)).toBeGreaterThan(40);
  // Row 1 and Row 2 outer left and right edges are 100% flush
  expect(Math.abs(mosaicGeometry[0]!.left - mosaicGeometry[3]!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(mosaicGeometry[2]!.right - mosaicGeometry[5]!.right)).toBeLessThanOrEqual(1);
  // Zero-gap flush borders: adjacent horizontal and vertical tiles touch tightly with 0px gap
  expect(Math.abs(mosaicGeometry[0]!.right - mosaicGeometry[1]!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(mosaicGeometry[1]!.right - mosaicGeometry[2]!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(mosaicGeometry[3]!.right - mosaicGeometry[4]!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(mosaicGeometry[4]!.right - mosaicGeometry[5]!.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(mosaicGeometry[0]!.bottom - mosaicGeometry[3]!.top)).toBeLessThanOrEqual(1);

  // 1. Inspect long-description + long-track-title room on desktop
  await cards.first().getByTestId("room-directory-open").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("前卫摇滚听歌房");
  await expect(dialog).toContainText("适合于沙发、电梯间、候车厅、咖啡馆、理发店等地点");
  await expect(dialog.getByText("收起")).toHaveCount(0);
  await expect(dialog.getByText("公开直入")).toHaveCount(0);

  const metrics = await dialog.evaluate((dialogEl) => {
    const artworkEl = dialogEl.querySelector('[data-testid="room-threshold-artwork"]') as HTMLElement | null;
    const confirmBtn = dialogEl.querySelector('[data-testid="room-entry-confirm"]') as HTMLElement | null;
    const dialogRect = dialogEl.getBoundingClientRect();
    const artRect = artworkEl?.getBoundingClientRect();
    const btnRect = confirmBtn?.getBoundingClientRect();
    return {
      dialogWidth: dialogRect.width,
      scrollWidth: dialogEl.scrollWidth,
      clientWidth: dialogEl.clientWidth,
      artworkSquareDelta: artRect ? Math.abs(artRect.width - artRect.height) : 999,
      artworkSize: artRect ? artRect.width : 0,
      btnHorizontal: btnRect ? btnRect.width > btnRect.height * 1.6 : false
    };
  });

  expect(metrics.dialogWidth).toBeLessThanOrEqual(440);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.artworkSquareDelta).toBeLessThanOrEqual(1);
  expect(metrics.artworkSize).toBeGreaterThanOrEqual(40);
  expect(metrics.btnHorizontal).toBe(true);

  await page.screenshot({ path: testInfo.outputPath("room-threshold-long-title-desktop.png") });

  // 2. Inspect mobile modal rendering in the same batched pass
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog).toBeVisible();
  const mobileMetrics = await dialog.evaluate((dialogEl) => {
    const rect = dialogEl.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
      scrollWidth: dialogEl.scrollWidth,
      clientWidth: dialogEl.clientWidth
    };
  });
  expect(mobileMetrics.left).toBeGreaterThanOrEqual(12);
  expect(mobileMetrics.right).toBeLessThanOrEqual(378);
  expect(mobileMetrics.scrollWidth).toBeLessThanOrEqual(mobileMetrics.clientWidth + 1);
  await page.screenshot({ path: testInfo.outputPath("room-threshold-mobile.png") });

  // 3. Switch back to desktop and inspect short-description room (zero dead space check)
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toHaveCount(0);

  const shortCard = cards.filter({ hasText: "系错听歌房 (原XICBGM)" });
  await shortCard.getByTestId("room-directory-open").click();
  await expect(dialog).toContainText("系错听歌房 (原XICBGM)");
  await expect(dialog).toContainText("随机播放，可以刷歌");
  await expect(dialog).toContainText("Your Eyes");
  await expect(dialog).toContainText("56 首曲目");
  await expect(dialog).toContainText("房主");
  await expect(dialog).toContainText("系错");
  await expect(dialog).toContainText("进入房间");

  await page.screenshot({ path: testInfo.outputPath("room-threshold-short-bio-desktop.png") });

  // 4. Close dialog and test room card transition across filters with bottom player layered on top
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toHaveCount(0);

  const bottomPlayer = page.getByTestId("bottom-player");
  await expect(bottomPlayer).toBeVisible();

  // Switch filter to "点歌房" (triggers room-view-transition "gallery")
  const requestTab = page.getByRole("tab", { name: /点歌房/ });
  await requestTab.click();

  // Verify filtered card count
  const filteredCards = page.getByTestId("room-directory-card");
  await expect(filteredCards).toHaveCount(2);

  // Switch back to "全部" (triggers card entrance and layout transition)
  const allTab = page.getByRole("tab", { name: /全部/ });
  await allTab.click();
  await expect(filteredCards).toHaveCount(10);

  // Ensure bottom player remains visible and positioned cleanly
  await expect(bottomPlayer).toBeVisible();
  const playerRect = await bottomPlayer.boundingBox();
  expect(playerRect).not.toBeNull();
  expect(playerRect!.y + playerRect!.height).toBeGreaterThanOrEqual(990);

  await page.screenshot({ path: testInfo.outputPath("room-filter-transition-desktop.png") });
});
