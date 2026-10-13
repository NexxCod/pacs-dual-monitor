# PACS Dual Monitor

Extensión de Chrome (y Edge) para Synapse (HSJD) que:

1. **Abre el visor ya ubicado en tus dos monitores externos, con las dimensiones y la escala correctas para medir.**
2. **Se asegura de que el estudio realmente abra**, sin quedarse en la pantalla negra de "La aplicación se encuentra abierta en otra ventana".

Se instala una vez y funciona sola. No cambia tu flujo de trabajo.

---

## ¿Qué cambió en la versión 2.0?

### 1. Dimensiones correctas → mediciones confiables

Synapse exige que el **zoom del navegador** y la **escala de Windows** estén al **100%**, y calibra el visor cuando abre el estudio. Si después la ventana cambia de monitor, de escala o de tamaño, las mediciones y el *True Size* pueden quedar mal.

Eso es justo lo que pasaba con la versión anterior: el visor **nacía en el notebook** (que suele tener escala 125–150%), se calibraba ahí, y recién después la extensión lo estiraba a los dos monitores. Además peleaba con Synapse, que al abrir cada estudio "restaura" la posición guardada del visor y Chrome la recorta a un solo monitor, achicando la ventana a mitad de carga.

Ahora:

- **La ventana se ubica en los dos externos *antes* de que cargue el visor** (desde que aparece la lanzadera). El visor nace con su tamaño y escala finales y no se vuelve a tocar.
- **Se bloquea el "restaurar posición" de Synapse** (sus llamadas `moveTo`/`resizeTo`), que dejaba la ventana en un solo monitor.
- **Guardia**: si otro programa mueve la ventana mientras el visor carga, se restaura al instante. Pasados unos segundos, si tú la mueves, se respeta.
- **Zoom de Synapse fijo en 100%**. En el visor, Ctrl+rueda, Ctrl+ y Ctrl− ya no hacen zoom al navegador (Synapse sigue recibiendo esas teclas).
- **El visor informa su escala**: si cambió *después* de abrir el estudio, se recarga solo (si aún no lo usaste) o te avisa con un botón **Recargar visor**, para no medir sobre un visor mal calibrado.
- **Detecta imagen deformada** (contenido estirado) y le pide a Synapse recalcular; si persiste, te avisa.
- **Avisa si la escala de Windows no es 100%** en los monitores del visor (aviso rojo y "!" en el ícono).
- **Mejor elección de monitores**: los dos externos iguales y contiguos, aunque el principal de Windows sea un externo o tengas el notebook cerrado. La ventana ya no queda debajo de la barra de tareas. Si en Windows el notebook quedó *entre* los dos externos, usa uno solo y te avisa para que reordenes las pantallas (antes la ventana pasaba por encima del notebook).
- Si un monitor se apaga y vuelve (Windows mueve las ventanas al principal), el visor regresa a los externos.

### 2. Que el estudio abra (sin pantalla negra)

Cada click en un estudio se sigue hasta confirmar que un visor lo cargó:

- Si Synapse muestra **"La aplicación se encuentra abierta en otra ventana"** y hay un visor abierto: se **trae al frente** ese visor, se verifica que reciba el estudio y se cierra la lanzadera negra.
- Si ese visor responde pero **no recibe el estudio** en 8 segundos (visor "zombie"): se cierra y se reintenta.
- Un visor que **estás usando**, o que no contesta (no se puede verificar), **nunca se cierra solo**: te pregunta con un botón **Cerrar visor y reintentar**.
- Si **no hay ningún visor** (el "candado" de Synapse quedó pegado): se reintenta hasta 2 veces con espera creciente.
- Si todo falla, te avisa en pantalla (y en la worklist) para que vuelvas a hacer click, y el ícono muestra "!".
- **Visor en negro** por pérdida del contexto gráfico, error de red o error del servidor (HTTP 5xx): se recarga solo, si aún no lo estabas usando; si ya lo usaste, te avisa con un botón.
- Corrige un error de la versión anterior que **cerraba el visor recién abierto** cuando Synapse lo abría como pestaña. Al cerrar visores anteriores se conserva siempre el más reciente, y no se cierra uno que estés usando en ese momento.
- El ahorro de memoria de Chrome ya no "descarta" la pestaña del visor.

