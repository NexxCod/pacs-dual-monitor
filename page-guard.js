// page-guard.js
// Corre en el "MAIN world" (el mismo contexto JS que Synapse), antes que
// cualquier script de la pagina, y solo en la lanzadera y el visor.
// Tambien bloquea la pantalla completa pedida por el visor (la dejaria en un
// solo monitor).
//
// Synapse "restaura" el tamano y posicion guardados del visor al abrir cada
// estudio usando window.moveTo/resizeTo. Chrome recorta esas llamadas a UN
// solo monitor, asi que achica la ventana que la extension acaba de abrir en
// los dos externos, y el visor recalcula su layout a mitad de carga (las
// mediciones pueden quedar mal). Aqui esas llamadas se bloquean; la extension
// es la que decide el tamano. Se puede desactivar en Opciones.
//
// OJO: tras pedir el cambio, Synapse acomoda la imagen para el tamano que
// PIDIO y espera el evento "resize" que llegaria si la ventana cambiara. Como
// la llamada se bloquea, ese evento no llega y la imagen queda del tamano
// equivocado (hasta apretar el boton de la extension, que dispara "resize").
// Por eso, tras cada llamada bloqueada se le avisa el tamano REAL con eventos
// "resize", igual que el boton.
//
// Tambien reporta (solo para diagnostico) los alert() de Synapse -avisa con
// alert si el zoom no es 100%- y los errores de JavaScript de la pagina.

