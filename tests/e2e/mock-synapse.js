// Synapse simulado para las pruebas E2E (HTTPS en 127.0.0.1).
//
// - /Synapse/Web            worklist; window.openStudy(id, modo, extra)
// - /WebQuery/Index?winpass lanzadera: si hay un visor vivo (candado en
//                           localStorage) muestra "La aplicacion se encuentra
//                           abierta en otra ventana" y le pasa el estudio por
//                           BroadcastChannel; si no, navega al visor.
// - /ImageViewer/layout     visor: canvas dimensionado UNA vez al iniciar
//                           (como un visor que calibra al abrir el estudio),
//                           latido del candado, recibe estudios, "restaura"
//                           su posicion con resizeTo/moveTo tras cargar.
//   flags: zombie (no recibe estudios), webgl (canvas WebGL), goodResize.
// - /img                    datos de imagen (20 KB).

const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function makeCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pacs-cert-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
    "-keyout", key, "-out", cert, "-subj", "/CN=sjdpacs.synapsetimed.cl",
  ], { stdio: "ignore" });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const WORKLIST = `<!doctype html><html><head><meta charset="utf-8"><title>Worklist</title></head>
<body style="font:14px sans-serif">
<h1>Worklist simulada</h1>
<button onclick="openStudy('X1','popup')">Abrir estudio X1</button>
<script>
window.openStudy = function (id, mode, extra) {
  var url = '/WebQuery/Index?winpass=true&study=' + encodeURIComponent(id) + (extra ? '&' + extra : '');
  if (mode === 'tab') return !!window.open(url, '_blank');
  return !!window.open(url, 'SynapseLauncher_' + id + '_' + Date.now(), 'width=900,height=700,left=120,top=120');
};
</script></body></html>`;

const LAUNCHER = `<!doctype html><html><head><meta charset="utf-8"><title>Synapse</title>
<style>html,body{margin:0;height:100%;background:#000;color:#ddd;font:16px sans-serif}</style></head>
<body><script>
(function () {
  var params = new URLSearchParams(location.search);
  var study = params.get('study');
  var lock = null;
  try { lock = JSON.parse(localStorage.getItem('synapseViewerLock') || 'null'); } catch (e) {}
  var alive = !!lock && Date.now() - lock.ts < 2500;
  window.__launcher = { alive: alive, study: study };
  if (alive) {
    document.body.innerHTML = '<div id="msg" style="padding:40px">La aplicación se encuentra abierta en otra ventana. El estudio se cargará en esa ventana.</div>';
    try { new BroadcastChannel('synapse').postMessage({ type: 'open-study', study: study }); } catch (e) {}
    return;
  }
  var pass = new URLSearchParams();
  params.forEach(function (v, k) { if (k !== 'winpass' && k !== 'delay') pass.set(k, v); });
  setTimeout(function () { location.href = '/ImageViewer/layout?' + pass.toString(); }, Number(params.get('delay') || 600));
})();
</script></body></html>`;

