// lib/geometry.js
// Calculos puros (sin APIs de Chrome) para elegir los monitores del visor y
// calcular el rectangulo de la ventana. Lo usan background.js, options.js y
// las pruebas (tests/geometry.test.js).
//
// Todas las coordenadas son las de Chrome (DIP), igual que
// chrome.system.display.getInfo() y chrome.windows.update().

(function (root) {
  "use strict";

  // Tolerancia (px) para considerar que dos monitores "se tocan".
  const EDGE_TOLERANCE = 2;

  function edges(r) {
    return {
      left: r.left,
      top: r.top,
      right: r.left + r.width,
      bottom: r.top + r.height,
      width: r.width,
      height: r.height,
    };
  }

  function area(d) {
    return d.bounds.width * d.bounds.height;
  }

  // Escala de Windows del monitor (1 = 100%, 1.25 = 125%...). Chrome informa
  // dpiX = 96 * escala. Devuelve null si no hay dato.
  function displayScale(d) {
    const dpi = Number(d && d.dpiX);
    if (!dpi || !isFinite(dpi)) return null;
    return Math.round((dpi / 96) * 100) / 100;
  }

  function sameResolution(a, b) {
    return a.bounds.width === b.bounds.width && a.bounds.height === b.bounds.height;
  }

  function sameScale(a, b) {
    const sa = displayScale(a);
    const sb = displayScale(b);
    return sa == null || sb == null || Math.abs(sa - sb) < 0.01;
  }

  // "horizontal" si estan lado a lado, "vertical" si uno esta sobre el otro,
  // null si no comparten un borde.
  function adjacency(a, b) {
    const A = edges(a.bounds);
    const B = edges(b.bounds);
    const vOverlap = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    const hOverlap = Math.min(A.right, B.right) - Math.max(A.left, B.left);
    const touchX =
      Math.abs(A.right - B.left) <= EDGE_TOLERANCE || Math.abs(B.right - A.left) <= EDGE_TOLERANCE;
    const touchY =
      Math.abs(A.bottom - B.top) <= EDGE_TOLERANCE || Math.abs(B.bottom - A.top) <= EDGE_TOLERANCE;
    if (touchX && vOverlap >= 0.5 * Math.min(A.height, B.height)) return "horizontal";
    if (touchY && hOverlap >= 0.5 * Math.min(A.width, B.width)) return "vertical";
    return null;
  }

  function usableDisplays(displays) {
    return (displays || []).filter(
      (d) => d && d.bounds && d.workArea && d.isEnabled !== false && !d.mirroringSourceId
    );
  }

  function sortByPosition(list) {
    return [...list].sort((a, b) => a.bounds.left - b.bounds.left || a.bounds.top - b.bounds.top);
  }

  // Puntaje de un par de monitores para el visor. Gana el par de externos
  // iguales y contiguos que no son la pantalla principal.
  function pairScore(a, b, haveInternalInfo) {
    let score = 0;
    if (haveInternalInfo && !a.isInternal && !b.isInternal) score += 100;
    if (sameResolution(a, b)) score += 60;
    if (sameScale(a, b)) score += 30;
    if (adjacency(a, b)) score += 25;
    if (!a.isPrimary && !b.isPrimary) score += 20;
    return score + (area(a) + area(b)) / 1e8; // desempate: mas superficie
  }

  function unionRect(list) {
    const L = Math.min(...list.map((d) => d.bounds.left));
    const T = Math.min(...list.map((d) => d.bounds.top));
    const R = Math.max(...list.map((d) => d.bounds.left + d.bounds.width));
    const B = Math.max(...list.map((d) => d.bounds.top + d.bounds.height));
    return { left: L, top: T, width: R - L, height: B - T };
  }

  function intersects(a, b) {
    return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
  }

  // Un par sirve si no incluye el notebook y si la ventana que los abarca no
  // pasaria por encima de otra pantalla (p.ej. el notebook entre los dos).
  function acceptablePair(a, b, all, haveInternalInfo) {
    if (haveInternalInfo && (a.isInternal || b.isInternal)) return false;
    // Sin dato de pantalla interna, la principal solo se acepta junto a una igual.
    if (!haveInternalInfo && (a.isPrimary || b.isPrimary) && !sameResolution(a, b)) return false;
    const u = unionRect([a, b]);
    return !all.some((d) => d !== a && d !== b && intersects(u, d.bounds));
  }

  function bestPair(all) {
    const haveInternalInfo = all.some((d) => d.isInternal === true);
    let best = null;
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (!acceptablePair(all[i], all[j], all, haveInternalInfo)) continue;
        const s = pairScore(all[i], all[j], haveInternalInfo);
        if (!best || s > best.score) best = { score: s, list: [all[i], all[j]] };
      }
    }
    return best ? best.list : null;
  }

  // El mejor monitor externo para usar solo (no el notebook; mejor si no es
  // la pantalla principal; el mas grande).
  function bestSingle(all) {
    const ext = all.filter((d) => !d.isInternal);
    const nonPrimary = ext.filter((d) => !d.isPrimary);
    const pool = nonPrimary.length ? nonPrimary : ext;
    return [...pool].sort((a, b) => area(b) - area(a))[0] || null;
  }

  function label(d) {
    return d.name ? `"${d.name}"` : `#${d.id}`;
  }

  // Elige los monitores donde va el visor.
  // opts.displayIds: ids elegidos a mano en Opciones ([] = automatico).
  // opts.singleMonitorFallback: si solo hay un externo, usarlo solo.
  // Devuelve { displays, reason, warnings } o null si no hay donde ponerlo.
  function pickViewerDisplays(displays, opts) {
    opts = opts || {};
    const all = usableDisplays(displays);
    const warnings = [];
    if (all.length === 0) return null;

    const manual = (opts.displayIds || []).map(String);
    if (manual.length) {
      const chosen = all.filter((d) => manual.includes(String(d.id)));
      if (chosen.length) return finish(sortByPosition(chosen).slice(0, 2), "manual");
      warnings.push("Los monitores elegidos en Opciones no estan conectados; uso seleccion automatica.");
    }

    let chosen = null;
    let reason = "";
    if (all.length >= 3) {
      // Caso tipico: notebook (principal) + 2 externos.
      chosen = bestPair(all);
      reason = "best-pair";
      if (!chosen) {
        const one = bestSingle(all);
        if (one) {
          chosen = [one];
          reason = "single-external";
          warnings.push(
            `No hay dos monitores externos contiguos (¿el notebook está entre ellos en la configuración de pantalla de Windows?). El visor usa solo ${label(one)}; reordena las pantallas para que use ambos.`
          );
        }
      }
    } else if (all.length === 2) {
      const [a, b] = all;
      if (!a.isInternal && !b.isInternal && sameResolution(a, b) && sameScale(a, b) && adjacency(a, b)) {
        // Notebook cerrado: solo quedan los dos externos.
        chosen = all;
        reason = "two-externals";
      } else if (opts.singleMonitorFallback) {
        const ext = all.filter((d) => !d.isInternal && !d.isPrimary);
        const one = ext.length ? ext : all.filter((d) => !d.isPrimary);
        if (one.length) {
          chosen = [one[0]];
          reason = "single-external";
        }
      }
    }
    if (!chosen) return null;
    return finish(sortByPosition(chosen), reason);

    function finish(list, why) {
      if (list.length === 2) {
        const [a, b] = list;
        if (!adjacency(a, b)) {
          warnings.push(`Los monitores ${label(a)} y ${label(b)} no estan contiguos en la configuracion de pantalla de Windows.`);
        }
        if (!sameResolution(a, b)) {
          warnings.push(`Los monitores ${label(a)} y ${label(b)} tienen distinta resolucion; Synapse exige el mismo modelo para abarcar ambos y para True Size.`);
        }
        if (!sameScale(a, b)) {
          warnings.push(`Los monitores ${label(a)} y ${label(b)} tienen distinta escala en Windows.`);
        }
      }
      for (const d of list) {
        const s = displayScale(d);
        if (s != null && Math.abs(s - 1) > 0.01) {
          warnings.push(`El monitor ${label(d)} tiene escala ${Math.round(s * 100)}% en Windows; Synapse exige 100% para que las mediciones y el True Size sean correctos.`);
        }
      }
      return { displays: list, reason: why, warnings };
    }
  }

  // Area de pantalla que debe cubrir el visor (sin bordes de la ventana).
  // En el eje en que se abarcan los monitores se usa la union de las areas de
  // trabajo; en el otro eje, la interseccion, para que ninguna parte del visor
  // quede bajo la barra de tareas o fuera de pantalla.
  function visibleArea(list) {
    let L, T, R, Bo;
    if (list.length === 1) {
      const w = edges(list[0].workArea);
      L = w.left; T = w.top; R = w.right; Bo = w.bottom;
    } else {
      const a = edges(list[0].workArea);
      const b = edges(list[1].workArea);
      const orient =
        adjacency(list[0], list[1]) ||
        (Math.abs(a.left - b.left) >= Math.abs(a.top - b.top) ? "horizontal" : "vertical");
      if (orient === "horizontal") {
        L = Math.min(a.left, b.left);
        R = Math.max(a.right, b.right);
        T = Math.max(a.top, b.top);
        Bo = Math.min(a.bottom, b.bottom);
        if (Bo - T < 200) { T = Math.min(a.top, b.top); Bo = Math.max(a.bottom, b.bottom); }
      } else {
        T = Math.min(a.top, b.top);
        Bo = Math.max(a.bottom, b.bottom);
        L = Math.max(a.left, b.left);
        R = Math.min(a.right, b.right);
        if (R - L < 200) { L = Math.min(a.left, b.left); R = Math.max(a.right, b.right); }
      }
    }
    return { left: L, top: T, right: R, bottom: Bo };
  }

  // Bordes de la ventana que se dejan fuera del area visible, por lado (px):
  // en Windows la ventana tiene un borde invisible a los lados y, segun el
  // equipo, abajo. Acepta un numero (igual en los tres lados) o un objeto.
  function normalizeInsets(insets) {
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    if (insets && typeof insets === "object") return { left: n(insets.left), right: n(insets.right), bottom: n(insets.bottom) };
    const b = n(insets);
    return { left: b, right: b, bottom: b };
  }

  // Rectangulo de la ventana: el area visible mas los bordes que deben quedar
  // fuera de ella a izquierda, derecha y abajo (arriba va la barra de titulo).
  function targetBounds(list, insets) {
    const a = visibleArea(list);
    const i = normalizeInsets(insets);
    return { left: a.left - i.left, top: a.top, width: a.right - a.left + i.left + i.right, height: a.bottom - a.top + i.bottom };
  }

  // Bordes que se usaron para una ventana, deducidos de su rectangulo y del
  // area que debia cubrir.
  function insetsOf(bounds, area) {
    return normalizeInsets({
      left: area.left - bounds.left,
      right: bounds.left + bounds.width - area.right,
      bottom: bounds.top + bounds.height - area.bottom,
    });
  }

  // vp: donde quedo DE VERDAD el area de la pagina del visor en la pantalla
  // (medido en el navegador). Devuelve cuanto se pasa del area visible por
  // lado (over > 0: se pasa; < 0: hueco) y los bordes corregidos para que no
  // se pase nada y no quede un hueco de mas de 1 px.
  function correctInsets(area, vp, insets) {
    const cur = normalizeInsets(insets);
    const over = {
      left: area.left - vp.left,
      right: vp.left + vp.width - area.right,
      bottom: vp.top + vp.height - area.bottom,
    };
    const delta = (o) => (o > 0 ? -o : o < -1 ? -1 - o : 0);
    const next = {
      left: Math.max(0, cur.left + delta(over.left)),
      right: Math.max(0, cur.right + delta(over.right)),
      bottom: Math.max(0, cur.bottom + delta(over.bottom)),
    };
    const changed = next.left !== cur.left || next.right !== cur.right || next.bottom !== cur.bottom;
    return { over, insets: next, changed };
  }

  // Diferencia maxima (px) entre la ventana y el rectangulo deseado.
  function boundsDelta(win, target) {
    if (!win || !target) return Infinity;
    return Math.max(
      Math.abs(win.left - target.left),
      Math.abs(win.top - target.top),
      Math.abs(win.width - target.width),
      Math.abs(win.height - target.height)
    );
  }

  // true si el centro de la ventana cae dentro del rectangulo deseado.
  function centerInside(win, target) {
    const cx = win.left + win.width / 2;
    const cy = win.top + win.height / 2;
    return cx >= target.left && cx <= target.left + target.width && cy >= target.top && cy <= target.top + target.height;
  }

  const api = {
    displayScale,
    adjacency,
    sameResolution,
    sameScale,
    pickViewerDisplays,
    visibleArea,
    normalizeInsets,
    targetBounds,
    insetsOf,
    correctInsets,
    boundsDelta,
    centerInside,
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PacsGeometry = api;
})(typeof self !== "undefined" ? self : this);