(() => {
  "use strict";
  const where = location.pathname + location.search + location.hash;
  const isViewer = /\/ImageViewer\/layout/i.test(where);
  const isLauncher = /\/WebQuery\/Index/i.test(where) && /winpass=true/i.test(where);
  if (!isViewer && !isLauncher) return;
  // Ya instalado (p.ej. reinyeccion tras actualizar la extension).
  if (window.__pacsDmGuard) return;
  window.__pacsDmGuard = true;

  let allowResize = false; // lo actualiza content.js segun Opciones

  // Diagnostico (solo numeros y nombres de funciones, nada del paciente).
  const stats = { calls: {}, lastCall: null, resyncs: 0, resyncPaused: 0, fullscreen: 0, reads: {} };

  // Eventos para el content script, con tope por tipo y por minuto.
  const sentAt = {};
  const emit = (type, data) => {
    const now = Date.now();
    const list = (sentAt[type] = (sentAt[type] || []).filter((t) => now - t < 60000));
    if (list.length >= 20) return;
    list.push(now);
    try {
      window.dispatchEvent(
        new CustomEvent("pacs-dm:page", { detail: JSON.stringify(Object.assign({ type }, data)) })
      );
    } catch (e) { /* nada */ }
  };

  window.addEventListener("pacs-dm:stats-request", () => {
    try {
      window.dispatchEvent(new CustomEvent("pacs-dm:stats", { detail: JSON.stringify(stats) }));
    } catch (e) { /* nada */ }
  });

  // Tras una llamada bloqueada: avisar a Synapse el tamano real ("resize"),
  // varias veces porque Synapse puede terminar de acomodar la imagen un poco
  // despues. Si Synapse vuelve a pedir el cambio en cada "resize" (bucle), se
  // deja de insistir por un minuto.
  let resyncTimers = [];
  let resyncTimes = [];
  let resyncPausedUntil = 0;
  function resync() {
    const now = Date.now();
    if (now < resyncPausedUntil) return;
    resyncTimes = resyncTimes.filter((t) => now - t < 10000);
    if (resyncTimes.length >= 12) {
      resyncPausedUntil = now + 60000;
      stats.resyncPaused++;
      emit("resync-paused", {});
      return;
    }
    resyncTimes.push(now);
    resyncTimers.forEach(clearTimeout);
    resyncTimers = [150, 600, 1500].map((ms) =>
      setTimeout(() => {
        stats.resyncs++;
        try {
          window.dispatchEvent(new Event("resize"));
        } catch (e) { /* nada */ }
      }, ms)
    );
  }

  window.addEventListener("pacs-dm:config", (e) => {
    try {
      const cfg = JSON.parse(e.detail);
      allowResize = !!cfg.allowResize;
    } catch (err) { /* nada */ }
  });

  const short = (v) => {
    try { return String(v).slice(0, 300); } catch (e) { return "?"; }
  };

  for (const name of ["moveTo", "moveBy", "resizeTo", "resizeBy"]) {
    const original = window[name];
    if (typeof original !== "function") continue;
    const wrapped = function () {
      const args = Array.prototype.slice.call(arguments, 0, 2).map(Number);
      stats.calls[name] = (stats.calls[name] || 0) + 1;
      stats.lastCall = { name, args, at: Date.now() };
      emit("window-call", { name, args, blocked: !allowResize });
      if (allowResize) return original.apply(this, arguments);
      resync();
      return undefined;
    };
    try {
      Object.defineProperty(window, name, { value: wrapped, writable: true, configurable: true });
    } catch (e) { /* nada */ }
  }

  // Pantalla completa pedida por la pagina: dejaria el visor en UN solo
  // monitor. Se bloquea en el visor (salvo que se desactive en Opciones).
  if (isViewer) {
    const blockFs = (proto, name) => {
      const original = proto && proto[name];
      if (typeof original !== "function") return;
      const wrapped = function () {
        stats.fullscreen++;
        emit("fullscreen", { name, blocked: !allowResize });
        if (allowResize) return original.apply(this, arguments);
        // Igual que cuando Chrome la niega: evento de error y, en la API
        // estandar, una promesa rechazada (ya manejada: sin errores sueltos).
        const el = this;
        setTimeout(() => {
          try {
            const type = name === "requestFullscreen" ? "fullscreenerror" : "webkitfullscreenerror";
            el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
          } catch (e) { /* nada */ }
        }, 0);
        if (name !== "requestFullscreen") return undefined;
        const p = Promise.reject(new TypeError("Pantalla completa bloqueada por PACS Dual Monitor"));
        p.catch(() => {});
        return p;
      };
      try {
        Object.defineProperty(proto, name, { value: wrapped, writable: true, configurable: true });
      } catch (e) { /* nada */ }
    };
    for (const name of ["requestFullscreen", "webkitRequestFullscreen", "webkitRequestFullScreen"]) {
      blockFs(Element.prototype, name);
    }
  }

  // Diagnostico: que medidas de pantalla/ventana usa Synapse para acomodar la
  // imagen (solo se cuentan las lecturas; los valores no cambian).
  const countReads = (obj, names, prefix) => {
    for (const name of names) {
      try {
        const d = Object.getOwnPropertyDescriptor(obj, name);
        if (!d || typeof d.get !== "function" || !d.configurable) continue;
        const key = prefix + name;
        stats.reads[key] = 0;
        Object.defineProperty(obj, name, {
          configurable: true,
          enumerable: d.enumerable,
          get: function () {
            stats.reads[key]++;
            return d.get.call(this);
          },
          set: d.set,
        });
      } catch (e) { /* nada */ }
    }
  };
  if (isViewer) {
    try {
      countReads(Screen.prototype, ["width", "height", "availWidth", "availHeight", "availLeft", "availTop"], "screen.");
    } catch (e) { /* nada */ }
    countReads(window, ["outerWidth", "outerHeight", "screenX", "screenY", "screenLeft", "screenTop"], "");
  }

  for (const name of ["alert", "confirm"]) {
    const original = window[name];
    if (typeof original !== "function") continue;
    const wrapped = function (message) {
      emit("dialog", { name, message: short(message) });
      return original.apply(this, arguments);
    };
    try {
      Object.defineProperty(window, name, { value: wrapped, writable: true, configurable: true });
    } catch (e) { /* nada */ }
  }

  window.addEventListener(
    "error",
    (e) => {
      if (e.target && e.target !== window) {
        const t = e.target;
        emit("resource-error", { tag: short(t.tagName), src: short(t.src || t.href || "").replace(/\?.*$/, "") });
      } else {
        emit("page-error", { message: short(e.message), source: short(e.filename).replace(/\?.*$/, ""), line: e.lineno });
      }
    },
    true
  );
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    emit("page-error", { message: short(r && r.message ? r.message : r) });
  });
})();
