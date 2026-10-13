// background.js — PACS Dual Monitor (service worker MV3)
//
// Dos objetivos:
//
// 1) DIMENSIONES CORRECTAS (mediciones confiables). Synapse exige zoom del
//    navegador y escala de Windows al 100%, y calibra el visor cuando abre el
//    estudio. Si la ventana cambia de monitor/escala/tamano despues de eso, las
//    mediciones y el True Size pueden quedar mal. Por eso:
//    - la ventana se ubica en los dos monitores externos ANTES de que cargue
//      el visor (desde la lanzadera o al empezar la navegacion), no despues;
//    - se bloquea el "restaurar posicion" de Synapse (page-guard.js), que
//      Chrome recorta a un solo monitor y achicaba la ventana a mitad de carga;
//    - una guardia corta (onBoundsChanged) corrige cualquier otro cambio;
//    - zoom de Synapse fijo en 100%;
//    - el visor informa su escala/tamano; si cambiaron despues de inicializar,
//      se recarga solo (si aun no lo usaste) o te avisa con un boton.
//
// 2) QUE EL ESTUDIO ABRA (sin pantalla negra). Cada click en un estudio se
//    sigue hasta confirmar que un visor lo cargo. Si Synapse muestra "abierta
//    en otra ventana": se trae al frente el visor existente y se verifica que
//    el estudio llegue; si no llega (visor zombie) se cierra y se reintenta;
//    si no hay visor (candado pegado) se reintenta con espera creciente; si
//    todo falla, se avisa en pantalla. Tambien se recupera el visor que queda
//    en negro por perdida del contexto grafico o error de red.

importScripts("lib/geometry.js");
const G = self.PacsGeometry;

const HOST = "sjdpacs.synapsetimed.cl";
const NAV_FILTER = { url: [{ hostEquals: HOST }] };
const VIEWER_RE = /\/ImageViewer\/layout/i;
const LAUNCHER_RE = /\/WebQuery\/Index/i;
const WINPASS_RE = /winpass=true/i;

const DEFAULT_SETTINGS = Object.freeze({
  placeViewer: true, // ubicar el visor en los monitores externos
  placeLauncher: true, // ...desde que aparece la lanzadera (recomendado)
  blockPageResize: true, // bloquear moveTo/resizeTo de Synapse
  forceZoom100: true, // zoom de Synapse siempre 100%
  closeOrphanViewers: true, // cerrar visores viejos/zombie
  launcherRecovery: true, // verificar que el estudio abra y recuperar
  autoReload: true, // recargar solo el visor si quedo mal (y no lo usaste)
  showNotices: true, // avisos en pantalla
  singleMonitorFallback: false, // si hay un solo externo, usarlo solo
  invisibleBorder: 7, // borde invisible de Windows (px)
  guardSeconds: 12, // segundos de guardia tras cargar el visor
  displayIds: [], // monitores elegidos a mano ([] = automatico)
});

// Tiempos y umbrales.
const T = {
  exactPx: 3, // diferencia aceptada como "exacto"
  guardDriftPx: 12, // la guardia solo actua sobre cambios mayores
  guardBeforeLoadMs: 45000, // guardia mientras el visor carga
  guardMaxReapplies: 6,
  applyRetries: 2,
  settlePollMs: 40,
  settleMaxMs: 450,
  deliveryWaitMs: 8000, // espera a que el visor existente reciba el estudio
  launcherStuckMs: 20000, // lanzadera sin aviso que no avanza
  launchMaxAttempts: 3,
  retryDelayMs: [0, 1200, 3000, 5000],
  activityTimeoutMs: 1500,
  inUseMs: 5000, // un visor con uso en estos ms no se cierra como huerfano
  reloadCooldownMs: 120000,
  maxAutoReloads: 2,
};

// =====================================================================
// Estado (sobrevive a que Chrome duerma el service worker)
// =====================================================================
const state = { managed: {}, launches: {}, warned: {}, alerts: {} };
let settings = Object.assign({}, DEFAULT_SETTINGS);
// Bordes de la ventana medidos en este equipo ({left, right, bottom, at}).
let learnedInsets = null;

const ready = (async () => {
  try {
    const [loc, ses] = await Promise.all([
      chrome.storage.local.get(["settings", "frameInsets"]),
      chrome.storage.session.get(["managed", "launches", "warned", "alerts"]),
    ]);
    settings = Object.assign({}, DEFAULT_SETTINGS, loc.settings || {});
    learnedInsets = loc.frameInsets || null;
    state.managed = ses.managed || {};
    state.launches = ses.launches || {};
    state.warned = ses.warned || {};
    state.alerts = ses.alerts || {};
  } catch (e) {
    console.warn("[PACS] No pude leer el estado guardado:", e);
  }
})();

let saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session
      .set({ managed: state.managed, launches: state.launches, warned: state.warned, alerts: state.alerts })
      .catch(() => {});
  }, 50);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.settings) {
    const before = (changes.settings.oldValue || {}).invisibleBorder;
    settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue || {});
    displayCache = null;
    log("info", "Opciones actualizadas.");
    // Si cambias el borde a mano, se vuelve a medir desde ese valor.
    if (before !== undefined && before !== settings.invisibleBorder && learnedInsets) {
      learnedInsets = null;
      chrome.storage.local.remove("frameInsets").catch(() => {});
    }
  }
  if (changes.frameInsets) learnedInsets = changes.frameInsets.newValue || null;
});

// Bordes que se compensan al ubicar la ventana. Los lados parten del valor de
// Opciones (borde invisible de Windows); abajo parte en 0 porque si sobra, la
// ventana se pasa de la pantalla y tapa parte del visor (y si falta, solo
// queda un hueco). Luego se usan los bordes medidos en este equipo.
function effectiveInsets() {
  if (learnedInsets) return G.normalizeInsets(learnedInsets);
  const b = G.normalizeInsets(settings.invisibleBorder).left;
  return { left: b, right: b, bottom: 0 };
}

async function saveLearnedInsets(insets) {
  learnedInsets = Object.assign(G.normalizeInsets(insets), { at: Date.now() });
  await chrome.storage.local.set({ frameInsets: learnedInsets }).catch(() => {});
}

// =====================================================================
// Registro (consola + pagina de Opciones)
// =====================================================================
const LOG_MAX = 400;
let logQueue = [];
let logTimer = null;

function log(level, msg, data) {
  const fn = console[level] || console.log;
  if (data !== undefined) fn("[PACS]", msg, data);
  else fn("[PACS]", msg);
  const entry = { t: Date.now(), level, msg };
  if (data !== undefined) entry.data = data;
  logQueue.push(entry);
  if (!logTimer) logTimer = setTimeout(flushLog, 300);
}

// Las escrituras del registro van en fila: dos escrituras simultaneas leerian
// el mismo registro previo y una borraria lo agregado por la otra.
let logChain = Promise.resolve();
function withLogLock(fn) {
  logChain = logChain.then(fn).catch(() => {});
  return logChain;
}

function flushLog() {
  clearTimeout(logTimer);
  logTimer = null;
  return withLogLock(async () => {
    if (!logQueue.length) return;
    const batch = logQueue;
    logQueue = [];
    const { log: prev = [] } = await chrome.storage.session.get("log");
    await chrome.storage.session.set({ log: prev.concat(batch).slice(-LOG_MAX) });
  });
}

function clearLog() {
  logQueue = [];
  return withLogLock(() => chrome.storage.session.set({ log: [] }));
}

function track(promise) {
  if (promise && promise.catch) promise.catch((e) => log("error", "Error inesperado", String((e && e.stack) || e)));
}

// =====================================================================
// Utilidades
// =====================================================================
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([promise, delay(ms).then(() => null)]);
}

