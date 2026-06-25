const URL_PATTERN = "/ImageViewer/layout";
const repositionedWindows = new Set();

const WINDOWS_INVISIBLE_BORDER = 7;

// === Config ===
const CLOSE_ORPHAN_VIEWERS = true;
const WORKLIST_HINTS = ["/WebQuery", "/Synapse/Web"];

const MIN_DISPLAYS = 3;
const DISPLAY_RETRY_TRIES = 5;
const DISPLAY_RETRY_DELAY = 400;
const VERIFY_TRIES = 3;
const VERIFY_TOLERANCE_PX = 80;
const VERIFY_MIN_WIDTH_RATIO = 0.6;

// Synapse redimensiona la ventana DESPUES de que la posicionamos (al terminar
// de cargar el visor). Estos "settle checks" re-aplican los bounds varias veces
// en los primeros segundos para ganarle a ese resize tardio.
// Despues de la ultima revision dejamos de intervenir (para no pelear si el
// usuario decide redimensionar a mano).
const SETTLE_CHECKPOINTS_MS = [1000, 2200, 3800, 6000];

// =====================================================================
// 1) Auto: posicionar cuando se CREA el visor (primera vez)
// =====================================================================
chrome.webNavigation.onCompleted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const tab = await chrome.tabs.get(details.tabId);
  if (!tab.url || !tab.url.includes(URL_PATTERN)) return;

  if (repositionedWindows.has(tab.windowId)) {
    if (CLOSE_ORPHAN_VIEWERS) cleanupOrphanViewers(tab.windowId).catch(() => {});
    return;
  }
  console.log(`[PACS] Detected ImageViewer tab: ${details.tabId}, window: ${tab.windowId}`);
  try {
    await moveToDualMonitor(details.tabId, tab.windowId);
    if (CLOSE_ORPHAN_VIEWERS) await cleanupOrphanViewers(tab.windowId);
  } catch (err) {
    console.error("[PACS] Error:", err);
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  repositionedWindows.delete(windowId);
});

// =====================================================================
// 2) Manual: forzar reposicionamiento on-demand (atajo Ctrl+Shift+Y o icono)
// =====================================================================
chrome.commands.onCommand.addListener((command) => {
  if (command === "reposition-viewer") repositionViewerNow();
});
chrome.action.onClicked.addListener(() => repositionViewerNow());

async function findViewerWindow() {
  const wins = await chrome.windows.getAll({ populate: true });
  const candidates = wins.filter((w) =>
    (w.tabs || []).some((t) => t.url && t.url.includes(URL_PATTERN))
  );
  if (candidates.length === 0) return null;
  const focused = candidates.find((w) => w.focused);
  if (focused) return focused;
  candidates.sort((a, b) => b.id - a.id);
  return candidates[0];
}

async function repositionViewerNow() {
  const w = await findViewerWindow();
  if (!w) {
    console.warn("[PACS] No encontre ventana del visor (/ImageViewer/layout) para reposicionar.");
    return;
  }
  const viewerTab = (w.tabs || []).find((t) => t.url && t.url.includes(URL_PATTERN));
  console.log(`[PACS] Reposicion MANUAL de window ${w.id}.`);
  repositionedWindows.delete(w.id);
  try {
    await moveToDualMonitor(viewerTab.id, w.id);
  } catch (e) {
    console.error("[PACS] Error en reposicion manual:", e);
  }
}

// =====================================================================
// 3) Mensajes del content script (lanzadera pegada)
// =====================================================================
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !sender.tab) return;
  if (msg.type === "launcher-stuck") {
    const wid = sender.tab.windowId;
    chrome.windows.get(wid, { populate: true }, (w) => {
      const tabs = (w && w.tabs) || [];
      const onlyLauncher =
        tabs.length === 1 &&
        tabs[0].url &&
        tabs[0].url.includes("winpass=true") &&
        tabs[0].url.includes("/WebQuery/Index");
      if (onlyLauncher) {
        console.log(`[PACS] Cerrando lanzadera pegada (window ${wid}).`);
        chrome.windows.remove(wid).catch((e) => console.warn("[PACS]", e));
      } else {
        console.log(`[PACS] Lanzadera pegada pero la ventana ${wid} tiene mas tabs; no se cierra por seguridad.`);
      }
    });
  }
});

// =====================================================================
// Helpers
// =====================================================================
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getDisplaysWithRetry() {
  let displays = await chrome.system.display.getInfo();
  let attempt = 1;
  while (displays.length < MIN_DISPLAYS && attempt < DISPLAY_RETRY_TRIES) {
    console.log(`[PACS] Solo ${displays.length} monitores, reintentando (${attempt}/${DISPLAY_RETRY_TRIES})...`);
    await delay(DISPLAY_RETRY_DELAY);
    displays = await chrome.system.display.getInfo();
    attempt++;
  }
  return displays;
}

