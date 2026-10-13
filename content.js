// content.js
// Corre (mundo aislado) en todas las paginas de Synapse y hace de "sensor y
// actuador" para background.js:
//
// - Cualquier pagina: detecta el aviso "La aplicacion se encuentra abierta en
//   otra ventana" y lo informa con latidos, para que el background verifique
//   que el estudio realmente se abra (y si no, recupere).
// - Lanzadera (/WebQuery/Index?winpass=true): envia latidos mientras espera
//   el traspaso al visor, para detectar si se quedo pegada.
// - Visor (/ImageViewer/layout): mide escala (devicePixelRatio) y tamano al
//   nacer y despues. Si cambian cuando Synapse ya inicializo, las mediciones
//   pueden quedar mal y el background decide recargar o avisar. Detecta
//   pantalla negra por perdida del contexto grafico (WebGL), imagenes
//   deformadas y errores HTTP. Bloquea el zoom accidental del navegador.
// - Muestra los avisos de la extension (esquina inferior izquierda).

(() => {
  "use strict";
  // Una sola instancia viva por pagina. Al actualizar la extension, la
  // instancia anterior queda desconectada y se vuelve a inyectar esta.
  try {
    if (window.__pacsDmAlive && window.__pacsDmAlive()) return;
  } catch (e) { /* instancia anterior invalida */ }
  window.__pacsDmAlive = () => {
    try {
      return !!chrome.runtime.id;
    } catch (e) {
      return false;
    }
  };

  const isTop = window === window.top;
  const where = location.pathname + location.search + location.hash;
  const IS_VIEWER = /\/ImageViewer\/layout/i.test(where);
  const IS_LAUNCHER = /\/WebQuery\/Index/i.test(where) && /winpass=true/i.test(where);
  // En un iframe, el rol lo define la pagina principal (si es del mismo origen).
  let topWhere = where;
  if (!isTop) {
    try {
      const t = window.top.location;
      topWhere = t.pathname + t.search + t.hash;
    } catch (e) { /* frame de otro origen */ }
  }
  const TOP_VIEWER = /\/ImageViewer\/layout/i.test(topWhere);
  const TOP_LAUNCHER = /\/WebQuery\/Index/i.test(topWhere) && /winpass=true/i.test(topWhere);
  const WARNING_RE = /abierta en otra ventana|open in another window/i;
  const pageStart = Date.now();
  // Inicio real del documento (reloj absoluto), aunque el script se inyecte tarde.
  const docStart = Math.round(performance.timeOrigin || pageStart);

  const DEFAULTS = { blockPageResize: true, forceZoom100: true, showNotices: true };
  let settings = Object.assign({}, DEFAULTS);

  function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (e) {
      return Promise.resolve(null); // la extension se recargo
    }
  }

  // ===================================================================
  // Opciones
  // ===================================================================
  function pushConfig() {
    try {
      window.dispatchEvent(
        new CustomEvent("pacs-dm:config", {
          detail: JSON.stringify({ allowResize: !settings.blockPageResize }),
        })
      );
    } catch (e) { /* nada */ }
  }
  try {
    chrome.storage.local.get("settings").then(
      (r) => {
        settings = Object.assign({}, DEFAULTS, (r && r.settings) || {});
        pushConfig();
      },
      pushConfig
    );
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.settings) {
        settings = Object.assign({}, DEFAULTS, changes.settings.newValue || {});
        pushConfig();
      }
    });
  } catch (e) {
    pushConfig();
  }

  // ===================================================================
  // Avisos en pantalla
  // ===================================================================
  const notices = isTop ? createNotices() : null;

  function createNotices() {
    let host = null;
    let stack = null;
    const items = new Map();

    function ensure() {
      if (host && host.isConnected) return stack;
      const parent = document.body || document.documentElement;
      if (!parent) return null;
      host = document.createElement("pacs-dm-notices");
      host.setAttribute(
        "style",
        "all:initial!important;position:fixed!important;left:14px!important;bottom:14px!important;" +
          "z-index:2147483647!important;pointer-events:none!important;display:block!important;"
      );
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML =
        "<style>" +
        ".stack{display:flex;flex-direction:column;gap:8px;max-width:470px;" +
        "font:13px/1.4 'Segoe UI',system-ui,sans-serif}" +
        ".n{pointer-events:auto;display:flex;gap:10px;align-items:flex-start;background:rgba(22,24,28,.96);" +
        "color:#eef0f3;border-left:4px solid #60a5fa;border-radius:6px;padding:9px 10px 9px 12px;" +
        "box-shadow:0 4px 18px rgba(0,0,0,.5)}" +
        ".n.warn{border-left-color:#f59e0b}.n.error{border-left-color:#ef4444}" +
        ".body{flex:1;min-width:0}.t{font-weight:600;font-size:11px;letter-spacing:.04em;" +
        "text-transform:uppercase;color:#9aa4b2;margin-bottom:2px}" +
        ".msg{white-space:pre-line}.acts{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}" +
        "button{font:inherit;font-size:12px;cursor:pointer;border-radius:4px;padding:3px 10px;" +
        "border:1px solid #4b5563;background:#374151;color:#fff}button:hover{background:#4b5563}" +
        ".x{background:transparent;border:0;color:#9aa4b2;font-size:16px;line-height:1;padding:0 2px}" +
        ".x:hover{background:transparent;color:#fff}" +
        "</style><div class='stack'></div>";
      stack = root.querySelector(".stack");
      parent.appendChild(host);
      return stack;
    }

    function show(n) {
      if (!settings.showNotices && n.level !== "error") return;
      const s = ensure();
      if (!s) {
        setTimeout(() => show(n), 400);
        return;
      }
      const key = n.key || n.text;
      const prev = items.get(key);
      if (prev) prev.remove();

      const el = document.createElement("div");
      el.className = "n " + (n.level || "info");
      const body = document.createElement("div");
      body.className = "body";
      const title = document.createElement("div");
      title.className = "t";
      title.textContent = "PACS Dual Monitor";
      const msg = document.createElement("div");
      msg.className = "msg";
      msg.textContent = n.text;
      body.append(title, msg);

      const close = () => {
        el.remove();
        if (items.get(key) === el) items.delete(key);
      };
      if (n.actions && n.actions.length) {
        const acts = document.createElement("div");
        acts.className = "acts";
        for (const a of n.actions) {
          const b = document.createElement("button");
          b.textContent = a.label;
          b.addEventListener("click", () => {
            send({ type: "pacs-dm:action", id: a.id });
            close();
          });
          acts.append(b);
        }
        body.append(acts);
      }
      const x = document.createElement("button");
      x.className = "x";
      x.title = "Cerrar";
      x.textContent = "×";
      x.addEventListener("click", close);
      el.append(body, x);

      items.set(key, el);
      s.append(el);
      while (s.children.length > 4) s.firstElementChild.remove();
      if (!n.sticky) setTimeout(close, n.level === "info" ? 7000 : 15000);
    }

    return { show };
  }

  // ===================================================================
  // Aviso "abierta en otra ventana" (todas las paginas y frames)
  // ===================================================================
  let hbTimer = null;
  let hbStart = 0;

  function warningVisible() {
    const b = document.body;
    if (!b) return false;
    // textContent es barato; innerText confirma que el texto esta visible.
    return WARNING_RE.test(b.textContent || "") && WARNING_RE.test(b.innerText || "");
  }

  function role() {
    return TOP_LAUNCHER ? "launcher" : TOP_VIEWER ? "viewer" : "other";
  }

  function startHeartbeat() {
    if (hbTimer) return;
    hbStart = Date.now();
    const beat = () => {
      hbTimer = null;
      if (Date.now() - hbStart > 90000) return;
      send({ type: "pacs-dm:heartbeat", role: role(), warning: warningVisible(), docStart });
      hbTimer = setTimeout(beat, 1500);
    };
    hbTimer = setTimeout(beat, 400);
  }

  // Se informa cada vez que el aviso APARECE (oculto -> visible). En la
  // worklist (pagina de larga vida) la vigilancia no vence; en el visor, que
  // cambia mucho su DOM, se limita a sus primeros 2 minutos.
  (function setupWarningDetector() {
    const lifetime = IS_VIEWER || IS_LAUNCHER ? 120000 : Infinity;
    const interval = IS_VIEWER ? 1500 : 300;
    let shown = false;
    let timer = null;
    let last = 0;
    const obs = new MutationObserver(schedule);

    function check() {
      timer = null;
      last = Date.now();
      if (Date.now() - pageStart > lifetime) {
        obs.disconnect();
        return;
      }
      const visible = warningVisible();
      if (visible === shown) return;
      shown = visible;
      if (!visible) return;
      const txt = (document.body && document.body.innerText) || "";
      const m = txt.match(/[^\n]*(abierta en otra ventana|open in another window)[^\n]*/i);
      send({
        type: "pacs-dm:warning",
        role: role(),
        frame: isTop ? "top" : "sub",
        docStart,
        sample: m ? m[0].trim().slice(0, 160) : "",
      });
      // Los latidos sirven para seguir el reintento de la lanzadera o del
      // visor; en la worklist no hacen falta.
      if (role() !== "other") startHeartbeat();
    }
    function schedule() {
      if (!timer) timer = setTimeout(check, Math.max(0, interval - (Date.now() - last)));
    }
    try {
      obs.observe(document, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* nada */ }
    schedule();
  })();

  if (isTop && IS_LAUNCHER) startHeartbeat();

  // ===================================================================
  // Zoom accidental del navegador (Ctrl+rueda, Ctrl +/-) en el visor
  // ===================================================================
  const inViewer = TOP_VIEWER;
  let inputAt = 0;
  let inputSentAt = 0;
  // Cualquier uso del visor (tambien dentro de iframes) se informa al
  // background: con el visor en uso nunca se recarga solo, solo se avisa.
  function markInput(e) {
    if (!e.isTrusted) return;
    inputAt = Date.now();
    if (inputAt - inputSentAt > 10000) {
      inputSentAt = inputAt;
      send({ type: "pacs-dm:viewer-input" });
    }
  }
  if (inViewer) {
    window.addEventListener(
      "wheel",
      (e) => {
        markInput(e);
        // Synapse exige zoom 100%: Ctrl+rueda (o el pellizco del touchpad)
        // cambiaria el zoom de la pagina. preventDefault() solo evita el zoom
        // del navegador; los manejadores de Synapse siguen recibiendo el evento.
        if (settings.forceZoom100 && e.ctrlKey) e.preventDefault();
      },
      { capture: true, passive: false }
    );
    window.addEventListener(
      "keydown",
      (e) => {
        markInput(e);
        if (!settings.forceZoom100 || !(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (["+", "-", "=", "_"].includes(e.key) || ["NumpadAdd", "NumpadSubtract"].includes(e.code)) {
          e.preventDefault();
        }
      },
      true
    );
    window.addEventListener("pointerdown", markInput, { capture: true, passive: true });
    window.addEventListener("mousemove", measureViewport, { capture: true, passive: true });
    watchWebgl();
  }

  // Donde quedo DE VERDAD el area de la pagina del visor en la pantalla. Un
  // movimiento real del mouse trae ambas coordenadas: screenX - clientX es el
  // borde izquierdo del area en la pantalla (y lo mismo arriba). El
  // background lo compara con la pantalla y corrige si el visor se pasa del
  // borde (p.ej. hacia abajo).
  let vpKey = "";
  let vpAt = 0;
  function measureViewport(e) {
    if (!e.isTrusted) return;
    const now = Date.now();
    if (now - vpAt < 1500) return;
    const r = viewportInScreen(e);
    // Descarta eventos con coordenadas incoherentes (p.ej. el que Chrome
    // genera cuando la ventana aparece o se mueve bajo el puntero) sin gastar
    // el turno: el area de la pagina tiene que estar dentro de la ventana.
    const top = window.top;
    if (
      !r ||
      r.left < top.screenX - 2 ||
      r.left > top.screenX + 60 ||
      r.top < top.screenY - 2 ||
      r.top > top.screenY + 300
    ) {
      return;
    }
    vpAt = now;
    const key = [r.left, r.top, r.width, r.height].join(",");
    if (key === vpKey) return;
    vpKey = key;
    send({ type: "pacs-dm:viewport", rect: r, dpr: window.devicePixelRatio, hasInput: inputAt > 0 });
  }

  // Area de la pagina principal en coordenadas de pantalla. Si el evento llega
  // a un iframe (del mismo origen), se suma la posicion de cada iframe.
  function viewportInScreen(e) {
    let x = e.screenX - e.clientX;
    let y = e.screenY - e.clientY;
    let w = window;
    try {
      while (w !== w.top) {
        const fe = w.frameElement;
        if (!fe) return null; // iframe de otro origen
        const parent = w.parent;
        const rect = fe.getBoundingClientRect();
        const cs = parent.getComputedStyle(fe);
        x -= rect.left + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0);
        y -= rect.top + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0);
        w = parent;
      }
      return { left: Math.round(x), top: Math.round(y), width: w.innerWidth, height: w.innerHeight };
    } catch (err) {
      return null;
    }
  }

  // Pantalla negra: el visor perdio el contexto grafico y no lo recupero
  // (en cualquier frame del visor).
  function watchWebgl() {
    const lost = new Map();
    document.addEventListener(
      "webglcontextlost",
      (e) => {
        const c = e.target;
        if (!(c instanceof HTMLCanvasElement)) return;
        clearTimeout(lost.get(c));
        lost.set(
          c,
          setTimeout(() => {
            lost.delete(c);
            if (!c.isConnected) return;
            const r = c.getBoundingClientRect();
            if (r.width * r.height < 0.1 * window.innerWidth * window.innerHeight) return; // miniatura
            send({
              type: "pacs-dm:viewer-health",
              issue: "webgl-lost",
              hasInput: inputAt > 0,
              size: [Math.round(r.width), Math.round(r.height)],
            });
          }, 2500)
        );
      },
      true
    );
    document.addEventListener(
      "webglcontextrestored",
      (e) => {
        clearTimeout(lost.get(e.target));
        lost.delete(e.target);
      },
      true
    );
  }

  // ===================================================================
  // Visor: geometria, salud y actividad
  // ===================================================================
  const viewer = isTop && IS_VIEWER ? setupViewer() : null;

  function setupViewer() {
    const r3 = (n) => Math.round(n * 1000) / 1000;
    const snap = () => ({
      t: Date.now() - pageStart,
      dpr: r3(window.devicePixelRatio),
      iw: window.innerWidth,
      ih: window.innerHeight,
      ow: window.outerWidth,
      oh: window.outerHeight,
      sx: window.screenX,
      sy: window.screenY,
      sw: screen.width,
      sh: screen.height,
    });
    const start = snap();
    // Si el script se inyecto con la pagina ya cargada (tras actualizar la
    // extension), el visor ya inicio: los cambios desde ahora son "despues".
    let dcl = document.readyState !== "loading" ? start : null;
    let load = document.readyState === "complete" ? start : null;
    let last = start;
    const changes = [];
    let blockedCalls = 0;
    let reportTimer = null;
    // Actividad con marcas de tiempo: permite saber si llego un estudio
    // despues de un instante dado, sin carreras con la entrega.
    const activity = { docStartedAt: docStart, titleChangedAt: 0, hrefChangedAt: 0, mutations: 0, recent: [] };
    let lastTitle = document.title;
    let lastHref = location.href;
    function watchIdentity() {
      if (document.title !== lastTitle) {
        lastTitle = document.title;
        activity.titleChangedAt = Date.now();
      }
      if (location.href !== lastHref) {
        lastHref = location.href;
        activity.hrefChangedAt = Date.now();
      }
    }

    const phase = () => (load ? "after-load" : dcl ? "after-dcl" : "before-dcl");

    function check() {
      const cur = snap();
      let changed = false;
      if (Math.abs(cur.dpr - last.dpr) > 0.001) {
        changes.push({ t: cur.t, kind: "dpr", from: last.dpr, to: cur.dpr, phase: phase() });
        changed = true;
      }
      if (cur.iw !== last.iw || cur.ih !== last.ih) {
        changes.push({ t: cur.t, kind: "size", from: [last.iw, last.ih], to: [cur.iw, cur.ih], phase: phase() });
        changed = true;
      }
      if (cur.sx !== last.sx || cur.sy !== last.sy) {
        changes.push({ t: cur.t, kind: "pos", from: [last.sx, last.sy], to: [cur.sx, cur.sy], phase: phase() });
        changed = true;
      }
      if (changes.length > 40) changes.splice(0, changes.length - 40);
      last = cur;
      if (changed) scheduleReport(1500);
    }

    window.addEventListener("resize", check, true);
    (function watchDpr() {
      try {
        matchMedia("(resolution: " + window.devicePixelRatio + "dppx)").addEventListener(
          "change",
          () => {
            check();
            watchDpr();
          },
          { once: true }
        );
      } catch (e) { /* nada */ }
    })();
    // Mover la ventana sin cambiar su tamano no dispara eventos: sondeo liviano.
    let polls = 0;
    (function poll() {
      check();
      watchIdentity();
      polls++;
      setTimeout(poll, polls < 60 ? 1000 : 5000);
    })();

    document.addEventListener(
      "DOMContentLoaded",
      () => {
        dcl = snap();
        checkHttpStatus();
        send({ type: "pacs-dm:viewer-start", start, dcl });
      },
      { once: true }
    );
    window.addEventListener(
      "load",
      () => {
        load = snap();
        scheduleReport(1500);
      },
      { once: true }
    );
    if (dcl) checkHttpStatus();
    // Si "load" nunca llega (recurso colgado), informar igual.
    setTimeout(() => {
      if (!load) scheduleReport(0, true);
    }, 20000);

    // Actividad (sirve para saber si un estudio llego a este visor).
    try {
      new PerformanceObserver((list) => {
        const now = Date.now();
        for (const e of list.getEntries()) activity.recent.push([now, e.transferSize || 0]);
        if (activity.recent.length > 150) activity.recent.splice(0, activity.recent.length - 150);
      }).observe({ type: "resource" });
    } catch (e) { /* nada */ }
    try {
      new MutationObserver((m) => {
        activity.mutations += m.length;
        watchIdentity();
      }).observe(document, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* nada */ }

    function checkHttpStatus() {
      try {
        const nav = performance.getEntriesByType("navigation")[0];
        const status = nav && nav.responseStatus;
        if (status && status >= 400) {
          send({ type: "pacs-dm:viewer-health", issue: "http-error", status, hasInput: inputAt > 0 });
        }
      } catch (e) { /* nada */ }
    }

    // Canvas/imagenes grandes cuyo contenido se muestra estirado (relacion de
    // aspecto distinta a la de su caja): imagen deformada = medicion erronea.
    function mediaInfo() {
      const vp = window.innerWidth * window.innerHeight;
      const out = { canvases: 0, big: 0, zero: 0, distorted: 0 };
      const items = Array.from(document.querySelectorAll("canvas, img"));
      for (const f of document.querySelectorAll("iframe")) {
        try {
          if (f.contentDocument) items.push(...f.contentDocument.querySelectorAll("canvas, img"));
        } catch (e) { /* otro origen */ }
      }
      for (const el of items) {
        const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        if (el.tagName === "CANVAS") out.canvases++;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < 0.05 * vp || r.width < 2 || r.height < 2) continue;
        const cs = view.getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) continue;
        const w = el.tagName === "CANVAS" ? el.width : el.naturalWidth;
        const h = el.tagName === "CANVAS" ? el.height : el.naturalHeight;
        out.big++;
        if (!w || !h) {
          if (el.tagName === "CANVAS") out.zero++;
          continue;
        }
        if (cs.objectFit && cs.objectFit !== "fill") continue;
        if (Math.abs(w / h / (r.width / r.height) - 1) > 0.02) out.distorted++;
      }
      return out;
    }

    function report() {
      return {
        start,
        dcl,
        load,
        now: snap(),
        changes: changes.slice(-12),
        dprChanged: changes.some((c) => c.kind === "dpr"),
        dprChangedAfterDcl: changes.some((c) => c.kind === "dpr" && c.phase !== "before-dcl"),
        sizeChangedAfterDcl: changes.some((c) => c.kind === "size" && c.phase !== "before-dcl"),
        hasInput: inputAt > 0,
        blockedCalls,
        media: mediaInfo(),
        visibility: document.visibilityState,
      };
    }

    function scheduleReport(ms, force) {
      clearTimeout(reportTimer);
      reportTimer = setTimeout(() => {
        if (!load && !force) return; // se informa al cargar
        send({ type: "pacs-dm:viewer-report", report: report() });
      }, ms);
    }

    function relayout() {
      // Pide a Synapse recalcular su layout con el tamano actual.
      const fire = () => {
        try {
          window.dispatchEvent(new Event("resize"));
        } catch (e) { /* nada */ }
      };
      fire();
      setTimeout(fire, 300);
      scheduleReport(1500, true);
    }

    return {
      relayout,
      report,
      onBlockedCall() {
        blockedCalls++;
      },
      activity() {
        watchIdentity();
        return Object.assign({ inputAt, visibility: document.visibilityState }, activity, {
          recent: activity.recent.slice(-60),
        });
      },
    };
  }

  // Eventos del page-guard (mundo MAIN): llamadas bloqueadas, alert(), errores.
  if (isTop && (IS_VIEWER || IS_LAUNCHER)) {
    window.addEventListener("pacs-dm:page", (e) => {
      let data;
      try {
        data = JSON.parse(e.detail);
      } catch (err) {
        return;
      }
      if (data.type === "window-call" && data.blocked && viewer) viewer.onBlockedCall();
      send({ type: "pacs-dm:page-event", event: data });
    });
  }

  // ===================================================================
  // Mensajes del background
  // ===================================================================
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== "string") return;
      switch (msg.type) {
        case "pacs-dm:notice":
          if (notices) notices.show(msg);
          sendResponse({ ok: true });
          return;
        case "pacs-dm:get-activity":
          sendResponse(viewer ? viewer.activity() : { docStartedAt: docStart, inputAt, visibility: document.visibilityState });
          return;
        case "pacs-dm:get-report":
          sendResponse(viewer ? viewer.report() : null);
          return;
        case "pacs-dm:relayout":
          if (viewer) viewer.relayout();
          sendResponse({ ok: true });
          return;
        default:
          return;
      }
    });
  } catch (e) { /* extension recargada */ }
})();