function urlParts(u) {
  try {
    const p = new URL(u);
    return { host: p.hostname, pathname: p.pathname, rest: p.pathname + p.search + p.hash };
  } catch (e) {
    return null;
  }
}
function isSynapseUrl(u) {
  const p = urlParts(u);
  return !!p && p.host === HOST;
}
function isViewerUrl(u) {
  const p = urlParts(u);
  return !!p && p.host === HOST && VIEWER_RE.test(p.rest);
}
function isLauncherUrl(u) {
  const p = urlParts(u);
  return !!p && p.host === HOST && LAUNCHER_RE.test(p.rest) && WINPASS_RE.test(p.rest);
}
// Para el registro: sin parametros y con los numeros/identificadores largos
// enmascarados (pueden ser datos del paciente o del estudio).
function shortUrl(u) {
  const p = urlParts(u);
  return p ? maskIds(p.pathname) : "";
}
function maskIds(text) {
  return String(text || "").replace(/[0-9a-f]{16,}|\d[\d.]{4,}/gi, "#");
}
// Identifica un estudio/URL sin guardarla (hash FNV-1a).
function urlKey(u) {
  let h = 0x811c9dc5;
  const s = String(u || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}
function box(w) {
  return w ? { left: w.left, top: w.top, width: w.width, height: w.height, state: w.state } : null;
}
function pct(x) {
  return Math.round(x * 100) + "%";
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}

async function findViewerTabs() {
  const tabs = await chrome.tabs.query({ url: `https://${HOST}/*` });
  return tabs.filter((t) => isViewerUrl(t.url));
}

function upsertManaged(tabId, patch) {
  const rec = Object.assign({ tabId }, state.managed[tabId] || {}, patch);
  state.managed[tabId] = rec;
  saveState();
  return rec;
}

function managedByWindow(windowId) {
  return Object.values(state.managed).find((r) => r.windowId === windowId) || null;
}

// =====================================================================
// Avisos en pantalla, alertas del icono
// =====================================================================
// Si la pagina aun no tiene el content script (esta cargando, o es una pagina
// de error), el aviso queda en cola y se entrega cuando la pagina se reporta.
const pendingNotices = new Map();

async function noticeTab(tabId, level, text, opts) {
  opts = opts || {};
  if (!settings.showNotices && level !== "error") return;
  const payload = {
    type: "pacs-dm:notice",
    level,
    text,
    sticky: !!opts.sticky,
    actions: opts.actions || [],
    key: opts.key,
  };
  try {
    await chrome.tabs.sendMessage(tabId, payload, { frameId: 0 });
  } catch (e) {
    const queue = (pendingNotices.get(tabId) || []).filter((p) => !p.key || p.key !== payload.key);
    queue.push(payload);
    pendingNotices.set(tabId, queue.slice(-5));
  }
}

function flushPendingNotices(tabId) {
  const queue = pendingNotices.get(tabId);
  if (!queue) return;
  pendingNotices.delete(tabId);
  for (const p of queue) chrome.tabs.sendMessage(tabId, p, { frameId: 0 }).catch(() => {});
}

async function noticeOtherSynapseTabs(level, text, opts) {
  const tabs = await chrome.tabs.query({ url: `https://${HOST}/*` });
  for (const t of tabs) {
    if (!isViewerUrl(t.url) && !isLauncherUrl(t.url)) noticeTab(t.id, level, text, opts);
  }
}

function warnOnce(key, tabId, level, text, opts) {
  if (state.warned[key]) return;
  state.warned[key] = Date.now();
  saveState();
  log(level === "error" ? "error" : "warn", text);
  if (tabId != null) noticeTab(tabId, level, text, Object.assign({ sticky: true, key }, opts || {}));
}

function setAlert(key, level, text) {
  state.alerts[key] = { level, text, t: Date.now() };
  saveState();
  refreshBadge();
}
function clearAlert(key) {
  if (!state.alerts[key]) return;
  delete state.alerts[key];
  saveState();
  refreshBadge();
}
function refreshBadge() {
  const list = Object.values(state.alerts);
  const error = list.some((a) => a.level === "error");
  chrome.action.setBadgeText({ text: list.length ? "!" : "" }).catch(() => {});
  if (list.length) chrome.action.setBadgeBackgroundColor({ color: error ? "#d93025" : "#e8a200" }).catch(() => {});
  const base = "PACS Dual Monitor — click o Ctrl+Shift+Y: reubicar el visor";
  chrome.action
    .setTitle({ title: list.length ? base + "\n\n" + list.map((a) => "• " + a.text).join("\n") : base })
    .catch(() => {});
}

// =====================================================================
// Monitores y rectangulo destino
// =====================================================================
let displayCache = null;
let lastGoodDisplayCount = 0;

async function getDisplays(fresh) {
  if (!fresh && displayCache && Date.now() - displayCache.at < 4000) return displayCache.list;
  const list = await chrome.system.display.getInfo();
  displayCache = { at: Date.now(), list };
  return list;
}

async function computeTarget() {
  let displays = await getDisplays();
  // Al despertar o al conectar el dock, Windows a veces informa menos
  // monitores por un instante: reintentar brevemente.
  for (let i = 0; i < 3 && displays.length < lastGoodDisplayCount; i++) {
    await delay(250);
    displays = await getDisplays(true);
  }
  const pick = G.pickViewerDisplays(displays, {
    displayIds: settings.displayIds,
    singleMonitorFallback: settings.singleMonitorFallback,
  });
  if (!pick) {
    log("info", `Sin monitores externos para el visor (${displays.length} monitor/es): no se reubica.`);
    return null;
  }
  lastGoodDisplayCount = Math.max(lastGoodDisplayCount, displays.length);
  const insets = effectiveInsets();
  return {
    bounds: G.targetBounds(pick.displays, insets),
    area: G.visibleArea(pick.displays),
    insets,
    displayIds: pick.displays.map((d) => d.id),
    names: pick.displays.map((d) => d.name || d.id),
    scales: pick.displays.map(G.displayScale),
    reason: pick.reason,
    warnings: pick.warnings,
  };
}

let displayTimer = null;
chrome.system.display.onDisplayChanged.addListener(() => {
  displayCache = null;
  clearTimeout(displayTimer);
  displayTimer = setTimeout(() => track(onDisplaysSettled()), 1500);
});

async function onDisplaysSettled() {
  await ready;
  const displays = await getDisplays(true);
  log("info", `Cambió la configuración de monitores (${displays.length}).`);
  if (!settings.placeViewer) return;
  const target = await computeTarget();
  if (!target) return;
  for (const rec of Object.values(state.managed)) {
    const tab = await getTab(rec.tabId);
    // Solo visores/lanzaderas: nunca la worklist ni otras paginas.
    if (!tab || !(isViewerUrl(tab.url) || isLauncherUrl(tab.url))) continue;
    const win = await chrome.windows.get(tab.windowId).catch(() => null);
    if (!win) continue;
    // Al apagarse/encenderse un monitor Windows mueve las ventanas al
    // principal: se compara con donde ESTA la ventana, no con el destino viejo.
    if (win.type === "popup" && G.boundsDelta(win, target.bounds) <= T.exactPx) {
      upsertManaged(rec.tabId, { target: targetInfo(target) });
      continue;
    }
    log("info", "Reubicando el visor por cambio de monitores.", { ahora: box(win), destino: target.bounds });
    await placeTab(tab, target, "cambio de monitores", { guardUntil: Date.now() + 5000, reapplies: 0, userMovedAt: 0 });
  }
}

function targetInfo(target) {
  return {
    bounds: target.bounds,
    area: target.area,
    insets: target.insets,
    displayIds: target.displayIds,
    names: target.names,
    scales: target.scales,
  };
}

// Ubica una pestana de visor ya abierta (sin tocar sus datos de navegacion):
// si esta en una ventana normal la pasa a un popup creado en su lugar.
async function placeTab(tab, target, why, extra) {
  let windowId = tab.windowId;
  const win = await chrome.windows.get(windowId).catch(() => null);
  if (!win) return { ok: false };
  if (win.type === "normal") {
    const created = await chrome.windows.create({ tabId: tab.id, type: "popup", focused: true, ...target.bounds });
    windowId = created.id;
    log("info", `Pestaña ${tab.id} sacada de la ventana normal ${win.id} a un popup (${windowId}).`);
  } else if (win.type !== "popup") {
    return { ok: false };
  }
  upsertManaged(tab.id, Object.assign({ windowId, target: targetInfo(target) }, extra || {}));
  return applyBounds(windowId, target.bounds, why);
}

// =====================================================================
// Mover/redimensionar ventanas
// =====================================================================
const winLocks = new Map();
const ownUntil = new Map();

function withWindowLock(windowId, fn) {
  const prev = winLocks.get(windowId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  winLocks.set(windowId, tail);
  tail.then(() => {
    if (winLocks.get(windowId) === tail) winLocks.delete(windowId);
  });
  return run;
}

function markOwn(windowId, ms) {
  ownUntil.set(windowId, Math.max(ownUntil.get(windowId) || 0, Date.now() + ms));
}
function isOwn(windowId) {
  return (ownUntil.get(windowId) || 0) > Date.now();
}

// Lee la ventana hasta que deja de cambiar (Windows aplica algunos cambios,
// como el de escala al pasar de monitor, de forma asincrona).
async function settle(windowId) {
  let prev = await chrome.windows.get(windowId);
  const until = Date.now() + T.settleMaxMs;
  while (Date.now() < until) {
    await delay(T.settlePollMs);
    const cur = await chrome.windows.get(windowId);
    if (G.boundsDelta(cur, prev) === 0 && cur.state === prev.state) return cur;
    prev = cur;
  }
  return prev;
}

// Lleva la ventana al rectangulo b. Camino rapido (2-3 llamadas, sin esperas)
// para ganarle a la carga del visor; si no queda exacta, reintenta con la
// secuencia lenta (mover, esperar, redimensionar) que necesita Windows cuando
// los monitores tienen distinta escala.
async function applyBounds(windowId, b, why) {
  return withWindowLock(windowId, async () => {
    let w = await chrome.windows.get(windowId);
    if (w.state === "normal" && G.boundsDelta(w, b) <= T.exactPx) return { ok: true, changed: false, win: w };
    // Solo desde aqui los cambios de la ventana son nuestros (la guardia los ignora).
    markOwn(windowId, 3000);
    try {
      const before = box(w);
      if (w.state !== "normal") await chrome.windows.update(windowId, { state: "normal" });
      // Primero saltar al monitor destino (cambio de escala) y luego dimensionar.
      if (!G.centerInside(w, b)) await chrome.windows.update(windowId, { left: b.left, top: b.top });
      await chrome.windows.update(windowId, { left: b.left, top: b.top, width: b.width, height: b.height });
      w = await chrome.windows.get(windowId);
      for (let i = 1; i <= T.applyRetries && G.boundsDelta(w, b) > T.exactPx; i++) {
        w = await settle(windowId);
        if (G.boundsDelta(w, b) <= T.exactPx) break;
        await chrome.windows.update(windowId, { left: b.left, top: b.top });
        await delay(80 * i);
        await chrome.windows.update(windowId, { width: b.width, height: b.height });
        await delay(80 * i);
        await chrome.windows.update(windowId, { left: b.left, top: b.top, width: b.width, height: b.height });
        w = await settle(windowId);
      }
      const delta = G.boundsDelta(w, b);
      const ok = delta <= T.exactPx;
      log(
        ok ? "info" : "warn",
        ok ? `Ventana ${windowId} ubicada (${why}).` : `La ventana ${windowId} quedó a ${delta}px del destino (${why}).`,
        { antes: before, destino: b, final: box(w) }
      );
      return { ok, changed: true, win: w, delta };
    } finally {
      ownUntil.set(windowId, Date.now() + 500);
    }
  });
}

// =====================================================================
// Preparar la ventana del visor (o de la lanzadera que sera el visor)
// =====================================================================
const preparing = new Map();

function prepareWindow(tabId, url, role, why) {
  const prev = preparing.get(tabId) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => doPrepare(tabId, url, role, why));
  preparing.set(tabId, run);
  run.catch(() => {}).then(() => {
    if (preparing.get(tabId) === run) preparing.delete(tabId);
  });
  return run;
}

async function doPrepare(tabId, url, role, why) {
  await ready;
  const tab = await getTab(tabId);
  if (!tab) return null;
  const now = Date.now();
  const key = urlKey(url);
  const old = state.managed[tabId];
  const patch = {
    role,
    windowId: tab.windowId,
    path: shortUrl(url),
    navKey: key,
    navAt: now,
    guardUntil: now + T.guardBeforeLoadMs,
    reapplies: 0,
    userMovedAt: 0,
    loadedAt: null,
    report: null,
    relayouts: 0,
  };
  // Las recargas automaticas se cuentan por estudio.
  if (!old || old.navKey !== key) Object.assign(patch, { autoReloads: 0, lastAutoReloadAt: 0 });
  let rec = upsertManaged(tabId, patch);

  if (isSynapseUrl(tab.url)) track(ensureZoom100(tabId, "antes de abrir el visor"));
  if (!settings.placeViewer) return rec;

  const target = await computeTarget();
  if (!target) return rec;
  let windowId = tab.windowId;
  const win = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
  if (!win) return rec;
  if (win.type === "normal") {
    // Pestana dentro de una ventana normal: pasarla a un popup (sin barra de
    // Chrome) creado directamente en su lugar.
    const created = await chrome.windows.create({
      tabId,
      type: "popup",
      focused: true,
      left: target.bounds.left,
      top: target.bounds.top,
      width: target.bounds.width,
      height: target.bounds.height,
    });
    windowId = created.id;
    log("info", `Pestaña ${tabId} sacada de la ventana normal ${win.id} a un popup (${windowId}).`);
  } else if (win.type !== "popup") {
    log("info", `Ventana ${windowId} de tipo "${win.type}": no se toca.`);
    return rec;
  }
  rec = upsertManaged(tabId, { windowId, target: targetInfo(target) });
  await applyBounds(windowId, target.bounds, why);
  target.warnings.forEach((text, i) => warnOnce(`display:${text}`, tabId, "warn", text, { key: `display-${i}` }));
  return rec;
}

// =====================================================================
// Zoom 100% (Synapse lo exige para que las mediciones sean correctas)
// =====================================================================
const zoomBusy = new Set();

async function ensureZoom100(tabId, why) {
  if (!settings.forceZoom100 || zoomBusy.has(tabId)) return;
  zoomBusy.add(tabId);
  try {
    const z = await chrome.tabs.getZoom(tabId);
    if (Math.abs(z - 1) < 0.005) return;
    await chrome.tabs.setZoom(tabId, 1); // por origen: todo Synapse queda en 100%
    log("info", `Zoom de Synapse ${pct(z)} → 100% (${why}).`);
    noticeTab(tabId, "info", "Zoom del navegador ajustado a 100% (Synapse lo exige para que las mediciones sean correctas).", {
      key: "zoom",
    });
  } catch (e) {
    log("warn", "No pude ajustar el zoom.", String(e));
  } finally {
    zoomBusy.delete(tabId);
  }
}

chrome.tabs.onZoomChange.addListener((info) => {
  if (Math.abs(info.newZoomFactor - 1) < 0.005) return;
  track(
    (async () => {
      await ready;
      if (!settings.forceZoom100) return;
      const tab = await getTab(info.tabId);
      if (tab && isSynapseUrl(tab.url)) await ensureZoom100(info.tabId, "cambio de zoom");
    })()
  );
});

// =====================================================================
// Navegacion
// =====================================================================
function isPrerender(d) {
  return d.documentLifecycle === "prerender" || d.tabId < 0;
}

// Pestanas/ventanas creadas por window.open (lanzaderas nuevas). Se anota de
// inmediato, sin await, para no perder la carrera con onBeforeNavigate.
const createdTargets = new Map();
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  createdTargets.set(d.tabId, Date.now());
  if (createdTargets.size > 50) createdTargets.delete(createdTargets.keys().next().value);
}, NAV_FILTER);

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0 || isPrerender(d)) return;
  if (isViewerUrl(d.url)) track(prepareWindow(d.tabId, d.url, "viewer", "antes de cargar el visor"));
  else if (isLauncherUrl(d.url)) track(onLauncherStart(d.tabId, d.url, d.timeStamp));
}, NAV_FILTER);

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || isPrerender(d)) return;
  track(onCommitted(d));
}, NAV_FILTER);

