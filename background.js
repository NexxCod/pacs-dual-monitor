const URL_PATTERN = "/ImageViewer/layout";
const repositionedWindows = new Set();

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
      `  [${i}] "${d.name}" primary=${d.isPrimary} bounds=${JSON.stringify(d.bounds)}`
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

  const left = Math.min(d1.bounds.left, d2.bounds.left);
  const top = Math.min(d1.bounds.top, d2.bounds.top);
  const right = Math.max(
    d1.bounds.left + d1.bounds.width,
    d2.bounds.left + d2.bounds.width
  );
  const bottom = Math.max(
    d1.bounds.top + d1.bounds.height,
    d2.bounds.top + d2.bounds.height
  );

  const bounds = { left, top, width: right - left, height: bottom - top };
  console.log("[PACS] Target bounds:", JSON.stringify(bounds));

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

  // Step 1: Ensure normal state (not maximized)
  console.log("[PACS] Step 1: Setting state to normal...");
  await chrome.windows.update(targetWindowId, { state: "normal" });
  await delay(150);

  // Step 2: Move to the correct position first
  console.log("[PACS] Step 2: Moving to position...");
  await chrome.windows.update(targetWindowId, {
    left: bounds.left,
    top: bounds.top,
  });
  await delay(150);

  // Step 3: Now resize — Chrome should allow spanning since the
  // window origin is already on the target monitor
  console.log("[PACS] Step 3: Resizing to span both monitors...");
  await chrome.windows.update(targetWindowId, {
    width: bounds.width,
    height: bounds.height,
  });
  await delay(150);

  // Step 4: Final correction — re-apply everything together
  console.log("[PACS] Step 4: Final position correction...");
  await chrome.windows.update(targetWindowId, {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  });

  // Verify final state
  const finalWin = await chrome.windows.get(targetWindowId);
  console.log("[PACS] Final window state:", JSON.stringify({
    left: finalWin.left,
    top: finalWin.top,
    width: finalWin.width,
    height: finalWin.height,
  }));
  console.log("[PACS] Expected:", JSON.stringify(bounds));

  if (finalWin.width < bounds.width - 50) {
    console.warn("[PACS] ⚠️ Chrome capped the width! Got", finalWin.width, "expected", bounds.width);
  }

  repositionedWindows.add(targetWindowId);
  console.log("[PACS] Done!");
}
