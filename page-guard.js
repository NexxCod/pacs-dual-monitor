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
  let sent = 0;

  const emit = (type, data) => {
    if (sent++ > 60) return;
    try {
      window.dispatchEvent(
        new CustomEvent("pacs-dm:page", { detail: JSON.stringify(Object.assign({ type }, data)) })
      );
    } catch (e) { /* nada */ }
  };

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
      emit("window-call", { name, args, blocked: !allowResize });
      if (allowResize) return original.apply(this, arguments);
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