chrome.webNavigation.onCompleted.addListener((d) => {
  if (d.frameId !== 0 || isPrerender(d) || !isViewerUrl(d.url)) return;
  track(onViewerCompleted(d));
}, NAV_FILTER);

chrome.webNavigation.onHistoryStateUpdated.addListener((d) => {
  if (d.frameId !== 0 || isPrerender(d)) return;
  track(
    (async () => {
      await ready;
      // Visor cargado como aplicacion de una sola pagina (sin recargar).
      if (isViewerUrl(d.url) && !state.managed[d.tabId]) await prepareWindow(d.tabId, d.url, "viewer", "visor (SPA)");
    })()
  );
}, NAV_FILTER);

chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId !== 0 || isPrerender(d) || /ERR_ABORTED/i.test(d.error)) return;
  track(
    (async () => {
      await ready;
      if (isViewerUrl(d.url)) {
        await recoverViewer(d.tabId, `Error de red al abrir el visor (${d.error})`, { hasInput: false, force: true, silent: true });
      } else if (isLauncherUrl(d.url) && state.launches[d.tabId]) {
        await retryLaunch(state.launches[d.tabId], `error de red en la lanzadera (${d.error})`);
      }
    })()
  );
}, NAV_FILTER);

async function onCommitted(d) {
  await ready;
  // Cualquier pagina de Synapse: zoom al 100% antes de que se abra un visor.
  track(ensureZoom100(d.tabId, "página de Synapse"));
  if (isViewerUrl(d.url)) {
    await (preparing.get(d.tabId) || Promise.resolve()).catch(() => {});
    const rec = state.managed[d.tabId];
    if (!rec || rec.navKey !== urlKey(d.url)) {
      // Redireccion del servidor, o Chrome durmio el service worker.
      await prepareWindow(d.tabId, d.url, "viewer", "al confirmar la navegación");
    } else {
      upsertManaged(d.tabId, { role: "viewer" });
      if (rec.target && settings.placeViewer) await applyBounds(rec.windowId, rec.target.bounds, "al confirmar la navegación");
    }
    upsertManaged(d.tabId, { committedAt: Date.now() });
    chrome.tabs.update(d.tabId, { autoDiscardable: false }).catch(() => {});
    await onViewerCommitted(d.tabId);
  } else if (isLauncherUrl(d.url)) {
    if (!state.launches[d.tabId]) await onLauncherStart(d.tabId, d.url, d.timeStamp);
  } else if (state.managed[d.tabId]) {
    // La pestana dejo de ser visor: dejar de gestionarla.
    delete state.managed[d.tabId];
    saveState();
  }
}

