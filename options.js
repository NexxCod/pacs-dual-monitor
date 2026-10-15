// options.js — pagina de Opciones y diagnostico.
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const form = $("#settings");
  let settings = null;
  let defaults = null;
  let last = null;
  let formFilled = false;
  let lastDisplaysSig = "";

  const REASONS = {
    manual: "elegidos a mano",
    "best-pair": "par de externos detectado automáticamente",
    "two-externals": "los dos únicos monitores (notebook cerrado)",
    "single-external": "un solo monitor externo",
  };
  const PHASES = {
    pending: "esperando que abra el visor",
    "awaiting-delivery": "esperando que el visor existente reciba el estudio",
    retrying: "reintentando",
    warning: "aviso de Synapse (sin recuperación automática)",
    failed: "no se pudo abrir",
  };

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const rect = (r) => (r ? `${r.left}, ${r.top} · ${r.width}×${r.height}` : "—");
  const scaleOf = (d) => (d && d.dpiX ? d.dpiX / 96 : null);
  const pct = (x) => Math.round(x * 100) + "%";
  const time = (t) => new Date(t).toLocaleTimeString("es-CL", { hour12: false });

  function flash(sel, text) {
    const el = $(sel);
    el.textContent = text;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.textContent = ""), 3500);
  }

  async function getStatus() {
    try {
      return await chrome.runtime.sendMessage({ type: "pacs-dm:status" });
    } catch (e) {
      return null;
    }
  }

  // ------------------------------------------------------------- render
  function renderAlerts(st) {
    const box = $("#alerts");
    const list = Object.values(st.alerts || {});
    box.replaceChildren(...list.map((a) => h("p", { class: a.level }, "⚠ " + a.text)));
    box.hidden = list.length === 0;
  }

  function renderDisplays(st) {
    const chosen = new Set((st.pick && st.pick.ids) || []);
    const manual = new Set((st.settings.displayIds || []).map(String));
    const sig = JSON.stringify([st.displays, [...chosen], [...manual]]);
    if (sig === lastDisplaysSig) return;
    lastDisplaysSig = sig;
    const rows = st.displays.map((d) => {
      const s = scaleOf(d);
      const type = [d.isPrimary ? "principal" : null, d.isInternal ? "notebook (interno)" : "externo"]
        .filter(Boolean)
        .join(", ");
      return h(
        "tr",
        { class: chosen.has(d.id) ? "chosen" : "" },
        h("td", {}, h("input", { type: "checkbox", checked: manual.has(String(d.id)), "data-id": d.id, title: "Usar este monitor para el visor" })),
        h("td", {}, d.name || `#${d.id}`),
        h("td", {}, rect(d.bounds)),
        h("td", {}, rect(d.workArea)),
        // Solo importa (y se marca en rojo) la escala de los monitores del visor.
        h("td", { class: s && Math.abs(s - 1) > 0.01 ? (chosen.has(d.id) ? "error" : "muted") : "" }, s ? pct(s) : "?"),
        h("td", {}, type)
      );
    });
    $("#displays tbody").replaceChildren(...rows);
    $("#target").textContent = st.pick
      ? `Destino del visor: ${rect(st.pick.bounds)} — ${REASONS[st.pick.reason] || st.pick.reason}`
      : "No hay monitores adecuados para el visor: no se reubica.";
    $("#pick-warnings").replaceChildren(...((st.pick && st.pick.warnings) || []).map((w) => h("li", {}, w)));
  }

  function renderInsets(st) {
    const i = st.insets || {};
    const l = st.learnedInsets;
    $("#insets").textContent =
      `Bordes de la ventana compensados: izquierda ${i.left} · derecha ${i.right} · abajo ${i.bottom} px — ` +
      (l ? `medidos en este equipo (${new Date(l.at).toLocaleString("es-CL")})` : "valores iniciales, se miden al mover el mouse sobre el visor");
  }

  function renderManaged(st) {
    const cards = st.managed.map((m) => {
      const delta =
        m.target && m.current
          ? Math.max(
              Math.abs(m.current.left - m.target.bounds.left),
              Math.abs(m.current.top - m.target.bounds.top),
              Math.abs(m.current.width - m.target.bounds.width),
              Math.abs(m.current.height - m.target.bounds.height)
            )
          : null;
      const rep = m.report || {};
      const dprOk = rep.dpr == null || Math.abs(rep.dpr - 1) < 0.01;
      const zoomOk = m.zoom == null || Math.abs(m.zoom - 1) < 0.01;
      return h(
        "div",
        { class: "card" },
        h("div", { class: "row" }, h("b", {}, m.role === "launcher" ? "Lanzadera" : "Visor"), h("span", { class: "muted" }, `pestaña ${m.tabId} · ventana ${m.windowId}`)),
        h("div", {}, "Ventana: ", rect(m.current)),
        h("div", {}, "Destino: ", m.target ? rect(m.target.bounds) : "—"),
        delta == null ? null : h("div", { class: delta <= 3 ? "ok" : "warn" }, delta <= 3 ? "✓ En su lugar" : `Desfase de ${delta}px`),
        h("div", { class: dprOk ? "" : "error" }, "Escala del visor (devicePixelRatio): ", rep.dpr == null ? "sin informe aún" : pct(rep.dpr)),
        viewportLine(m.viewport, m),
        h("div", { class: zoomOk ? "" : "error" }, "Zoom: ", m.zoom == null ? "—" : pct(m.zoom)),
        rep.blockedCalls ? h("div", { class: "muted" }, `Intentos de Synapse de mover la ventana bloqueados: ${rep.blockedCalls}`) : null,
        m.restores ? h("div", { class: "muted" }, `Ventana devuelta a su lugar automáticamente: ${m.restores} ${m.restores === 1 ? "vez" : "veces"}`) : null,
        m.scrollFixes ? h("div", { class: "muted" }, `Página del visor devuelta a su lugar (desplazada): ${m.scrollFixes} ${m.scrollFixes === 1 ? "vez" : "veces"}`) : null,
        m.areaFixes ? h("div", { class: "muted" }, `Imagen reacomodada automáticamente (había quedado fuera de la ventana): ${m.areaFixes} ${m.areaFixes === 1 ? "vez" : "veces"}`) : null,
        rep.page && rep.page.resyncs
          ? h("div", { class: "muted" }, `Avisos a Synapse del tamaño real de la ventana: ${rep.page.resyncs}`)
          : null,
        m.keeperPausedUntil > Date.now()
          ? h("div", { class: "warn" }, "Otro programa sigue moviendo la ventana: corrección automática en pausa por un minuto.")
          : null,
        m.autoReloads ? h("div", { class: "warn" }, `Recargas automáticas en este estudio: ${m.autoReloads}`) : null
      );
    });
    $("#managed").replaceChildren(...(cards.length ? cards : [h("p", { class: "muted" }, "No hay ningún visor abierto.")]));
  }

  // Area de la pagina del visor medida en la pantalla (con el mouse).
  function viewportLine(v, m) {
    if (!v || !v.over) return h("div", { class: "muted" }, "Área del visor en pantalla: se mide al mover el mouse sobre el visor");
    const o = v.over;
    const out = [];
    if (o.bottom > 0) out.push(`${o.bottom} px abajo`);
    if (o.left > 0) out.push(`${o.left} px a la izquierda`);
    if (o.right > 0) out.push(`${o.right} px a la derecha`);
    if (!out.length) return h("div", { class: "ok" }, "✓ Área del visor dentro de la pantalla");
    // La medicion es anterior al ajuste de bordes: ya quedo corregido.
    if ((m.insetsFixedAt || 0) >= (v.at || 0)) {
      return h("div", { class: "ok" }, "✓ Área del visor corregida (se pasaba " + out.join(", ") + ")");
    }
    return h("div", { class: "warn" }, "Área del visor: se pasaba de la pantalla (" + out.join(", ") + ")");
  }

  function renderLaunches(st) {
    const cards = st.launches.map((L) =>
      h(
        "div",
        { class: "card" },
        h("div", { class: "row" }, h("b", {}, "Apertura de estudio"), h("span", { class: "muted" }, `pestaña ${L.tabId}`)),
        h("div", { class: L.phase === "failed" ? "error" : "" }, "Estado: ", PHASES[L.phase] || L.phase),
        h("div", {}, `Intento ${L.attempt || 1} · hace ${Math.round((Date.now() - L.startedAt) / 1000)} s`)
      )
    );
    $("#launches").replaceChildren(...cards);
  }

  function renderLog(st) {
    const items = st.log
      .slice(-250)
      .reverse()
      .map((e) =>
        h(
          "li",
          {},
          h("span", { class: "t" }, time(e.t)),
          h("span", { class: "lv " + (e.level === "error" ? "error" : e.level === "warn" ? "warn" : "muted") }, e.level),
          " ",
          e.msg,
          e.data === undefined ? null : h("code", {}, JSON.stringify(e.data).slice(0, 600))
        )
      );
    $("#log").replaceChildren(...items);
  }

  function fillForm() {
    for (const input of form.querySelectorAll("input[name]")) {
      const v = settings[input.name];
      if (input.type === "checkbox") input.checked = !!v;
      else input.value = v;
    }
    formFilled = true;
  }

  async function refresh() {
    const st = await getStatus();
    if (!st) return;
    last = st;
    settings = st.settings;
    defaults = st.defaults;
    $("#version").textContent = "v" + st.version;
    renderAlerts(st);
    renderDisplays(st);
    renderInsets(st);
    renderManaged(st);
    renderLaunches(st);
    renderLog(st);
    if (!formFilled) fillForm();
  }

  // ------------------------------------------------------------- acciones
  async function save(patch) {
    const { settings: stored = {} } = await chrome.storage.local.get("settings");
    const next = Object.assign({}, stored, patch);
    await chrome.storage.local.set({ settings: next });
    settings = Object.assign({}, settings, patch);
    flash("#save-msg", "Guardado.");
    lastDisplaysSig = "";
    setTimeout(refresh, 150);
  }

  form.addEventListener("change", (e) => {
    const t = e.target;
    if (!t.name) return;
    if (t.type === "checkbox") return save({ [t.name]: t.checked });
    const n = Number(t.value);
    if (Number.isFinite(n)) save({ [t.name]: n });
  });

  $("#displays").addEventListener("change", (e) => {
    const boxes = [...document.querySelectorAll("#displays input[type=checkbox]")];
    const ids = boxes.filter((b) => b.checked).map((b) => b.getAttribute("data-id"));
    if (ids.length > 2) {
      e.target.checked = false;
      flash("#save-msg", "Máximo dos monitores para el visor.");
      return;
    }
    save({ displayIds: ids });
  });

  $("#btn-defaults").addEventListener("click", async () => {
    await chrome.storage.local.set({ settings: Object.assign({}, defaults) });
    settings = Object.assign({}, defaults);
    fillForm();
    lastDisplaysSig = "";
    flash("#save-msg", "Valores por defecto restaurados.");
    refresh();
  });

  $("#btn-reposition").addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ type: "pacs-dm:reposition" }).catch(() => null);
    flash(
      "#action-msg",
      !r ? "Sin respuesta." : r.ok ? "Visor reubicado." : r.reason === "no-viewer" ? "No hay ningún visor abierto." : "No se pudo reubicar (ver registro)."
    );
    refresh();
  });

  $("#btn-remeasure").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "pacs-dm:remeasure" }).catch(() => null);
    flash("#save-msg", "Los bordes se volverán a medir con el próximo visor.");
    lastDisplaysSig = "";
    refresh();
  });

  $("#btn-copy").addEventListener("click", async () => {
    const st = last || (await getStatus());
    const diag = {
      generado: new Date().toISOString(),
      version: st.version,
      navegador: navigator.userAgent,
      opciones: st.settings,
      monitores: st.displays,
      eleccion: st.pick,
      bordes: { usados: st.insets, medidos: st.learnedInsets },
      visores: st.managed,
      lanzamientos: st.launches,
      alertas: st.alerts,
      registro: st.log.slice(-200),
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
      flash("#action-msg", "Diagnóstico copiado. Pégalo en un correo o mensaje.");
    } catch (e) {
      flash("#action-msg", "No pude copiar al portapapeles.");
    }
  });

  $("#btn-clear").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "pacs-dm:clear-log" }).catch(() => null);
    flash("#action-msg", "Registro y avisos limpiados.");
    refresh();
  });

  refresh();
  setInterval(refresh, 2000);
})();