async function cleanupOrphanViewers(keepWindowId) {
  const wins = await chrome.windows.getAll({ populate: true });
  for (const w of wins) {
    if (w.id === keepWindowId) continue;
    const tabs = w.tabs || [];
    const hasViewer = tabs.some((t) => t.url && t.url.includes(URL_PATTERN));
    if (!hasViewer) continue;
    const isWorklist = tabs.some(
      (t) => t.url && WORKLIST_HINTS.some((h) => t.url.includes(h))
    );
    if (isWorklist) {
      console.log(`[PACS] Window ${w.id} tiene worklist, no se cierra.`);
      continue;
    }
    console.log(`[PACS] Cerrando viewer huerfano: window ${w.id}`);
    try {
      await chrome.windows.remove(w.id);
      repositionedWindows.delete(w.id);
    } catch (e) {
      console.warn(`[PACS] No pude cerrar window ${w.id}:`, e);
    }
  }
}

function boundsOK(win, bounds) {
  const widthOK = win.width >= bounds.width * VERIFY_MIN_WIDTH_RATIO;
  const posOK =
    Math.abs(win.left - bounds.left) <= VERIFY_TOLERANCE_PX &&
    Math.abs(win.top - bounds.top) <= VERIFY_TOLERANCE_PX;
  return widthOK && posOK;
}

async function applyBounds(windowId, bounds) {
  await chrome.windows.update(windowId, { state: "normal" });
  await delay(150);
  await chrome.windows.update(windowId, { left: bounds.left, top: bounds.top });
  await delay(150);
  await chrome.windows.update(windowId, { width: bounds.width, height: bounds.height });
  await delay(150);
  await chrome.windows.update(windowId, {
    left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
  });
  await delay(150);
  return chrome.windows.get(windowId);
}

// Re-aplica los bounds en varios momentos para ganarle al resize tardio de Synapse.
function scheduleSettleChecks(windowId, bounds) {
  SETTLE_CHECKPOINTS_MS.forEach((ms) => {
    setTimeout(async () => {
      try {
        const w = await chrome.windows.get(windowId);
        if (!w) return;
        if (boundsOK(w, bounds)) {
          console.log(`[PACS] Settle ${ms}ms: OK (w=${w.width}), sin cambios.`);
          return;
        }
        console.log(`[PACS] Settle ${ms}ms: Synapse la movio (w=${w.width}), re-aplicando bounds.`);
        await applyBounds(windowId, bounds);
      } catch (e) {
        // ventana cerrada / inexistente: ignorar
      }
    }, ms);
  });
}

async function moveToDualMonitor(tabId, windowId) {
  const displays = await getDisplaysWithRetry();
  console.log("[PACS] Displays found:", displays.length);
  displays.forEach((d, i) => {
    console.log(`  [${i}] "${d.name}" primary=${d.isPrimary}`,
      `bounds=${JSON.stringify(d.bounds)}`, `workArea=${JSON.stringify(d.workArea)}`);
  });

  if (displays.length < MIN_DISPLAYS) {
    console.warn(`[PACS] Tras reintentos sigo viendo ${displays.length} monitores (esperaba ${MIN_DISPLAYS}). No reposiciono.`);
    return;
  }

  let externals = displays.filter((d) => !d.isPrimary);
  if (externals.length < 2) {
    const sorted = [...displays].sort(
      (a, b) => b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height
    );
    externals = [sorted[0], sorted[1]];
  }

  const [d1, d2] = externals;
  const wa1 = d1.workArea;
  const wa2 = d2.workArea;
  const left = Math.min(wa1.left, wa2.left);
  const top = Math.min(wa1.top, wa2.top);
  const right = Math.max(wa1.left + wa1.width, wa2.left + wa2.width);
  const bottom = Math.max(wa1.top + wa1.height, wa2.top + wa2.height);

  const B = WINDOWS_INVISIBLE_BORDER;
  const bounds = {
    left: left - B, top: top, width: right - left + 2 * B, height: bottom - top + B,
  };
  console.log("[PACS] Target bounds:", JSON.stringify(bounds));

  const win = await chrome.windows.get(windowId);
  let targetWindowId = windowId;
  if (win.type !== "popup") {
    console.log("[PACS] Creating new popup window...");
    const newWindow = await chrome.windows.create({ tabId: tabId, type: "popup" });
    targetWindowId = newWindow.id;
    await delay(200);
  }

  let finalWin = await applyBounds(targetWindowId, bounds);
  for (let i = 1; i <= VERIFY_TRIES; i++) {
    if (boundsOK(finalWin, bounds)) { console.log(`[PACS] Ventana OK al intento ${i}.`); break; }
    console.warn(`[PACS] Ventana no quedo bien (intento ${i}/${VERIFY_TRIES}). Reintentando.`,
      JSON.stringify({ got: { l: finalWin.left, t: finalWin.top, w: finalWin.width, h: finalWin.height }, want: bounds }));
    await delay(250);
    finalWin = await applyBounds(targetWindowId, bounds);
  }

  console.log("[PACS] Final:", JSON.stringify({
    left: finalWin.left, top: finalWin.top, width: finalWin.width, height: finalWin.height,
  }));

  // Defensa contra el resize tardio de Synapse.
  scheduleSettleChecks(targetWindowId, bounds);

  repositionedWindows.add(targetWindowId);
  console.log("[PACS] Done (settle checks programados).");
}
