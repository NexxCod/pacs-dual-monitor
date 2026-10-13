// Pruebas de lib/geometry.js (sin dependencias): node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../lib/geometry.js");

// Monitor de prueba. scale: escala de Windows (1 = 100%).
function disp(id, left, top, width, height, extra = {}) {
  const { scale = 1, taskbar = 0, ...rest } = extra;
  return {
    id: String(id),
    name: `M${id}`,
    isPrimary: false,
    isInternal: false,
    isEnabled: true,
    mirroringSourceId: "",
    dpiX: 96 * scale,
    dpiY: 96 * scale,
    bounds: { left, top, width, height },
    workArea: { left, top, width, height: height - taskbar },
    ...rest,
  };
}

const ids = (pick) => pick.displays.map((d) => d.id);

test("notebook principal (150%) + dos externos a la derecha: elige los externos", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true, scale: 1.5, taskbar: 32 });
  const e1 = disp(2, 1280, 0, 1920, 1080);
  const e2 = disp(3, 3200, 0, 1920, 1080);
  const pick = G.pickViewerDisplays([nb, e1, e2]);
  assert.deepEqual(ids(pick), ["2", "3"]);
  assert.equal(pick.reason, "best-pair");
  assert.deepEqual(pick.warnings, []);
  assert.deepEqual(G.targetBounds(pick.displays, 7), { left: 1273, top: 0, width: 3854, height: 1087 });
  assert.deepEqual(G.targetBounds(pick.displays, 0), { left: 1280, top: 0, width: 3840, height: 1080 });
});

test("sin dato de monitor interno (isInternal=false en todos) sigue eligiendo los externos", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, scale: 1.5 });
  const e1 = disp(2, 1280, 0, 1920, 1080);
  const e2 = disp(3, 3200, 0, 1920, 1080);
  assert.deepEqual(ids(G.pickViewerDisplays([e2, nb, e1])), ["2", "3"]);
});

test("un externo es la pantalla principal y el notebook no: igual elige los dos externos", () => {
  const e1 = disp(1, 0, 0, 1920, 1080, { isPrimary: true });
  const e2 = disp(2, 1920, 0, 1920, 1080);
  const nb = disp(3, -1280, 200, 1280, 720, { isInternal: true, scale: 1.25 });
  assert.deepEqual(ids(G.pickViewerDisplays([e1, e2, nb])), ["1", "2"]);
});

test("externos a la izquierda del notebook (coordenadas negativas)", () => {
  const nb = disp(1, 0, 0, 1536, 864, { isPrimary: true, isInternal: true, scale: 1.25 });
  const e1 = disp(2, -3840, 0, 1920, 1080);
  const e2 = disp(3, -1920, 0, 1920, 1080);
  const pick = G.pickViewerDisplays([nb, e1, e2]);
  assert.deepEqual(ids(pick), ["2", "3"]);
  assert.deepEqual(G.targetBounds(pick.displays, 7), { left: -3847, top: 0, width: 3854, height: 1087 });
});

test("notebook cerrado: solo dos externos iguales -> abarca ambos", () => {
  const e1 = disp(1, 0, 0, 2560, 1440, { isPrimary: true, taskbar: 48 });
  const e2 = disp(2, 2560, 0, 2560, 1440, { taskbar: 48 });
  const pick = G.pickViewerDisplays([e1, e2]);
  assert.equal(pick.reason, "two-externals");
  assert.deepEqual(G.targetBounds(pick.displays, 0), { left: 0, top: 0, width: 5120, height: 1392 });
});

test("notebook + un solo externo: no hace nada salvo que se pida usar uno solo", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true, scale: 1.5 });
  const e1 = disp(2, 1280, 0, 1920, 1080, { taskbar: 40 });
  assert.equal(G.pickViewerDisplays([nb, e1]), null);
  const pick = G.pickViewerDisplays([nb, e1], { singleMonitorFallback: true });
  assert.deepEqual(ids(pick), ["2"]);
  assert.deepEqual(G.targetBounds(pick.displays, 7), { left: 1273, top: 0, width: 1934, height: 1047 });
});

test("un solo monitor: no hace nada", () => {
  assert.equal(G.pickViewerDisplays([disp(1, 0, 0, 1920, 1080, { isPrimary: true })]), null);
  assert.equal(G.pickViewerDisplays([]), null);
});

test("barra de tareas solo en un externo: la ventana no queda bajo la barra", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true });
  const e1 = disp(2, 1280, 0, 1920, 1080, { taskbar: 40 });
  const e2 = disp(3, 3200, 0, 1920, 1080);
  const b = G.targetBounds(G.pickViewerDisplays([nb, e1, e2]).displays, 0);
  assert.deepEqual(b, { left: 1280, top: 0, width: 3840, height: 1040 });
});

test("externos con distinta altura/desfase vertical: usa la franja comun", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true });
  const e1 = disp(2, 1280, 0, 1920, 1200);
  const e2 = disp(3, 3200, 60, 1920, 1080);
  const pick = G.pickViewerDisplays([nb, e1, e2]);
  assert.deepEqual(ids(pick), ["2", "3"]);
  assert.deepEqual(G.targetBounds(pick.displays, 0), { left: 1280, top: 60, width: 3840, height: 1080 });
  assert.ok(pick.warnings.some((w) => /distinta resolucion/.test(w)));
});