const VIEWER = `<!doctype html><html><head><meta charset="utf-8"><title>Visor</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#vp{position:absolute;inset:0;width:100%;height:100%;display:block}#gl{position:absolute;left:0;top:0;width:60%;height:60%}</style>
</head><body><canvas id="vp"></canvas><script>
(function () {
  var params = new URLSearchParams(location.search);
  var S = window.__viewer = {
    t0: Date.now(), study: params.get('study'), studies: [params.get('study')],
    startDpr: devicePixelRatio, startW: innerWidth, startH: innerHeight, startX: screenX, startY: screenY, startOW: outerWidth, startOH: outerHeight,
    resizes: [], restoreAttempted: false
  };
  document.title = 'Visor - ' + S.study;
  // selfWarn=once|always: el propio visor muestra el aviso de instancia unica.
  var sw = params.get('selfWarn');
  if (sw === 'always' || (sw === 'once' && !sessionStorage.getItem('selfWarned'))) {
    sessionStorage.setItem('selfWarned', '1');
    S.selfWarned = true;
    document.addEventListener('DOMContentLoaded', function () {
      var d = document.createElement('div');
      d.style.cssText = 'position:absolute;inset:0;background:#000;color:#ddd;padding:40px;font:16px sans-serif';
      d.textContent = 'La aplicación se encuentra abierta en otra ventana.';
      document.body.appendChild(d);
    });
  }
  var beat = function () { localStorage.setItem('synapseViewerLock', JSON.stringify({ ts: Date.now(), study: S.study })); };
  beat(); setInterval(beat, 700);
  addEventListener('pagehide', function () { localStorage.removeItem('synapseViewerLock'); });
  if (!params.has('zombie')) {
    new BroadcastChannel('synapse').onmessage = function (e) {
      if (e.data && e.data.type === 'open-study') {
        S.study = e.data.study; S.studies.push(e.data.study); document.title = 'Visor - ' + S.study;
        for (var i = 0; i < 10; i++) fetch('/img?study=' + encodeURIComponent(S.study) + '&i=' + i).then(function (r) { return r.arrayBuffer(); });
      }
    };
  }
  var c = document.getElementById('vp');
  function draw() {
    var g = c.getContext('2d'); g.fillStyle = '#123'; g.fillRect(0, 0, c.width, c.height);
    g.strokeStyle = '#fff'; g.beginPath(); g.arc(c.width / 2, c.height / 2, Math.min(c.width, c.height) / 4, 0, 7); g.stroke();
  }
  document.addEventListener('DOMContentLoaded', function () {
    S.dclDpr = devicePixelRatio; S.dclW = innerWidth; S.dclH = innerHeight;
    c.width = Math.round(innerWidth * devicePixelRatio); c.height = Math.round(innerHeight * devicePixelRatio); draw();
  });
  addEventListener('resize', function (e) {
    S.resizes.push({ t: Date.now() - S.t0, w: innerWidth, h: innerHeight, ow: outerWidth, oh: outerHeight, sx: screenX, sy: screenY, dpr: devicePixelRatio, trusted: e.isTrusted });
    if (params.has('goodResize')) { c.width = Math.round(innerWidth * devicePixelRatio); c.height = Math.round(innerHeight * devicePixelRatio); draw(); }
  });
  if (params.has('iframe')) {
    // Visor que dibuja dentro de un iframe del mismo origen.
    var f = document.createElement('iframe');
    f.src = '/ImageViewer/frame' + (params.has('webgl') ? '?webgl=1' : '');
    f.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
    document.body.appendChild(f);
  } else if (params.has('webgl')) {
    var gl = document.createElement('canvas'); gl.id = 'gl'; document.body.appendChild(gl);
    var ctx = gl.getContext('webgl');
    gl.width = 800; gl.height = 480;
    S.webgl = !!ctx;
    var ext = ctx && ctx.getExtension('WEBGL_lose_context');
    S.loseContext = function () { if (ext) ext.loseContext(); return !!ext; };
  }
  addEventListener('load', function () {
    S.loaded = Date.now() - S.t0;
    // Synapse "restaura" el tamano/posicion guardados del visor.
    setTimeout(function () { S.restoreAttempted = true; try { window.resizeTo(800, 600); window.moveTo(0, 0); } catch (e) {} }, 300);
  });
})();
</script></body></html>`;

const FRAME = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000}canvas{position:absolute;left:0;top:0;width:70%;height:70%}</style></head>
<body><canvas id="c"></canvas><script>
(function () {
  var c = document.getElementById('c'); c.width = 900; c.height = 600;
  window.__frame = { clicks: 0 };
  addEventListener('pointerdown', function () { window.__frame.clicks++; });
  if (location.search.indexOf('webgl') >= 0) {
    var ctx = c.getContext('webgl'); var ext = ctx && ctx.getExtension('WEBGL_lose_context');
    window.__frame.loseContext = function () { if (ext) ext.loseContext(); return !!ext; };
  } else {
    var g = c.getContext('2d'); g.fillStyle = '#234'; g.fillRect(0, 0, 900, 600);
  }
})();
</script></body></html>`;

function start(port) {
  const { key, cert } = makeCert();
  const blob = Buffer.alloc(20000, 7);
  const server = https.createServer({ key, cert }, (req, res) => {
    const u = new URL(req.url, "https://sjdpacs.synapsetimed.cl");
    const send = (code, type, body) => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (u.pathname === "/Synapse/Web") return send(200, "text/html; charset=utf-8", WORKLIST);
    if (u.pathname === "/WebQuery/Index") return send(200, "text/html; charset=utf-8", LAUNCHER);
    if (u.pathname === "/ImageViewer/layout") {
      if (u.searchParams.get("status")) return send(Number(u.searchParams.get("status")), "text/html", "<h1>Error</h1>");
      return send(200, "text/html; charset=utf-8", VIEWER);
    }
    if (u.pathname === "/ImageViewer/frame") return send(200, "text/html; charset=utf-8", FRAME);
    if (u.pathname === "/img") return send(200, "application/octet-stream", blob);
    send(404, "text/plain", "no");
  });
  return new Promise((resolve) => server.listen(port || 0, "127.0.0.1", () => resolve(server)));
}

module.exports = { start };

if (require.main === module) {
  start(Number(process.argv[2] || 8443)).then((s) => console.log("mock Synapse en https://127.0.0.1:" + s.address().port));
}