---

## Instalación

1. Descomprime la carpeta en un lugar fijo (ej. Documentos).
2. Ve a `chrome://extensions` (en Edge: `edge://extensions`).
3. Activa **Modo de desarrollador** (arriba a la derecha).
4. **Cargar descomprimida** → selecciona la carpeta (la que tiene `manifest.json`).
5. Si ya tenías una versión anterior: reemplaza los archivos y haz click en **recargar** (↻) en la tarjeta de la extensión. La extensión se prepara sola en las ventanas de Synapse que ya estén abiertas; si algo se ve raro, ciérralas y vuelve a abrirlas.

Requiere Chrome o Edge 111 o superior.

---

## Requisitos para medir bien

- **Escala de Windows al 100%** en los dos monitores externos: *Configuración → Sistema → Pantalla → Escala*. El notebook puede tener otra escala (el visor no va ahí).
- Los dos monitores externos del **mismo modelo y resolución** (Synapse lo exige para abarcar ambos y para *True Size*).
- Zoom del navegador al 100% (la extensión lo mantiene).
- Si usas *True Size*, haz la calibración de Synapse (*User Settings → Image Display → True Size Calibration*) con el visor ya ubicado en los monitores externos.

La página de **Opciones** muestra la escala de cada monitor y te avisa si algo no cumple.

> Nota: como la extensión impide que Synapse mueva la ventana del visor, la tecla F11 de Synapse ("volver al tamaño guardado") deja de mover la ventana. Usa **Ctrl+Shift+Y**.

---

## Uso

- **Automático**: al hacer click en un estudio, el visor aparece en los dos monitores externos.
- **Ctrl+Shift+Y** o **click en el ícono** de la extensión: reubica el visor en los dos monitores.
- **Opciones** (clic derecho en el ícono → *Opciones*): estado de monitores y visor, registro de eventos y configuración.

### Opciones

| Opción | Por defecto | Para qué |
|---|---|---|
| Ubicar el visor en los monitores externos | Sí | Función principal. |
| Ubicar desde que aparece la lanzadera | Sí | El visor nace con su tamaño y escala finales (recomendado). |
| Impedir que Synapse mueva o achique la ventana | Sí | Evita que el "restaurar posición" de Synapse la deje en un monitor. |
| Mantener el zoom en 100% | Sí | Synapse lo exige para medir. Bloquea Ctrl+rueda / Ctrl+ / Ctrl− en el visor. |
| Recargar el visor solo si quedó mal | Sí | Solo si aún no lo usaste; si no, te avisa con botón. |
| Verificar que el estudio abra | Sí | Maneja el aviso "abierta en otra ventana", reintenta y cierra visores zombie. |
| Cerrar visores anteriores o huérfanos | Sí | Evita que un visor viejo mantenga el "candado" de Synapse. |
| Mostrar avisos en pantalla | Sí | Los errores se muestran siempre. |
| Si hay un solo monitor externo, usarlo solo | No | Útil si a veces trabajas con un solo externo. |
| Borde invisible de Windows | 7 px | Ajusta si ves una franja o la ventana se pasa del borde. |
| Guardia tras cargar el visor | 12 s | Tiempo en que se corrige cualquier movimiento de la ventana. |
| Monitores del visor | Automático | En la tabla de monitores puedes marcar a mano cuáles usar. |

---

## Si algo no funciona

1. Abre **Opciones** y revisa la sección *Monitores* (escala 100% en los externos) y *Visor y lanzamientos*.
2. Usa **Copiar diagnóstico** y envíamelo. El registro no guarda datos del paciente: las direcciones se guardan sin parámetros y no se guardan títulos de ventana.
3. Para más detalle: `chrome://extensions` → PACS Dual Monitor → **Inspeccionar service worker** (consola con los mensajes `[PACS]`).

---

## Para desarrolladores: pruebas

- Geometría (sin dependencias): `node --test tests/geometry.test.js`
- Extremo a extremo en Chromium real contra un Synapse simulado (Linux, requiere Xvfb, openssl y Playwright):
  `npm install` y luego `npm run test:e2e`

---

## Contacto

**Marcelo Salinas Villagra** — Imagenología, HSJD
marcelo.salinas@mail.udp.cl
