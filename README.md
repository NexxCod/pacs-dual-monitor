# PACS Dual Monitor

Extensión de Chrome para Synapse (HSJD) que hace dos cosas:

1. **Expande el visor a tus dos monitores externos** automáticamente cada vez que se abre el ImageViewer.
2. **Evita el aviso "La aplicación se encuentra abierta en otra ventana"** descartándolo solo y cerrando las ventanas de viewer zombie que lo provocan.

**No cambia tu flujo de trabajo.** Se instala una vez y funciona automáticamente.

---

## ¿Qué hace? (v1.2.0)

### Dual monitor
Cada vez que se abre `/ImageViewer/layout`, detecta tus tres monitores, identifica los dos externos y reposiciona la ventana (tipo popup, sin barra de Chrome) para cubrirlos de borde a borde.

### Anti "abierta en otra ventana"
Cuando haces click en un estudio, Synapse a veces se queda pegado en la lanzadera (`/WebQuery/Index?winpass=true...`) mostrando el aviso de instancia única. La extensión ahora:

- Detecta ese aviso en cualquier página de Synapse y le hace **click automático al botón de confirmar** (el estudio carga igual, como dice el propio mensaje).
- Tras aceptar, **reenfoca** la ventana del viewer.
- **Cierra las ventanas de viewer huérfanas** (zombie) que mantienen vivo el "lock" y son la causa de que el aviso aparezca tan seguido. Nunca cierra la ventana de la worklist.

---

## Instalación

1. Descomprime la carpeta en un lugar fijo (ej. Documentos).
2. Ve a `chrome://extensions`.
3. Activa **Modo de desarrollador** (arriba a la derecha).
4. **Cargar descomprimida** → selecciona la carpeta (la que tiene `manifest.json`).
5. Si ya tenías una versión anterior instalada, haz click en el botón de **recargar** (↻) sobre la tarjeta de la extensión.

---

## Requisitos

- 3 monitores: notebook (principal) + dos externos.
- Los dos externos deben NO ser la pantalla principal en Windows.

---

## Configuración

En `background.js`, arriba del todo:

- `CLOSE_ORPHAN_VIEWERS` (default `true`): si alguna vez te cierra una ventana que no querías, ponlo en `false`.
- `WORKLIST_HINTS`: URLs protegidas que nunca se cierran (worklist/lanzadera).

---

## Si el aviso NO se descarta solo

El content script intenta adivinar el botón de confirmar. Si en tu versión de Synapse el botón es distinto y no lo encuentra, deja en consola el HTML del diálogo:

1. `chrome://extensions` → PACS Dual Monitor → **Inspeccionar service worker** (para los logs de ventanas).
2. Para el aviso: abre DevTools (F12) en la ventana de Synapse donde sale el cartel y busca en la consola la línea `[PACS] Aviso detectado pero NO encontré botón...`.
3. Copia ese HTML y pásamelo para afinar el selector exacto.

---

## Contacto

**Marcelo Salinas Villagra** — Imagenología, HSJD
marcelo.salinas@mail.udp.cl