test("externos apilados (uno sobre otro)", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true });
  const top = disp(2, 1280, -1080, 1920, 1080);
  const bottom = disp(3, 1280, 0, 1920, 1080, { taskbar: 40 });
  const pick = G.pickViewerDisplays([nb, top, bottom]);
  assert.deepEqual(ids(pick), ["2", "3"]);
  assert.equal(G.adjacency(top, bottom), "vertical");
  assert.deepEqual(G.targetBounds(pick.displays, 0), { left: 1280, top: -1080, width: 1920, height: 2120 });
});

test("seleccion manual en Opciones", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true });
  const e1 = disp(2, 1280, 0, 1920, 1080);
  const e2 = disp(3, 3200, 0, 1920, 1080);
  assert.deepEqual(ids(G.pickViewerDisplays([nb, e1, e2], { displayIds: ["3"] })), ["3"]);
  const fallback = G.pickViewerDisplays([nb, e1, e2], { displayIds: ["99"] });
  assert.deepEqual(ids(fallback), ["2", "3"]);
  assert.ok(fallback.warnings.some((w) => /no estan conectados/.test(w)));
});

test("advierte escala distinta de 100% en los monitores del visor", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true, scale: 1.5 });
  const e1 = disp(2, 1280, 0, 1536, 864, { scale: 1.25 });
  const e2 = disp(3, 2816, 0, 1536, 864, { scale: 1.25 });
  const pick = G.pickViewerDisplays([nb, e1, e2]);
  assert.deepEqual(ids(pick), ["2", "3"]);
  assert.equal(pick.warnings.filter((w) => /escala 125%/.test(w)).length, 2);
  assert.equal(G.displayScale(e1), 1.25);
});

test("ignora monitores en espejo o deshabilitados", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true });
  const e1 = disp(2, 1280, 0, 1920, 1080);
  const e2 = disp(3, 3200, 0, 1920, 1080);
  const mirror = disp(4, 1280, 0, 1920, 1080, { mirroringSourceId: "2" });
  assert.deepEqual(ids(G.pickViewerDisplays([nb, e1, e2, mirror])), ["2", "3"]);
  const off = disp(3, 3200, 0, 1920, 1080, { isEnabled: false });
  assert.equal(G.pickViewerDisplays([nb, e1, off]), null);
});

test("notebook + tres externos: elige un par contiguo de externos iguales", () => {
  const nb = disp(1, 0, 0, 1280, 720, { isPrimary: true, isInternal: true });
  const e1 = disp(2, 1280, 0, 1920, 1080);
  const e2 = disp(3, 3200, 0, 1920, 1080);
  const e3 = disp(4, 5120, 0, 1920, 1080);
  const pick = G.pickViewerDisplays([nb, e1, e2, e3]);
  assert.equal(pick.displays.length, 2);
  assert.ok(!ids(pick).includes("1"));
  assert.equal(G.adjacency(pick.displays[0], pick.displays[1]), "horizontal");
});

test("externos con el notebook al medio: no abarca el notebook; usa un solo externo y avisa", () => {
  const e1 = disp(1, -1920, 0, 1920, 1080);
  const nb = disp(2, 0, 200, 1280, 720, { isPrimary: true, isInternal: true, scale: 1.5 });
  const e2 = disp(3, 1280, 0, 1920, 1080);
  const pick = G.pickViewerDisplays([e1, nb, e2]);
  assert.equal(pick.displays.length, 1);
  assert.notEqual(pick.displays[0].id, "2");
  assert.equal(pick.reason, "single-external");
  assert.ok(pick.warnings.some((w) => /no hay dos monitores externos contiguos/i.test(w)));
  // Sin dato de pantalla interna: igual no abarca el notebook.
  const nb2 = disp(2, 0, 200, 1280, 720, { isPrimary: true });
  const pick2 = G.pickViewerDisplays([e1, nb2, e2]);
  assert.equal(pick2.displays.length, 1);
  assert.notEqual(pick2.displays[0].id, "2");
});

test("sin dato de pantalla interna y principal externa: abarca los dos externos iguales", () => {
  const e1 = disp(1, 0, 0, 1920, 1080, { isPrimary: true });
  const e2 = disp(2, 1920, 0, 1920, 1080);
  const nb = disp(3, 3840, 300, 1366, 768);
  assert.deepEqual(ids(G.pickViewerDisplays([e1, e2, nb])), ["1", "2"]);
});

test("boundsDelta y centerInside", () => {
  const t = { left: 1273, top: 0, width: 3854, height: 1087 };
  assert.equal(G.boundsDelta({ left: 1273, top: 0, width: 3854, height: 1087 }, t), 0);
  assert.equal(G.boundsDelta({ left: 1273, top: 0, width: 1927, height: 1087 }, t), 1927);
  assert.equal(G.boundsDelta(null, t), Infinity);
  assert.ok(G.centerInside({ left: 2000, top: 100, width: 800, height: 600 }, t));
  assert.ok(!G.centerInside({ left: 100, top: 100, width: 800, height: 600 }, t));
});
