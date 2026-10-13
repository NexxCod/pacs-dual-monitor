// Pruebas E2E de la extension en Chromium real contra un Synapse simulado.
//
// Requisitos: Linux con Xvfb, openssl y Playwright (npm i -D playwright, o
// global con NODE_PATH). Ejecutar:
//   xvfb-run -a -s "-screen 0 5760x1200x24" node --test tests/e2e/
//
// Los tres monitores (notebook + dos externos) se simulan reemplazando
// chrome.system.display.getInfo en el service worker.

const { describe, it: nodeIt, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const mock = require("./mock-synapse.js");

const EXT = path.resolve(__dirname, "..", "..");
const ORIGIN = "https://sjdpacs.synapsetimed.cl";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function display(id, name, left, extra) {
  return Object.assign(
    {
      id: String(id),
      name,
      isPrimary: false,
      isInternal: false,
      isEnabled: true,
      mirroringSourceId: "",
      dpiX: 0,
      dpiY: 0,
      bounds: { left, top: 0, width: 1920, height: 1080 },
      workArea: { left, top: 0, width: 1920, height: 1080 },
    },
    extra || {}
  );
}
const DISPLAYS = [
  display(1, "Notebook", 0, { isPrimary: true, isInternal: true, workArea: { left: 0, top: 0, width: 1920, height: 1040 } }),
  display(2, "Externo A", 1920),
  display(3, "Externo B", 3840),
];
const TARGET = { left: 1920, top: 0, width: 3840, height: 1080 };
const TEST_SETTINGS = { invisibleBorder: 0, guardSeconds: 12 };

let server;
let ctx;
let sw;
let worklist;

async function waitFor(fn, { timeout = 10000, interval = 100, what = "condición" } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timeout esperando ${what} (último valor: ${last && last.message ? last.message : JSON.stringify(last)})`);
}

async function getSw() {
  const workers = ctx.serviceWorkers();
  if (workers.length) return workers[0];
  return ctx.waitForEvent("serviceworker", { timeout: 10000 });
}

// Reinstala los monitores simulados (por si Chrome reinicio el service worker).
async function patchDisplays(list) {
  sw = await getSw();
  await sw.evaluate((displays) => {
    chrome.system.display.getInfo = async () => JSON.parse(JSON.stringify(displays));
    self.__pacsTestDisplays = true;
  }, list || DISPLAYS);
}

async function swEval(fn, arg) {
  sw = await getSw();
  const patched = await sw.evaluate(() => !!self.__pacsTestDisplays);
  if (!patched) await patchDisplays();
  return sw.evaluate(fn, arg);
}

async function setSettings(patch) {
  await swEval((p) => chrome.storage.local.set({ settings: p }), Object.assign({}, TEST_SETTINGS, patch || {}));
  await sleep(100);
}

async function logText() {
  return swEval(async () => {
    await flushLog();
    const { log = [] } = await chrome.storage.session.get("log");
    return log.map((e) => `[${e.level}] ${e.msg}`).join("\n");
  });
}

async function tabsInfo() {
  return swEval(async () => {
    const wins = await chrome.windows.getAll({ populate: true });
    const out = [];
    for (const w of wins) {
      for (const t of w.tabs) {
        out.push({
          tabId: t.id,
          windowId: w.id,
          type: w.type,
          url: t.url || t.pendingUrl || "",
          bounds: { left: w.left, top: w.top, width: w.width, height: w.height },
          tabsInWindow: w.tabs.length,
        });
      }
    }
    return out;
  });
}

function viewerPages() {
  return ctx.pages().filter((p) => !p.isClosed() && p.url().includes("/ImageViewer/layout"));
}

async function waitViewer(study, opts) {
  return waitFor(
    async () => {
      for (const p of viewerPages()) {
        // Con tiempo limite: un visor bloqueado por un alert() no contesta.
        const s = await Promise.race([
          p.evaluate(() => window.__viewer && { study: window.__viewer.study, loaded: window.__viewer.loaded }).catch(() => null),
          sleep(800).then(() => null),
        ]);
        if (s && s.loaded && (!study || s.study === study)) return p;
      }
      return null;
    },
    Object.assign({ timeout: 15000, what: `visor con estudio ${study}` }, opts || {})
  );
}

// Eventos resize en que cambio la ventana (no solo la barra del navegador).
function windowChanges(s) {
  return s.resizes.filter(
    (r) => r.ow !== s.startOW || r.oh !== s.startOH || r.sx !== s.startX || r.sy !== s.startY || r.dpr !== s.startDpr || r.w !== s.startW
  );
}

function near(a, b, tol = 3) {
  return (
    Math.abs(a.left - b.left) <= tol &&
    Math.abs(a.top - b.top) <= tol &&
    Math.abs(a.width - b.width) <= tol &&
    Math.abs(a.height - b.height) <= tol
  );
}

async function viewerWindow(page) {
  const url = page.url();
  const info = await tabsInfo();
  return info.find((t) => t.url === url);
}

async function resetWorld() {
  // Cerrar todo menos la worklist, soltar el candado y limpiar el estado.
  const info = await tabsInfo();
  const wlTab = info.find((t) => t.url.includes("/Synapse/Web"));
  await swEval(async (keep) => {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w.id !== keep.windowId) await chrome.windows.remove(w.id).catch(() => {});
      else for (const t of w.tabs) if (t.id !== keep.tabId) await chrome.tabs.remove(t.id).catch(() => {});
    }
  }, wlTab);
  await sleep(300);
  await worklist.evaluate(() => localStorage.removeItem("synapseViewerLock"));
  await swEval(async () => {
    state.managed = {};
    state.launches = {};
    state.warned = {};
    state.alerts = {};
    saveState();
    await clearLog();
  });
  await setSettings();
  await swEval(async (tabId) => chrome.tabs.setZoom(tabId, 1), wlTab.tabId);
}

// Si una prueba falla, adjunta el registro de la extension al error.
function it(name, fn) {
  return nodeIt(name, async (t) => {
    try {
      await fn(t);
    } catch (e) {
      const log = await logText().catch(() => "(sin registro)");
      e.message += "\n--- registro de la extensión ---\n" + log;
      throw e;
    }
  });
}

describe("PACS Dual Monitor (Chromium real + Synapse simulado)", { timeout: 600000 }, () => {
  before(async () => {
    server = await mock.start(0);
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacs-e2e-"));
    ctx = await chromium.launchPersistentContext(userDir, {
      headless: false,
      viewport: null,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        `--host-resolver-rules=MAP sjdpacs.synapsetimed.cl 127.0.0.1:${server.address().port}`,
        "--ignore-certificate-errors",
        "--no-proxy-server",
        "--no-first-run",
        "--window-position=0,0",
        "--window-size=1200,800",
      ],
    });
    await patchDisplays();
    worklist = ctx.pages()[0] || (await ctx.newPage());
    await worklist.goto(`${ORIGIN}/Synapse/Web`);
  });

  after(async () => {
    if (ctx) await ctx.close();
    if (server) server.close();
  });

  beforeEach(async () => {
    await resetWorld();
  });

  it("A) popup: la ventana se ubica antes de que cargue el visor, que nace con su tamaño final; resizeTo de Synapse bloqueado", async () => {
    await worklist.evaluate(() => window.openStudy("A1", "popup"));
    const page = await waitViewer("A1");
    await sleep(1500); // Synapse "restaura" su posicion 300 ms despues de cargar
    const v = await page.evaluate(() => ({
      s: window.__viewer,
      now: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, x: screenX },
    }));
    assert.equal(v.s.restoreAttempted, true, "el visor simulado intentó resizeTo/moveTo");
    // Lo que controla la extension: la ventana (tamano exterior y posicion) y
    // la escala no cambian despues de que nace el visor. (En Linux sin gestor
    // de ventanas Chrome muestra/oculta la barra del popup al inicio, lo que
    // cambia solo el alto interno; en Windows eso no ocurre.)
    assert.deepEqual(windowChanges(v.s), [], "la ventana del visor no debe moverse, redimensionarse ni cambiar de escala después de nacer");
    assert.equal(v.s.startW, v.now.w);
    assert.equal(v.s.startDpr, v.now.dpr);
    const win = await viewerWindow(page);
    assert.equal(win.type, "popup");
    assert.ok(near(win.bounds, TARGET), `ventana en ${JSON.stringify(win.bounds)}`);
    const log = await logText();
    assert.match(log, /ubicada \(lanzadera\)/);
    assert.match(log, /resizeTo\(800, 600\) — bloqueado/);
    assert.match(log, /Estudio abierto: la lanzadera abrió el visor/);
    const st = await swEval(() => getStatus());
    assert.equal(st.launches.length, 0);
  });

  it("B) lanzadera como pestaña de la worklist: se saca a un popup ubicado, no se cierra como 'huérfano' y la worklist queda intacta", async () => {
    const before = await tabsInfo();
    const wl = before.find((t) => t.url.includes("/Synapse/Web"));
    await worklist.evaluate(() => window.openStudy("B1", "tab"));
    const page = await waitViewer("B1");
    await sleep(2500);
    assert.ok(!page.isClosed(), "el visor no debe cerrarse");
    const win = await viewerWindow(page);
    assert.equal(win.type, "popup");
    assert.notEqual(win.windowId, wl.windowId);
    assert.ok(near(win.bounds, TARGET), `ventana en ${JSON.stringify(win.bounds)}`);
    const after = await tabsInfo();
    const wl2 = after.find((t) => t.url.includes("/Synapse/Web"));
    assert.equal(wl2.windowId, wl.windowId, "la worklist sigue en su ventana");
    assert.deepEqual(wl2.bounds, wl.bounds, "la ventana de la worklist no se movió");
    const s = await page.evaluate(() => window.__viewer);
    assert.deepEqual(windowChanges(s), []);
  });

  it("C) aviso 'abierta en otra ventana' con visor vivo: el estudio llega al visor existente y la lanzadera se cierra", async () => {
    await worklist.evaluate(() => window.openStudy("C0", "popup"));
    const viewer = await waitViewer("C0");
    const t0 = Date.now();
    await worklist.evaluate(() => window.openStudy("C1", "popup"));
    await waitFor(async () => (await viewer.evaluate(() => window.__viewer.study)) === "C1", { what: "entrega de C1" });
    await waitFor(async () => !(await tabsInfo()).some((t) => t.url.includes("/WebQuery/Index")), {
      timeout: 8000,
      what: "cierre de la lanzadera",
    });
    const secs = (Date.now() - t0) / 1000;
    assert.ok(secs < 6, `la lanzadera se cerró en ${secs}s`);
    assert.ok(!viewer.isClosed(), "el visor existente sigue abierto");
    assert.equal(viewerPages().length, 1);
    const log = await logText();
    assert.match(log, /abierta en otra ventana/);
    assert.match(log, /entregado al visor existente/);
  });

  it("D) visor zombie (no recibe el estudio): se cierra, se reintenta y el estudio abre", async () => {
    await worklist.evaluate(() => window.openStudy("Z0", "popup", "zombie=1"));
    const zombie = await waitViewer("Z0");
    await worklist.evaluate(() => window.openStudy("D1", "popup"));
    const page = await waitViewer("D1", { timeout: 25000 });
    assert.ok(zombie.isClosed(), "el visor zombie se cerró");
    const win = await viewerWindow(page);
    assert.ok(near(win.bounds, TARGET), `ventana en ${JSON.stringify(win.bounds)}`);
    const log = await logText();
    assert.match(log, /zombie/);
    assert.match(log, /Reintentando abrir el estudio \(2\/3\)/);
    assert.match(log, /Estudio abierto: la lanzadera abrió el visor/);
  });

  it("E) candado pegado sin visor: reintenta con espera creciente hasta que abre", async () => {
    await worklist.evaluate(() => localStorage.setItem("synapseViewerLock", JSON.stringify({ ts: Date.now() + 1500 })));
    await worklist.evaluate(() => window.openStudy("E1", "popup"));
    const page = await waitViewer("E1", { timeout: 25000 });
    const win = await viewerWindow(page);
    assert.ok(near(win.bounds, TARGET));
    const log = await logText();
    assert.match(log, /no hay ningún visor abierto/);
    assert.match(log, /Estudio abierto: la lanzadera abrió el visor \([\d.]+s, intento [23]\)/);
  });

  it("F) candado pegado permanente: tras 3 intentos avisa que no pudo abrir", async () => {
    await worklist.evaluate(() => localStorage.setItem("synapseViewerLock", JSON.stringify({ ts: Date.now() + 3600000 })));
    await worklist.evaluate(() => window.openStudy("F1", "popup"));
    await waitFor(async () => /No se pudo abrir el estudio tras 3 intentos/.test(await logText()), {
      timeout: 25000,
      what: "fallo final",
    });
    const st = await swEval(() => getStatus());
    assert.ok(st.alerts.launch, "alerta en el icono");
    assert.equal(st.launches[0].phase, "failed");
    const badge = await swEval(() => chrome.action.getBadgeText({}));
    assert.equal(badge, "!");
  });

  it("G) guardia: si otro programa mueve la ventana durante la carga se restaura; pasada la guardia se respeta", async () => {
    await setSettings({ guardSeconds: 3 });
    await worklist.evaluate(() => window.openStudy("G1", "popup"));
    const page = await waitViewer("G1");
    const win = await viewerWindow(page);
    await swEval((id) => chrome.windows.update(id, { left: 50, top: 50, width: 900, height: 700 }), win.windowId);
    await waitFor(async () => near((await viewerWindow(page)).bounds, TARGET), { timeout: 3000, what: "restauración" });
    assert.match(await logText(), /Guardia: algo movió la ventana/);
    await sleep(3500);
    await swEval((id) => chrome.windows.update(id, { left: 60, top: 60, width: 900, height: 700 }), win.windowId);
    await sleep(1200);
    const after = await viewerWindow(page);
    assert.ok(near(after.bounds, { left: 60, top: 60, width: 900, height: 700 }), "fuera de la guardia se respeta al usuario");
    // Reubicacion manual (equivale a Ctrl+Shift+Y)
    const r = await swEval(() => repositionViewerNow("prueba"));
    assert.equal(r.ok, true);
    assert.ok(near((await viewerWindow(page)).bounds, TARGET));
  });

  it("H) zoom: Synapse queda en 100% y Ctrl+rueda no cambia el zoom en el visor", async () => {
    const wl = (await tabsInfo()).find((t) => t.url.includes("/Synapse/Web"));
    await swEval((id) => chrome.tabs.setZoom(id, 1.5), wl.tabId);
    await waitFor(async () => (await swEval((id) => chrome.tabs.getZoom(id), wl.tabId)) === 1, { timeout: 3000, what: "zoom 100%" });
    await worklist.evaluate(() => window.openStudy("H1", "popup"));
    const page = await waitViewer("H1");
    assert.equal(await page.evaluate(() => devicePixelRatio), 1);
    await page.mouse.move(400, 400);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -300);
    await page.keyboard.press("Equal");
    await page.keyboard.up("Control");
    await sleep(600);
    const tab = await viewerWindow(page);
    assert.equal(await swEval((id) => chrome.tabs.getZoom(id), tab.tabId), 1);
    assert.equal(await page.evaluate(() => devicePixelRatio), 1);
  });

  it("I) la escala cambia después de iniciar: sin uso → recarga automática; con uso → aviso con botón", async () => {
    await worklist.evaluate(() => window.openStudy("I1", "popup"));
    let page = await waitViewer("I1");
    await sleep(800);
    const t0 = await page.evaluate(() => window.__viewer.t0);
    const tab = await viewerWindow(page);
    // Otro programa cambia el zoom (escala) del visor ya iniciado.
    await setSettings({ forceZoom100: false });
    await swEval((id) => chrome.tabs.setZoom(id, 1.25), tab.tabId);
    await sleep(300);
    await swEval((id) => chrome.tabs.setZoom(id, 1), tab.tabId);
    await setSettings();
    await waitFor(async () => (await page.evaluate(() => window.__viewer && window.__viewer.t0).catch(() => 0)) > t0, {
      timeout: 12000,
      what: "recarga automática",
    });
    assert.match(await logText(), /Recargando el visor automáticamente: La escala del visor cambió/);
    // Con uso: no recarga, avisa.
    page = await waitViewer("I1");
    await sleep(500);
    await page.mouse.click(500, 500);
    const t1 = await page.evaluate(() => window.__viewer.t0);
    await setSettings({ forceZoom100: false });
    await swEval((id) => chrome.tabs.setZoom(id, 1.25), tab.tabId);
    await sleep(300);
    await swEval((id) => chrome.tabs.setZoom(id, 1), tab.tabId);
    await setSettings();
    await waitFor(async () => /Visor con problema \(aviso al usuario\): La escala del visor cambió/.test(await logText()), {
      timeout: 8000,
      what: "aviso con uso",
    });
    assert.equal(await page.evaluate(() => window.__viewer.t0), t1, "no recargó");
  });

  it("J) pantalla negra por pérdida del contexto gráfico: recarga automática", async () => {
    await worklist.evaluate(() => window.openStudy("J1", "popup", "webgl=1"));
    const page = await waitViewer("J1");
    const t0 = await page.evaluate(() => window.__viewer.t0);
    assert.equal(await page.evaluate(() => window.__viewer.loseContext()), true);
    await waitFor(async () => (await page.evaluate(() => window.__viewer && window.__viewer.t0).catch(() => 0)) > t0, {
      timeout: 10000,
      what: "recarga tras perder el contexto",
    });
    assert.match(await logText(), /perdió el contexto gráfico/);
  });

  it("K) cambio de monitores: el visor se reubica en los nuevos externos", async () => {
    await worklist.evaluate(() => window.openStudy("K1", "popup"));
    const page = await waitViewer("K1");
    const moved = [
      DISPLAYS[0],
      display(2, "Externo A", 1920, { bounds: { left: 1920, top: 0, width: 1920, height: 1080 }, workArea: { left: 1920, top: 0, width: 1920, height: 1040 } }),
      display(3, "Externo B", 3840, { bounds: { left: 3840, top: 0, width: 1920, height: 1080 }, workArea: { left: 3840, top: 0, width: 1920, height: 1040 } }),
    ];
    await patchDisplays(moved);
    await swEval(async () => {
      displayCache = null;
      await onDisplaysSettled();
    });
    const win = await viewerWindow(page);
    assert.ok(near(win.bounds, { left: 1920, top: 0, width: 3840, height: 1040 }), JSON.stringify(win.bounds));
    await patchDisplays(DISPLAYS);
    await swEval(async () => {
      displayCache = null;
      await onDisplaysSettled();
    });
    assert.ok(near((await viewerWindow(page)).bounds, TARGET));
    // Un monitor se apaga y vuelve: Windows dejo la ventana en el principal.
    await setSettings({ guardSeconds: 0 });
    await sleep(300);
    const w = await viewerWindow(page);
    await swEval((id) => chrome.windows.update(id, { left: 0, top: 0, width: 1000, height: 700 }), w.windowId);
    await sleep(500);
    assert.ok(near((await viewerWindow(page)).bounds, { left: 0, top: 0, width: 1000, height: 700 }));
    await swEval(async () => {
      displayCache = null;
      await onDisplaysSettled();
    });
    assert.ok(near((await viewerWindow(page)).bounds, TARGET), "vuelve a los externos");
  });

  it("M) aviso dentro del propio visor: se recarga y abre; si persiste, se detiene sin bucle", async () => {
    await worklist.evaluate(() => window.open("/ImageViewer/layout?study=M1&selfWarn=once", "vM1", "width=800,height=600"));
    await waitFor(async () => /Estudio abierto|Reintento 2\/3: recargando la ventana del visor/.test(await logText()), {
      timeout: 10000,
      what: "reintento del visor",
    });
    const page = await waitViewer("M1");
    await sleep(2500);
    assert.equal(await page.evaluate(() => !!window.__viewer.selfWarned), false, "tras recargar ya no muestra el aviso");
    await worklist.evaluate(() => window.open("/ImageViewer/layout?study=M2&selfWarn=always", "vM2", "width=800,height=600"));
    await waitFor(async () => /No se pudo abrir el estudio tras 3 intentos/.test(await logText()), { timeout: 20000, what: "fallo final" });
    const reloads = (await logText()).match(/Reintento \d\/3: recargando la ventana del visor/g) || [];
    await sleep(4000);
    const reloads2 = (await logText()).match(/Reintento \d\/3: recargando la ventana del visor/g) || [];
    assert.equal(reloads2.length, reloads.length, "no sigue recargando");
  });

  it("N) aviso dentro de la worklist (cuando sea que aparezca): trae el visor al frente; sin visor, avisa", async () => {
    const show = () =>
      worklist.evaluate(() => {
        const d = document.createElement("div");
        d.id = "warn";
        d.textContent = "La aplicación se encuentra abierta en otra ventana.";
        document.body.appendChild(d);
      });
    const hide = () => worklist.evaluate(() => document.getElementById("warn").remove());
    await worklist.evaluate(() => window.openStudy("N1", "popup"));
    await waitViewer("N1");
    await show();
    await waitFor(async () => /aviso en otra página; visor existente al frente/.test(await logText()), { what: "visor al frente" });
    await hide();
    await sleep(10500);
    await show();
    await waitFor(async () => ((await logText()).match(/aviso en otra página; visor existente al frente/g) || []).length === 2, {
      what: "segundo aviso",
    });
    await hide();
    // Sin ningun visor abierto: candado pegado fuera de este Chrome.
    for (const p of viewerPages()) await p.close();
    await sleep(500);
    await swEval(async () => {
      state.launches = {};
      saveState();
    });
    await show();
    await waitFor(async () => /no hay ningún visor en este Chrome/.test(await logText()), { what: "aviso sin visor" });
    const st = await swEval(() => getStatus());
    assert.match(st.alerts.launch.text, /no está en este Chrome/);
    await hide();
  });

  it("O) visor que dibuja en un iframe: el uso dentro del iframe evita recargas; contexto gráfico perdido en el iframe → recarga", async () => {
    await worklist.evaluate(() => window.openStudy("O1", "popup", "iframe=1"));
    const page = await waitViewer("O1");
    await sleep(800);
    const frame = await waitFor(() => page.frames().find((f) => f.url().includes("/ImageViewer/frame")), { what: "iframe" });
    await page.mouse.click(300, 300);
    await waitFor(async () => (await frame.evaluate(() => window.__frame.clicks)) > 0, { what: "click en el iframe" });
    const tab = await viewerWindow(page);
    await waitFor(async () => (await swEval((id) => state.managed[id] && state.managed[id].inputAt, tab.tabId)) > 0, {
      what: "uso registrado",
    });
    const t0 = await page.evaluate(() => window.__viewer.t0);
    await setSettings({ forceZoom100: false });
    await swEval((id) => chrome.tabs.setZoom(id, 1.25), tab.tabId);
    await sleep(300);
    await swEval((id) => chrome.tabs.setZoom(id, 1), tab.tabId);
    await setSettings();
    await waitFor(async () => /Visor con problema \(aviso al usuario\): La escala del visor cambió/.test(await logText()), {
      timeout: 8000,
      what: "aviso (visor en uso)",
    });
    assert.equal(await page.evaluate(() => window.__viewer.t0), t0, "no recargó un visor en uso");

    await page.close();
    await worklist.evaluate(() => window.openStudy("O2", "popup", "iframe=1&webgl=1"));
    const page2 = await waitViewer("O2");
    const frame2 = await waitFor(() => page2.frames().find((f) => f.url().includes("/ImageViewer/frame")), { what: "iframe" });
    await waitFor(() => frame2.evaluate(() => !!(window.__frame && window.__frame.loseContext)), { what: "webgl en iframe" });
    const t2 = await page2.evaluate(() => window.__viewer.t0);
    assert.equal(await frame2.evaluate(() => window.__frame.loseContext()), true);
    await waitFor(async () => (await page2.evaluate(() => window.__viewer && window.__viewer.t0).catch(() => 0)) > t2, {
      timeout: 10000,
      what: "recarga tras perder el contexto en el iframe",
    });
  });

  it("P) aviso que queda visible en la worklist: el visor se trae al frente UNA sola vez", async () => {
    await worklist.evaluate(() => window.openStudy("P1", "popup"));
    await waitViewer("P1");
    await worklist.evaluate(() => {
      const d = document.createElement("div");
      d.id = "warn";
      d.textContent = "La aplicación se encuentra abierta en otra ventana.";
      document.body.appendChild(d);
    });
    await sleep(6000);
    const n = ((await logText()).match(/aviso en otra página; visor existente al frente/g) || []).length;
    await worklist.evaluate(() => document.getElementById("warn").remove());
    assert.equal(n, 1, "no debe robar el foco repetidamente");
  });

  it("Q) visor colgado que no contesta: no se cierra a ciegas, se pregunta; visor en uso: nunca se cierra", async () => {
    // Visor en su propio proceso (pestaña aparte), que se cuelga.
    const hung = await ctx.newPage();
    await hung.goto(`${ORIGIN}/ImageViewer/layout?study=Q0&zombie=1`);
    await sleep(1200);
    await worklist.evaluate(() => localStorage.setItem("synapseViewerLock", JSON.stringify({ ts: Date.now() + 120000 })));
    hung.evaluate(() => {
      const end = Date.now() + 60000;
      while (Date.now() < end) {}
    }).catch(() => {});
    await sleep(300);
    const alive = await Promise.race([worklist.evaluate(() => true), sleep(2000).then(() => false)]);
    assert.ok(alive, "la worklist sigue respondiendo (el visor colgado está en otro proceso)");
    await worklist.evaluate(() => window.openStudy("Q1", "popup"));
    await waitFor(async () => /se pregunta al usuario/.test(await logText()), { timeout: 25000, what: "pregunta al usuario" });
    assert.ok((await tabsInfo()).some((t) => t.url.includes("study=Q0")), "el visor que no contestó NO se cerró solo");
    // El usuario pulsa "Cerrar visor y reintentar".
    await worklist.evaluate(() => localStorage.removeItem("synapseViewerLock"));
    const st = await swEval(() => getStatus());
    const L = st.launches.find((x) => x.phase === "awaiting-user");
    assert.ok(L, "intento esperando al usuario");
    const wl = (await tabsInfo()).find((t) => t.url.includes("/Synapse/Web"));
    await swEval(([a, b]) => userRetryLaunch(a, b), [L.tabId, wl.tabId]);
    const page = await waitViewer("Q1", { timeout: 15000 });
    assert.ok(near((await viewerWindow(page)).bounds, TARGET));
    assert.ok(!(await tabsInfo()).some((t) => t.url.includes("study=Q0")), "el visor colgado se cerró al confirmar");

    // En uso: un visor que no recibe el estudio pero que estás usando no se cierra.
    for (const p of viewerPages()) await p.close();
    await worklist.evaluate(() => localStorage.removeItem("synapseViewerLock"));
    await worklist.evaluate(() => window.openStudy("Q2", "popup", "zombie=1"));
    const used = await waitViewer("Q2");
    await sleep(300);
    await worklist.evaluate(() => window.openStudy("Q3", "popup"));
    await sleep(1500);
    await used.mouse.click(400, 400);
    await waitFor(async () => /visor existente en uso/.test(await logText()), { timeout: 12000, what: "visor en uso" });
    await sleep(500);
    assert.ok(!used.isClosed(), "el visor en uso sigue abierto");
    assert.ok(!(await tabsInfo()).some((t) => t.url.includes("/WebQuery/Index")), "la lanzadera se cerró");
  });

  it("R) sin monitores externos al abrir y luego se conectan: el visor pasa a los externos y la worklist no se toca", async () => {
    await patchDisplays([DISPLAYS[0]]);
    await swEval(() => {
      displayCache = null;
      lastGoodDisplayCount = 0;
    });
    const wlBefore = (await tabsInfo()).find((t) => t.url.includes("/Synapse/Web"));
    await worklist.evaluate(() => window.openStudy("R1", "tab"));
    const page = await waitViewer("R1");
    let v = await viewerWindow(page);
    assert.equal(v.windowId, wlBefore.windowId, "sin externos, queda como pestaña de la worklist");
    await patchDisplays(DISPLAYS);
    await swEval(async () => {
      displayCache = null;
      await onDisplaysSettled();
    });
    v = await viewerWindow(page);
    assert.equal(v.type, "popup");
    assert.ok(near(v.bounds, TARGET), JSON.stringify(v.bounds));
    const wlAfter = (await tabsInfo()).find((t) => t.url.includes("/Synapse/Web"));
    assert.deepEqual(wlAfter.bounds, wlBefore.bounds, "la ventana de la worklist no se movió");
  });

  it("S) dos visores que abren a la vez: queda exactamente uno (el más reciente)", async () => {
    await worklist.evaluate(() => {
      window.open("/ImageViewer/layout?study=S1", "vS1", "width=800,height=600");
      window.open("/ImageViewer/layout?study=S2", "vS2", "width=800,height=600");
    });
    await sleep(5000);
    const left = viewerPages();
    assert.equal(left.length, 1, `quedan ${left.length} visores`);
  });

  it("L) error HTTP 500 al abrir el visor: recarga automática; la página de Opciones muestra el estado", async () => {
    await worklist.evaluate(() => window.open("/ImageViewer/layout?study=L1&status=500", "v500", "width=800,height=600"));
    await waitFor(async () => /Recargando el visor automáticamente: El servidor respondió con error \(HTTP 500\)/.test(await logText()), {
      timeout: 10000,
      what: "recarga por HTTP 500",
    });
    const extId = new URL(sw.url()).host;
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${extId}/options.html`);
    await waitFor(async () => (await opt.locator("#displays tbody tr").count()) === 3, { what: "tabla de monitores" });
    assert.match(await opt.locator("#target").innerText(), /1920, 0 · 3840×1080/);
    assert.ok((await opt.locator("#log li").count()) > 0);
    await opt.close();
  });

  it("T) reinyección al instalar/actualizar con Synapse abierto: no duplica y reemplaza instancias desconectadas", async () => {
    await worklist.evaluate(() => window.openStudy("T1", "popup"));
    const page = await waitViewer("T1");
    const tab = await viewerWindow(page);
    // 1) Con la instancia viva, reinyectar no la duplica.
    assert.ok((await swEval(() => injectIntoOpenTabs())) >= 2);
    await swEval((id) => noticeTab(id, "info", "prueba", { key: "t" }), tab.tabId);
    await sleep(300);
    assert.equal(await page.evaluate(() => document.querySelectorAll("pacs-dm-notices").length), 1);
    // 2) Instancia desconectada (como la que deja una actualización): se reemplaza.
    await swEval(
      (id) => chrome.scripting.executeScript({ target: { tabId: id }, func: () => { window.__pacsDmAlive = () => false; } }),
      tab.tabId
    );
    await swEval(() => injectIntoOpenTabs());
    const act = await swEval((id) => getActivity(id), tab.tabId);
    assert.ok(act && act.docStartedAt, "el visor abierto responde tras la reinyección");
    assert.match(await logText(), /^(?![\s\S]*No pude preparar)/, "sin errores de inyección");
  });

});