async function onViewerCompleted(d) {
  await ready;
  const rec = upsertManaged(d.tabId, {
    loadedAt: Date.now(),
    guardUntil: Date.now() + settings.guardSeconds * 1000,
  });
  if (rec.target && settings.placeViewer) await applyBounds(rec.windowId, rec.target.bounds, "al terminar de cargar");
  await cleanupOrphans(d.tabId);
}

chrome.tabs.onAttached.addListener((tabId, info) => {
  if (state.managed[tabId]) upsertManaged(tabId, { windowId: info.newWindowId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingNotices.delete(tabId);
  pageEventCount.delete(tabId);
  createdTargets.delete(tabId);
  track(
    (async () => {
      await ready;
      if (state.managed[tabId] || state.launches[tabId]) {
        delete state.managed[tabId];
        delete state.launches[tabId];
        saveState();
      }
    })()
  );
});

chrome.windows.onRemoved.addListener((windowId) => {
  ownUntil.delete(windowId);
  winLocks.delete(windowId);
});

// =====================================================================
// Guardia: si algo mas mueve la ventana mientras el visor carga, se restaura
// =====================================================================
const guardTimers = new Map();

chrome.windows.onBoundsChanged.addListener((win) => track(onBoundsChanged(win)));

async function onBoundsChanged(win) {
  await ready;
  const rec = managedByWindow(win.id);
  if (!rec || !rec.target || !settings.placeViewer || win.type !== "popup" || isOwn(win.id)) return;
  const delta = G.boundsDelta(win, rec.target.bounds);
  if (delta <= T.guardDriftPx) return;
  const now = Date.now();
  if (now > (rec.guardUntil || 0)) {
    if (!rec.userMovedAt || now - rec.userMovedAt > 10000) {
      log("info", `Moviste o redimensionaste el visor (Δ${delta}px); se respeta. Ctrl+Shift+Y lo vuelve a ubicar.`, box(win));
    }
    upsertManaged(rec.tabId, { userMovedAt: now });
    return;
  }
  if ((rec.reapplies || 0) >= T.guardMaxReapplies) {
    warnOnce(
      `fight:${rec.tabId}:${rec.navKey}`,
      rec.tabId,
      "warn",
      "Otro programa sigue moviendo la ventana del visor (¿la extensión de Synapse de Fujifilm?). Desactívala o usa Ctrl+Shift+Y."
    );
    return;
  }
  upsertManaged(rec.tabId, { reapplies: (rec.reapplies || 0) + 1 });
  log("info", `Guardia: algo movió la ventana del visor (Δ${delta}px); restaurando.`, box(win));
  clearTimeout(guardTimers.get(win.id));
  guardTimers.set(
    win.id,
    setTimeout(() => {
      guardTimers.delete(win.id);
      const r = managedByWindow(win.id);
      if (r && r.target) track(applyBounds(win.id, r.target.bounds, "guardia"));
    }, 120)
  );
}

// =====================================================================
// Visores huerfanos / zombie
// =====================================================================
async function closeTabSmart(tabId, why) {
  const tab = await getTab(tabId);
  if (!tab) return false;
  if (!isViewerUrl(tab.url) && !isLauncherUrl(tab.url)) {
    log("warn", `No cierro la pestaña ${tabId}: ya no es visor ni lanzadera.`);
    return false;
  }
  try {
    const win = await chrome.windows.get(tab.windowId, { populate: true });
    if ((win.tabs || []).length === 1) await chrome.windows.remove(win.id);
    else await chrome.tabs.remove(tabId);
    log("info", `Cerrada: ${why} (pestaña ${tabId}).`);
    return true;
  } catch (e) {
    log("warn", `No pude cerrar la pestaña ${tabId}.`, String(e));
    return false;
  }
}

// En fila (dos visores que abren a la vez no deben cerrarse mutuamente) y
// conservando siempre el visor MAS RECIENTE, no el que disparo el evento.
let cleanupChain = Promise.resolve();
function cleanupOrphans(triggerTabId) {
  if (!settings.closeOrphanViewers) return Promise.resolve();
  cleanupChain = cleanupChain
    .then(() => doCleanupOrphans(triggerTabId))
    .catch((e) => log("warn", "Error al cerrar visores huérfanos.", String(e)));
  return cleanupChain;
}

async function doCleanupOrphans(triggerTabId) {
  const viewers = await findViewerTabs();
  const keep = viewers.length ? mostRecentViewer(viewers) : null;
  for (const t of viewers) {
    if (keep && t.id === keep.id) continue;
    // Un visor que estas usando en este momento no se cierra solo.
    const act = await getActivity(t.id);
    const rec = state.managed[t.id];
    const lastInput = Math.max((act && act.inputAt) || 0, (rec && rec.inputAt) || 0);
    if (Date.now() - lastInput < T.inUseMs) {
      log("info", `Visor anterior en uso (pestaña ${t.id}): no se cierra.`);
      noticeTab(t.id, "warn", "Se abrió otro visor. Este quedó abierto porque lo estabas usando: ciérralo cuando termines.", {
        sticky: true,
        key: "orphan-kept",
      });
      continue;
    }
    await closeTabSmart(t.id, "visor anterior/huérfano");
  }
  // Lanzaderas de intentos anteriores que quedaron pegadas.
  for (const L of Object.values(state.launches)) {
    if (L.tabId !== triggerTabId && (L.phase === "failed" || isAwaiting(L))) {
      await closeTabSmart(L.tabId, "lanzadera pegada de un intento anterior");
      delete state.launches[L.tabId];
      saveState();
    }
  }
}

// =====================================================================
// Seguimiento de cada click en un estudio
// =====================================================================
// navTime: instante en que Chrome empezo la navegacion (details.timeStamp); no
// se usa la hora en que el service worker procesa el evento, que puede llegar
// tarde si estaba dormido.
async function onLauncherStart(tabId, url, navTime) {
  await ready;
  const tab = await getTab(tabId);
  if (!tab) return;
  const t = Math.min(Number(navTime) || Date.now(), Date.now());
  let L = state.launches[tabId];
  if (!L || L.phase === "failed") {
    L = state.launches[tabId] = { tabId, kind: "launcher", startedAt: t, attempt: 1 };
    log("info", `Click en un estudio: lanzadera abierta (pestaña ${tabId}).`);
  }
  Object.assign(L, { phase: "pending", navAt: t, warningAt: null, retryAt: null });
  saveState();
  // Ubicar desde ya la ventana de la lanzadera (sera la ventana del visor), asi
  // el visor nace con el tamano y la escala finales. Solo si es una pestana o
  // ventana nueva (abierta por window.open, un popup propio, o una ventana que
  // ya gestionamos): nunca se mueve la ventana de la worklist.
  const win = await chrome.windows.get(tab.windowId, { populate: true }).catch(() => null);
  const rec = state.managed[tabId];
  const fresh =
    createdTargets.has(tabId) ||
    !!(rec && rec.target) ||
    !!(win && win.type === "popup" && (win.tabs || []).length === 1);
  if (fresh && settings.placeLauncher) await prepareWindow(tabId, url, "launcher", "lanzadera");
}

async function onViewerCommitted(tabId) {
  const L = state.launches[tabId];
  // Exito solo si es la lanzadera que paso a ser visor. Si el aviso salio en el
  // propio visor y lo recargamos, el intento sigue abierto hasta ver si vuelve.
  if (L && L.kind === "launcher") finishLaunch(L, "la lanzadera abrió el visor");
  // Lanzaderas que esperaban que el estudio llegara a este visor.
  for (const other of Object.values(state.launches)) {
    if (other.tabId === tabId || !isAwaiting(other)) continue;
    if ((other.deliveryTabs || []).includes(tabId)) {
      await closeLaunchTab(other, "el estudio se abrió en el visor existente");
      finishLaunch(other, "entregado al visor existente (navegación)");
    }
  }
  await cleanupOrphans(tabId);
}

function finishLaunch(L, how) {
  const secs = Math.round((Date.now() - (L.startedAt || Date.now())) / 100) / 10;
  log("info", `Estudio abierto: ${how} (${secs}s, intento ${L.attempt || 1}).`);
  delete state.launches[L.tabId];
  saveState();
  clearAlert("launch");
}

async function closeLaunchTab(L, why) {
  if (L.kind === "launcher" || L.kind === "viewer") await closeTabSmart(L.tabId, `lanzadera (${why})`);
}

function mostRecentViewer(tabs) {
  return [...tabs].sort((a, b) => {
    const na = (state.managed[a.id] && state.managed[a.id].navAt) || 0;
    const nb = (state.managed[b.id] && state.managed[b.id].navAt) || 0;
    return nb - na || b.id - a.id;
  })[0];
}

async function focusViewerTab(tab, why) {
  try {
    const w = await chrome.windows.get(tab.windowId);
    if (w.state === "minimized") await chrome.windows.update(w.id, { state: "normal" });
    await chrome.windows.update(w.id, { focused: true });
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    // El estudio llega a un visor ya iniciado: no se le cambia el tamano si tu
    // lo moviste a proposito (su calibracion corresponde a donde esta).
    const rec = state.managed[tab.id];
    if (rec && rec.target && settings.placeViewer && !rec.userMovedAt && w.type === "popup") {
      await applyBounds(w.id, rec.target.bounds, `traer al frente (${why})`);
    }
    log("info", `Visor existente traído al frente (pestaña ${tab.id}, ${why}).`);
  } catch (e) {
    log("warn", "No pude traer el visor al frente.", String(e));
  }
}

async function getActivity(tabId) {
  try {
    return await withTimeout(chrome.tabs.sendMessage(tabId, { type: "pacs-dm:get-activity" }, { frameId: 0 }), T.activityTimeoutMs);
  } catch (e) {
    return null;
  }
}

// ¿Llego un estudio nuevo a este visor despues del instante "since"? (el visor
// navego o cambio de titulo/URL, o descargo un lote de datos de imagen).
// Se usan marcas de tiempo y no "lineas base": Synapse puede entregar el
// estudio antes de mostrar el aviso.
function looksDelivered(act, since) {
  if (!act) return false;
  if ((act.docStartedAt || 0) > since) return true;
  if ((act.titleChangedAt || 0) > since || (act.hrefChangedAt || 0) > since) return true;
  const recent = (act.recent || []).filter((r) => r[0] > since);
  const bytes = recent.reduce((sum, r) => sum + (r[1] || 0), 0);
  return recent.length >= 8 && bytes >= 100000;
}

async function handleWarning(L) {
  L.warningAt = Date.now(); // antes de cualquier await: evita manejarlo dos veces
  const tab = await getTab(L.tabId);
  if (!tab) return;
  L.kind = isLauncherUrl(tab.url) ? "launcher" : isViewerUrl(tab.url) ? "viewer" : "other";
  log("warn", `Synapse muestra "abierta en otra ventana" (${L.kind}, pestaña ${L.tabId}, intento ${L.attempt || 1}).`);
  if (!settings.launcherRecovery) {
    L.phase = "warning";
    saveState();
    return;
  }
  const viewers = (await findViewerTabs()).filter((t) => t.id !== L.tabId);
  if (viewers.length && L.kind === "other") {
    // Aviso dentro de la worklist u otra pagina: solo traer el visor al frente.
    await focusViewerTab(mostRecentViewer(viewers), "aviso en otra página de Synapse");
    finishLaunch(L, "aviso en otra página; visor existente al frente");
  } else if (viewers.length) {
    // Synapse manda el estudio al visor que ya esta abierto: traerlo al
    // frente y verificar que de verdad lo reciba.
    await focusViewerTab(mostRecentViewer(viewers), "recibe el estudio");
    Object.assign(L, {
      phase: "awaiting-delivery",
      deliveryTabs: viewers.map((v) => v.id),
      deliverySince: L.navAt || L.startedAt,
      deliveryDeadline: Date.now() + T.deliveryWaitMs,
    });
    saveState();
    setTimeout(() => track(checkLaunch(L)), T.deliveryWaitMs + 50);
  } else if (L.kind === "other") {
    L.phase = "failed";
    saveState();
    const text =
      "Synapse dice que el visor está abierto en otra ventana, pero no hay ningún visor en este Chrome. " +
      "¿Quedó abierto en otro navegador o perfil? Ciérralo y vuelve a abrir el estudio.";
    log("error", text);
    noticeTab(L.tabId, "error", text, { sticky: true, key: "launch-failed" });
    setAlert("launch", "error", "Synapse cree que hay otro visor abierto (no está en este Chrome).");
  } else {
    await retryLaunch(L, "no hay ningún visor abierto (el candado de Synapse quedó pegado)");
  }
}

async function checkLaunch(ref) {
  const L = ref && state.launches[ref.tabId];
  if (!L) return;
  const tab = await getTab(L.tabId);
  if (!tab) {
    delete state.launches[L.tabId];
    saveState();
    return;
  }
  if (L.kind === "launcher" && isViewerUrl(tab.url)) {
    finishLaunch(L, "la lanzadera abrió el visor");
    return;
  }
  const now = Date.now();
  if (L.phase === "pending") {
    if (L.kind === "launcher" && !L.warningAt && now - (L.navAt || L.startedAt) > T.launcherStuckMs) {
      await retryLaunch(L, "la lanzadera no avanzó");
    }
  } else if (L.phase === "awaiting-delivery" || L.phase === "awaiting-user") {
    const since = L.deliverySince || L.startedAt;
    let unknown = 0;
    let inUse = false;
    for (const id of L.deliveryTabs || []) {
      const act = await getActivity(id);
      if (!isAwaiting(L)) return; // otro manejador ya cerro este intento
      if (looksDelivered(act, since)) {
        await closeLaunchTab(L, "el estudio se abrió en el visor existente");
        finishLaunch(L, `entregado al visor existente (pestaña ${id})`);
        return;
      }
      const rec = state.managed[id];
      if ((act && (act.inputAt || 0) > since) || (rec && (rec.inputAt || 0) > since)) inUse = true;
      if (!act && (await getTab(id))) unknown++;
    }
    if (inUse) {
      // Lo estas usando: no es un zombie y nunca se cierra solo.
      await closeLaunchTab(L, "el visor existente está en uso");
      finishLaunch(L, "visor existente en uso");
      noticeOtherSynapseTabs("info", "Synapse envió el estudio al visor que estás usando. Si no aparece, vuelve a hacer click en el estudio.", {
        key: "in-use",
      });
      return;
    }
    if (L.phase === "awaiting-user" || now < (L.deliveryDeadline || 0)) return;
    if (unknown && !L.extended) {
      // El visor no contesto la consulta (p.ej. un alert() abierto): esperar
      // una vez mas antes de decidir.
      L.extended = true;
      L.deliveryDeadline = now + T.deliveryWaitMs;
      saveState();
      log("info", "El visor existente no contestó la consulta; espero un poco más.");
      setTimeout(() => track(checkLaunch(L)), T.deliveryWaitMs + 50);
      return;
    }
    if (unknown || !settings.closeOrphanViewers) {
      // Sin certeza (o con el cierre de visores desactivado): decides tu.
      L.phase = "awaiting-user";
      saveState();
      log("warn", "No pude confirmar que el visor existente recibiera el estudio: se pregunta al usuario.");
      const text = "El visor abierto no parece haber recibido el estudio. ¿Cerrarlo y volver a abrir el estudio?";
      const opts = { sticky: true, key: "zombie-ask", actions: [{ id: `retry-launch:${L.tabId}`, label: "Cerrar visor y reintentar" }] };
      noticeTab(L.tabId, "warn", text, opts);
      noticeOtherSynapseTabs("warn", text, opts);
      for (const id of L.deliveryTabs || []) noticeTab(id, "warn", text, opts);
      return;
    }
    log("warn", "El visor existente no recibió el estudio: se considera zombie y se cierra.");
    for (const id of L.deliveryTabs || []) {
      if (!isAwaiting(L)) return;
      await closeTabSmart(id, "visor zombie (no recibió el estudio)");
    }
    if (isAwaiting(L)) await retryLaunch(L, "el visor existente no respondió");
  } else if (L.phase === "retrying" && now >= (L.retryAt || 0)) {
    Object.assign(L, { phase: "pending", navAt: now, warningAt: null, retryAt: null });
    saveState();
    log("info", `Reintento ${L.attempt}/${T.launchMaxAttempts}: recargando la ${L.kind === "viewer" ? "ventana del visor" : "lanzadera"}.`);
    await chrome.tabs.reload(L.tabId).catch((e) => log("warn", "No pude recargar.", String(e)));
  }
}

// El intento sigue vigente y esperando la entrega (nadie lo cerro mientras
// esperabamos respuestas).
function isAwaiting(L) {
  return state.launches[L.tabId] === L && (L.phase === "awaiting-delivery" || L.phase === "awaiting-user");
}

async function retryLaunch(L, reason) {
  if (!L || L.phase === "retrying" || L.phase === "failed") return;
  if ((L.attempt || 1) >= T.launchMaxAttempts) {
    L.phase = "failed";
    saveState();
    log("error", `No se pudo abrir el estudio tras ${L.attempt} intentos: ${reason}.`);
    const text =
      `No se pudo abrir el estudio (${reason}). Cierra esta ventana y vuelve a hacer click en el estudio. ` +
      "Si se repite, cierra todas las ventanas de Synapse.";
    noticeTab(L.tabId, "error", text, { sticky: true, key: "launch-failed" });
    noticeOtherSynapseTabs("error", "Synapse no abrió el último estudio. Vuelve a hacer click en él.", { key: "launch-failed" });
    setAlert("launch", "error", "El último estudio no se pudo abrir.");
    return;
  }
  L.attempt = (L.attempt || 1) + 1;
  L.phase = "retrying";
  L.retryAt = Date.now() + (T.retryDelayMs[L.attempt - 1] || 3000);
  saveState();
  log("warn", `Reintentando abrir el estudio (${L.attempt}/${T.launchMaxAttempts}): ${reason}.`);
  noticeTab(L.tabId, "info", `Reintentando abrir el estudio (${L.attempt}/${T.launchMaxAttempts})…`, { key: "launch-retry" });
  setTimeout(() => track(checkLaunch(L)), Math.max(0, L.retryAt - Date.now()) + 20);
}

// El usuario confirmo: cerrar el visor que no recibio el estudio y reintentar.
async function userRetryLaunch(launchTabId, fromTabId) {
  const L = state.launches[launchTabId];
  if (!L || !(await getTab(L.tabId))) {
    noticeTab(fromTabId, "info", "Vuelve a hacer click en el estudio en la worklist.", { key: "zombie-ask" });
    return;
  }
  for (const id of L.deliveryTabs || []) await closeTabSmart(id, "visor cerrado por el usuario (no recibió el estudio)");
  Object.assign(L, { phase: "pending", navAt: Date.now(), warningAt: null, retryAt: null, extended: false });
  L.attempt = (L.attempt || 1) + 1;
  saveState();
  log("info", "Reintento pedido por el usuario.");
  await chrome.tabs.reload(L.tabId).catch(() => {});
}

// =====================================================================
// Salud del visor (pantalla negra) y verificacion de escala/tamano
// =====================================================================
async function recoverViewer(tabId, reason, opts) {
  opts = opts || {};
  const rec = state.managed[tabId] || upsertManaged(tabId, {});
  const now = Date.now();
  // "En uso": hubo clicks/teclas/rueda en este estudio (en cualquier frame).
  const inUse = !!opts.hasInput || (rec.inputAt || 0) > (rec.navAt || 0);
  const canAuto =
    settings.autoReload &&
    !inUse &&
    (rec.autoReloads || 0) < T.maxAutoReloads &&
    (opts.force || !rec.lastAutoReloadAt || now - rec.lastAutoReloadAt > T.reloadCooldownMs);
  if (canAuto) {
    upsertManaged(tabId, { autoReloads: (rec.autoReloads || 0) + 1, lastAutoReloadAt: now });
    log("warn", `Recargando el visor automáticamente: ${reason}.`);
    if (!opts.silent) noticeTab(tabId, "warn", `${reason}. Recargando el visor…`, { key: "recover" });
    await delay(900);
    await chrome.tabs.reload(tabId).catch((e) => log("warn", "No pude recargar el visor.", String(e)));
  } else {
    log("warn", `Visor con problema (aviso al usuario): ${reason}.`);
    noticeTab(tabId, "error", `${reason}.`, {
      sticky: true,
      key: "recover",
      actions: [
        { id: "reload", label: "Recargar visor" },
        { id: "reposition", label: "Reubicar ventana" },
      ],
    });
  }
}

async function onViewerHealth(tabId, msg) {
  log("warn", `Salud del visor: ${msg.issue}.`, msg);
  if (msg.issue === "webgl-lost") {
    await recoverViewer(tabId, "El visor perdió el contexto gráfico (pantalla negra)", { hasInput: msg.hasInput });
  } else if (msg.issue === "http-error") {
    if (msg.status >= 500) {
      await recoverViewer(tabId, `El servidor respondió con error (HTTP ${msg.status})`, { hasInput: msg.hasInput });
    } else {
      noticeTab(tabId, "error", `El visor respondió HTTP ${msg.status} (¿sesión expirada?). Vuelve a abrir el estudio desde la worklist.`, {
        sticky: true,
        key: "http",
      });
    }
  }
}

async function onViewerReport(tabId, rep, sender) {
  if (!rep || !rep.now) return;
  const rec = upsertManaged(tabId, {
    windowId: sender.tab.windowId,
    reportAt: Date.now(),
    report: {
      dpr: rep.now.dpr,
      startDpr: rep.start && rep.start.dpr,
      size: [rep.now.iw, rep.now.ih],
      changes: rep.changes,
      media: rep.media,
      blockedCalls: rep.blockedCalls,
      hasInput: rep.hasInput,
    },
  });
  const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
  const osScale = rep.now.dpr / (zoom || 1);

  if (Math.abs(zoom - 1) > 0.005) {
    if (settings.forceZoom100) await ensureZoom100(tabId, "informe del visor");
    else warnOnce(`zoom:${pct(zoom)}`, tabId, "warn", `El zoom del navegador está en ${pct(zoom)}; Synapse exige 100% para medir bien (Ctrl+0).`);
  }
  if (Math.abs(osScale - 1) > 0.01) {
    const text =
      `Windows tiene la escala de pantalla en ${pct(osScale)} en el monitor del visor. Synapse exige 100% para que ` +
      "las mediciones y el True Size sean correctos (Configuración → Sistema → Pantalla → Escala).";
    warnOnce(`scale:${pct(osScale)}`, tabId, "error", text);
    setAlert("scale", "error", `Escala de Windows ${pct(osScale)} en el monitor del visor (debe ser 100%).`);
  } else {
    clearAlert("scale");
  }

  if (rep.dprChangedAfterDcl) {
    await recoverViewer(tabId, "La escala del visor cambió después de abrir el estudio: las mediciones podrían ser erróneas", {
      hasInput: rep.hasInput,
    });
    return;
  }
  if (rep.dprChanged) log("info", "La escala cambió antes de que el visor terminara de iniciar (sin riesgo).", rep.changes);

  const distorted = rep.media && rep.media.distorted > 0;
  if ((rep.sizeChangedAfterDcl || distorted) && (rec.relayouts || 0) < 2) {
    upsertManaged(tabId, { relayouts: (rec.relayouts || 0) + 1 });
    log("info", distorted ? "Imagen deformada en el visor: pidiendo a Synapse que recalcule el layout." : "El visor cambió de tamaño tras iniciar: recalculando layout.");
    chrome.tabs.sendMessage(tabId, { type: "pacs-dm:relayout" }, { frameId: 0 }).catch(() => {});
  } else if (distorted) {
    noticeTab(tabId, "warn", "La imagen del visor se ve deformada (no se ajustó al tamaño de la ventana). Recarga el visor antes de medir.", {
      sticky: true,
      key: "distorted",
      actions: [{ id: "reload", label: "Recargar visor" }],
    });
  }

  if (rec.target && settings.placeViewer && Date.now() <= (rec.guardUntil || 0)) {
    const w = await chrome.windows.get(rec.windowId).catch(() => null);
    if (w && G.boundsDelta(w, rec.target.bounds) > T.guardDriftPx) await applyBounds(rec.windowId, rec.target.bounds, "verificación");
  }
}

// =====================================================================
// Bordes: que el area del visor calce exacto con la pantalla
// =====================================================================
// El content script mide con el mouse (screenX - clientX) donde quedo de
// verdad el area de la pagina del visor en la pantalla. Si se pasa del area
// visible (p.ej. hacia abajo, debajo del borde de la pantalla) o deja un
// hueco, se corrigen los bordes, se guardan para los proximos estudios y, si
// aun no usaste el visor, se ajusta de inmediato.
function describeOver(over) {
  const parts = [];
  if (over.bottom > 0) parts.push(`${over.bottom} px hacia abajo`);
  if (over.left > 0) parts.push(`${over.left} px a la izquierda`);
  if (over.right > 0) parts.push(`${over.right} px a la derecha`);
  return parts.length ? `se pasaba ${parts.join(", ")} de la pantalla` : "dejaba un hueco en el borde";
}

async function onViewportMeasured(tabId, msg, sender) {
  const rec = state.managed[tabId];
  const vp = msg.rect;
  if (!rec || !rec.target || !rec.target.area || !settings.placeViewer) return;
  if (!vp || ![vp.left, vp.top, vp.width, vp.height].every(Number.isFinite)) return;
  const w = await chrome.windows.get(sender.tab.windowId).catch(() => null);
  if (!w || w.type !== "popup" || w.state !== "normal") return;
  // Solo con la ventana donde la pusimos y con zoom 100% (px de la pagina = px de pantalla).
  if (G.boundsDelta(w, rec.target.bounds) > T.exactPx) return;
  const zoom = await chrome.tabs.getZoom(tabId).catch(() => 1);
  if (Math.abs(zoom - 1) > 0.005) return;
  // Plausibilidad: el area de la pagina tiene que estar dentro de la ventana.
  const plausible =
    vp.left >= w.left - 2 &&
    vp.top >= w.top - 2 &&
    vp.left + vp.width <= w.left + w.width + 2 &&
    vp.top + vp.height <= w.top + w.height + 2 &&
    vp.width >= w.width - 100 &&
    vp.height >= w.height - 300;
  if (!plausible) {
    if (!rec.badViewport) {
      upsertManaged(tabId, { badViewport: true });
      log("info", "Medición del área del visor descartada (no es plausible).", { area: vp, ventana: box(w) });
    }
    return;
  }
  const area = rec.target.area;
  const cur = G.insetsOf(rec.target.bounds, area);
  const res = G.correctInsets(area, vp, cur);
  upsertManaged(tabId, { viewport: { rect: vp, over: res.over, at: Date.now() } });
  if (!res.changed) {
    // Calza: se guardan estos bordes como medidos (si aun no lo estaban).
    const l = learnedInsets;
    if (!l || l.left !== cur.left || l.right !== cur.right || l.bottom !== cur.bottom) {
      await saveLearnedInsets(cur);
      log("info", "Bordes de la ventana verificados: el visor calza exacto con la pantalla.", cur);
    }
    return;
  }
  if (Math.max(Math.abs(res.over.left), Math.abs(res.over.right), Math.abs(res.over.bottom)) > 40) {
    log("info", "Medición del área del visor fuera de rango; no se ajusta.", { sobrepasa: res.over, area: vp, ventana: box(w) });
    return;
  }
  await saveLearnedInsets(res.insets);
  const b = rec.target.bounds;
  const d = { left: res.insets.left - cur.left, right: res.insets.right - cur.right, bottom: res.insets.bottom - cur.bottom };
  const nb = { left: b.left - d.left, top: b.top, width: b.width + d.left + d.right, height: b.height + d.bottom };
  const why = describeOver(res.over);
  log("info", `Bordes ajustados: el visor ${why}.`, { sobrepasa: res.over, bordes: res.insets });
  const inUse = !!msg.hasInput || (rec.inputAt || 0) > (rec.navAt || 0);
  if (!inUse) {
    upsertManaged(tabId, { target: Object.assign({}, rec.target, { bounds: nb, insets: res.insets }) });
    await applyBounds(w.id, nb, "ajuste de bordes");
  } else {
    noticeTab(tabId, "warn", `El visor ${why}. Quedó corregido para los próximos estudios; para ajustarlo ahora usa el botón (o Ctrl+Shift+Y).`, {
      sticky: true,
      key: "insets",
      actions: [{ id: "reposition", label: "Ajustar ahora" }],
    });
  }
}

// =====================================================================
// Reubicacion manual (atajo Ctrl+Shift+Y o click en el icono)
// =====================================================================
chrome.commands.onCommand.addListener((command) => {
  if (command === "reposition-viewer") track(repositionViewerNow("atajo"));
});
chrome.action.onClicked.addListener(() => track(repositionViewerNow("icono")));

async function repositionViewerNow(source, preferTabId) {
  await ready;
  const tabs = await findViewerTabs();
  if (!tabs.length) {
    log("warn", `No hay ningún visor abierto para reubicar (${source}).`);
    return { ok: false, reason: "no-viewer" };
  }
  let tab = tabs.find((t) => t.id === preferTabId);
  if (!tab) {
    const focused = await chrome.windows.getLastFocused().catch(() => null);
    tab = (focused && tabs.find((t) => t.windowId === focused.id)) || mostRecentViewer(tabs);
  }
  displayCache = null;
  const target = await computeTarget();
  if (!target) {
    noticeTab(tab.id, "warn", "No encontré los monitores externos para el visor.", { key: "manual" });
    return { ok: false, reason: "no-displays" };
  }
  log("info", `Reubicación manual del visor (${source}).`);
  const res = await placeTab(tab, target, `manual (${source})`, {
    role: "viewer",
    guardUntil: Date.now() + settings.guardSeconds * 1000,
    reapplies: 0,
    relayouts: 0,
    userMovedAt: 0,
  });
  await ensureZoom100(tab.id, "manual");
  chrome.tabs.sendMessage(tab.id, { type: "pacs-dm:relayout" }, { frameId: 0 }).catch(() => {});
  noticeTab(
    tab.id,
    res.ok ? "info" : "warn",
    res.ok ? "Visor reubicado en los monitores externos." : "No pude dejar el visor exactamente en su lugar (ver diagnóstico en Opciones).",
    { key: "manual" }
  );
  return { ok: res.ok, delta: res.delta };
}

// =====================================================================
// Mensajes (content scripts y pagina de Opciones)
// =====================================================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("pacs-dm:")) return;
  handleMessage(msg, sender).then(
    (res) => sendResponse(res === undefined ? { ok: true } : res),
    (e) => {
      log("error", `Error procesando ${msg.type}`, String((e && e.stack) || e));
      sendResponse({ ok: false, error: String(e) });
    }
  );
  return true;
});

