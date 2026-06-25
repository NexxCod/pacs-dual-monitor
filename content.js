// content.js
// Synapse usa un puente local (synapse.local:8080). La pagina lanzadora
// /WebQuery/Index?winpass=true a veces se queda PEGADA mostrando el aviso
// "abierta en otra ventana" (ventana negra, sin boton para clickear).
//
// Estrategia: detectar esa lanzadera pegada y (1) recargarla una vez para
// reintentar el handoff (automatiza el "insistir con clicks"), y si sigue
// pegada (2) pedir al background que cierre esa ventana basura.

// === Config (se puede desactivar) ===
const AUTO_RETRY_LAUNCHER = true;   // recargar la lanzadera pegada 1 vez
const CLOSE_STUCK_LAUNCHER = true;  // cerrar la lanzadera si sigue pegada
const LAUNCHER_STUCK_MS = 4000;     // cuanto esperar antes de considerarla pegada

const WARNING_SUBSTRING = "abierta en otra ventana";

function isLauncherPage() {
  return (
    location.href.includes("/WebQuery/Index") &&
    location.href.includes("winpass=true")
  );
}

function pageShowsWarning() {
  const txt = (document.body && document.body.innerText || "").toLowerCase();
  return txt.includes(WARNING_SUBSTRING);
}

if (isLauncherPage()) {
  setTimeout(() => {
    // Si ya navego a otra cosa (handoff exitoso), no hacemos nada.
    if (!isLauncherPage()) return;

    // Solo actuamos si efectivamente esta el aviso (no si solo va lenta).
    if (!pageShowsWarning()) {
      console.log("[PACS] Lanzadera aun en winpass=true pero sin aviso; espero (puede ir lenta).");
      return;
    }

    const retried = sessionStorage.getItem("pacs_launcher_retried");

    if (!retried && AUTO_RETRY_LAUNCHER) {
      sessionStorage.setItem("pacs_launcher_retried", "1");
      console.log("[PACS] Lanzadera PEGADA con aviso. Reintentando handoff (reload)...");
      location.reload();
      return;
    }

    if (CLOSE_STUCK_LAUNCHER) {
      console.log("[PACS] Lanzadera sigue pegada tras reintento. Pidiendo cierre de la ventana basura.");
      try {
        chrome.runtime.sendMessage({ type: "launcher-stuck" });
      } catch (e) { /* service worker dormido */ }
    }
  }, LAUNCHER_STUCK_MS);
}
