const URL_PATTERN = "/ImageViewer/layout";
const repositionedWindows = new Set();

// Windows has invisible resize borders (~7px on left, right, bottom).
// If ves un margen residual o la ventana se pasa del borde, ajustar este valor.
const WINDOWS_INVISIBLE_BORDER = 7;

chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;

  const tab = await chrome.tabs.get(details.tabId);
  if (!tab.url || !tab.url.includes(URL_PATTERN)) return;

  if (repositionedWindows.has(tab.windowId)) {
    console.log("[PACS] Window already repositioned, skipping.");
    return;
  }

  console.log(`[PACS] Detected ImageViewer tab: ${details.tabId}, window: ${tab.windowId}`);

  try {
    await moveToDualMonitor(details.tabId, tab.windowId);
  } catch (err) {
    console.error("[PACS] Error:", err);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  repositionedWindows.delete(windowId);
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveToDualMonitor(tabId, windowId) {
  const displays = await chrome.system.display.getInfo();
  console.log("[PACS] Displays found:", displays.length);
  displays.forEach((d, i) => {
    console.log(
      `  [${i}] "${d.name}" primary=${d.isPrimary}`,
      `bounds=${JSON.stringify(d.bounds)}`,
      `workArea=${JSON.stringify(d.workArea)}`
    );
  });

  if (displays.length < 3) {
    console.warn("[PACS] Need at least 3 monitors.");
    return;
  }

  let externals = displays.filter((d) => !d.isPrimary);
  if (externals.length < 2) {
    const sorted = [...displays].sort(
      (a, b) =>
        b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height
    );
    externals = [sorted[0], sorted[1]];
  }

  const [d1, d2] = externals;

  // Use workArea instead of bounds to respect the Windows taskbar.
  // If the taskbar is on the external monitor, workArea excludes it.
  const wa1 = d1.workArea;
  const wa2 = d2.workArea;

  const left = Math.min(wa1.left, wa2.left);
  const top = Math.min(wa1.top, wa2.top);
  const right = Math.max(wa1.left + wa1.width, wa2.left + wa2.width);
  const bottom = Math.max(wa1.top + wa1.height, wa2.top + wa2.height);

  // Compensate for Windows invisible borders:
  // - Shift left by BORDER so the visible edge aligns with the monitor edge
  // - Expand width by 2*BORDER (compensate left + right invisible borders)
  // - Expand height by BORDER (compensate bottom invisible border)
  // - Top stays the same (no invisible border at top)
  const B = WINDOWS_INVISIBLE_BORDER;
  const bounds = {
    left: left - B,
    top: top,
    width: right - left + 2 * B,
    height: bottom - top + B,
  };

  console.log("[PACS] Raw workArea span:", JSON.stringify({ left, top, right, bottom }));
  console.log("[PACS] Target bounds (with border compensation):", JSON.stringify(bounds));

  const win = await chrome.windows.get(windowId);
  let targetWindowId = windowId;

  if (win.type !== "popup") {
    console.log("[PACS] Creating new popup window...");
    const newWindow = await chrome.windows.create({
      tabId: tabId,
      type: "popup",
    });
    targetWindowId = newWindow.id;
    await delay(200);
  }

  // Multi-step positioning to bypass Chrome's per-monitor size cap
  console.log("[PACS] Step 1: state=normal");
  await chrome.windows.update(targetWindowId, { state: "normal" });
  await delay(150);

  console.log("[PACS] Step 2: move to position");
  await chrome.windows.update(targetWindowId, {
    left: bounds.left,
    top: bounds.top,
  });
  await delay(150);

  console.log("[PACS] Step 3: resize to span both monitors");
  await chrome.windows.update(targetWindowId, {
    width: bounds.width,
    height: bounds.height,
  });
  await delay(150);

  console.log("[PACS] Step 4: final correction");
  await chrome.windows.update(targetWindowId, {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  });

  const finalWin = await chrome.windows.get(targetWindowId);
  console.log("[PACS] Final window state:", JSON.stringify({
    left: finalWin.left,
    top: finalWin.top,
    width: finalWin.width,
    height: finalWin.height,
  }));
  console.log("[PACS] Expected:", JSON.stringify(bounds));

  repositionedWindows.add(targetWindowId);
  console.log("[PACS] Done!");
}