const pageEventCount = new Map();

async function handleMessage(msg, sender) {
  await ready;
  const tabId = sender.tab ? sender.tab.id : null;
  if (tabId != null && sender.frameId === 0) flushPendingNotices(tabId);
  switch (msg.type) {
    case "pacs-dm:warning":
    case "pacs-dm:heartbeat": {
      if (tabId == null) return;
      let L = state.launches[tabId];
      // Inicio del documento que habla (reloj absoluto del mismo equipo).
      const docStart = Number(msg.docStart) || Date.now() - (msg.age || 0);
      const appeared = msg.type === "pacs-dm:warning";
      // Un intento viejo o ya fallido no debe bloquear un aviso nuevo (otra
      // pagina, o el aviso que vuelve a aparecer en la worklist): de cero.
      const stale =
        L &&
        (Date.now() - (L.startedAt || 0) > 300000 ||
          ((L.phase === "failed" || L.phase === "warning") &&
            (docStart > (L.warningAt || 0) + 300 || (appeared && Date.now() - (L.warningAt || 0) > 10000))));
      if (stale) {
        delete state.launches[tabId];
        L = null;
      }
      // Latido tardio del documento anterior a una recarga nuestra: ignorar.
      if (L && L.navAt && docStart < L.navAt - 300) return;
      if (!L) {
        // Un intento nuevo solo nace con la APARICION del aviso, o con el
        // latido de una lanzadera. Los latidos de otras paginas con el aviso
        // aun visible no crean intentos (si no, el visor se traeria al frente
        // una y otra vez mientras el aviso siga en pantalla).
        if (!appeared && !(msg.role === "launcher" && msg.type === "pacs-dm:heartbeat")) return;
        L = state.launches[tabId] = { tabId, kind: msg.role, startedAt: docStart, navAt: docStart, attempt: 1, phase: "pending" };
        saveState();
      }
      if ((appeared || msg.warning) && !L.warningAt && L.phase === "pending") {
        if (msg.sample) log("info", `Texto del aviso: "${msg.sample}"`);
        await handleWarning(L);
      }
      await checkLaunch(L);
      return;
    }
    case "pacs-dm:viewer-start": {
      if (tabId == null) return;
      upsertManaged(tabId, { startDpr: msg.start && msg.start.dpr });
      if (msg.start && Math.abs(msg.start.dpr - 1) > 0.01) {
        log("info", `El visor nació con escala ${pct(msg.start.dpr)} (devicePixelRatio).`);
      }
      return;
    }
    case "pacs-dm:viewer-report":
      if (tabId != null) await onViewerReport(tabId, msg.report, sender);
      return;
    case "pacs-dm:viewer-health":
      if (tabId != null) await onViewerHealth(tabId, msg);
      return;
    case "pacs-dm:viewport":
      if (tabId != null) await onViewportMeasured(tabId, msg, sender);
      return;
    case "pacs-dm:remeasure":
      learnedInsets = null;
      await chrome.storage.local.remove("frameInsets");
      log("info", "Bordes de la ventana: se volverán a medir con el próximo visor.");
      return { ok: true, insets: effectiveInsets() };
    case "pacs-dm:viewer-input":
      if (tabId != null && state.managed[tabId]) upsertManaged(tabId, { inputAt: Date.now() });
      return;
    case "pacs-dm:page-event": {
      if (tabId == null || !msg.event) return;
      const n = (pageEventCount.get(tabId) || 0) + 1;
      pageEventCount.set(tabId, n);
      const ev = msg.event;
      if (ev.type === "dialog" && /zoom/i.test(ev.message || "")) {
        log("warn", `Synapse avisó sobre el zoom: "${ev.message}"`);
        await ensureZoom100(tabId, "aviso de Synapse");
        noticeTab(tabId, "warn", "Synapse avisó que el zoom no estaba en 100%. Ya quedó en 100%: recarga el visor antes de medir.", {
          sticky: true,
          key: "zoom-alert",
          actions: [{ id: "reload", label: "Recargar visor" }],
        });
      } else if (n <= 15) {
        if (ev.type === "window-call") {
          log("info", `Synapse intentó ${ev.name}(${(ev.args || []).join(", ")})${ev.blocked ? " — bloqueado" : ""}`);
        } else if (ev.type === "dialog") {
          // El texto de otros alert() podria traer datos del paciente: no se guarda.
          log("info", `Synapse mostró un ${ev.name}().`);
        } else {
          const safe = {};
          for (const [k, v] of Object.entries(ev)) safe[k] = typeof v === "string" ? maskIds(v) : v;
          log("warn", `Página: ${ev.type}`, safe);
        }
      }
      return;
    }
    case "pacs-dm:action": {
      if (tabId == null) return;
      if (msg.id === "reload") {
        log("info", "Recarga del visor pedida desde el aviso.");
        await chrome.tabs.reload(tabId);
      } else if (msg.id === "reposition") {
        await repositionViewerNow("aviso", tabId);
      } else if (msg.id === "options") {
        await chrome.runtime.openOptionsPage();
      } else if (typeof msg.id === "string" && msg.id.startsWith("retry-launch:")) {
        await userRetryLaunch(Number(msg.id.split(":")[1]), tabId);
      }
      return;
    }
    case "pacs-dm:status":
      return getStatus();
    case "pacs-dm:reposition":
      return repositionViewerNow("opciones");
    case "pacs-dm:clear-log":
      await clearLog();
      state.warned = {};
      state.alerts = {};
      saveState();
      refreshBadge();
      return;
    default:
      return;
  }
}

async function getStatus() {
  await flushLog();
  const displays = await getDisplays(true);
  const pick = G.pickViewerDisplays(displays, {
    displayIds: settings.displayIds,
    singleMonitorFallback: settings.singleMonitorFallback,
  });
  const managed = [];
  for (const rec of Object.values(state.managed)) {
    const w = rec.windowId != null ? await chrome.windows.get(rec.windowId).catch(() => null) : null;
    const zoom = await chrome.tabs.getZoom(rec.tabId).catch(() => null);
    managed.push(Object.assign({}, rec, { current: box(w), zoom }));
  }
  const { log: entries = [] } = await chrome.storage.session.get("log");
  return {
    version: chrome.runtime.getManifest().version,
    settings,
    defaults: DEFAULT_SETTINGS,
    displays,
    pick: pick && {
      ids: pick.displays.map((d) => d.id),
      reason: pick.reason,
      warnings: pick.warnings,
      bounds: G.targetBounds(pick.displays, effectiveInsets()),
    },
    managed,
    insets: effectiveInsets(),
    learnedInsets,
    launches: Object.values(state.launches),
    alerts: state.alerts,
    log: entries,
  };
}

// =====================================================================
// Instalacion / actualizacion
// =====================================================================
// Al instalar o actualizar, Chrome no inyecta los content scripts en las
// pestanas ya abiertas: sin esto, el visor abierto no podria informar nada
// (y no se podria verificar si recibio un estudio).
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: `https://${HOST}/*` });
  for (const t of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, world: "MAIN", files: ["page-guard.js"] });
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ["content.js"] });
    } catch (e) {
      log("info", `No pude preparar la pestaña ${t.id} ya abierta.`, String(e));
    }
  }
  return tabs.length;
}

chrome.runtime.onInstalled.addListener((details) => {
  track(
    (async () => {
      await ready;
      if (details.reason === "install" || details.reason === "update") {
        const n = await injectIntoOpenTabs();
        if (n) log("info", `Preparadas ${n} pestaña(s) de Synapse ya abiertas.`);
      }
      // Adoptar visores ya abiertos (p.ej. tras actualizar la extension).
      for (const t of await findViewerTabs()) {
        if (!state.managed[t.id]) upsertManaged(t.id, { role: "viewer", windowId: t.windowId, path: shortUrl(t.url), navKey: urlKey(t.url), navAt: Date.now() });
      }
      refreshBadge();
      log("info", `Extensión ${details.reason === "install" ? "instalada" : "actualizada"} (v${chrome.runtime.getManifest().version}).`);
    })()
  );
});

chrome.runtime.onStartup.addListener(() => track(ready.then(refreshBadge)));
