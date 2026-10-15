# PACS Dual Monitor

Extensión de Chrome (y Edge) para Synapse (HSJD) que:

1. **Abre el visor ya ubicado en tus dos monitores externos, con las dimensiones y la escala correctas para medir.**
2. **Se asegura de que el estudio realmente abra**, sin quedarse en la pantalla negra de "La aplicación se encuentra abierta en otra ventana".

Se instala una vez y funciona sola. No cambia tu flujo de trabajo.

---

## Novedad de la versión 2.0.4: el visor no se suelta mientras lo usas

El visor debe quedar siempre como lo deja el botón de reubicar. Las versiones anteriores tenían "frenos" para no pelear sin fin con otro programa; usando el visor normalmente (por ejemplo, cambiando imágenes seguido) esos frenos podían activarse y dejar el visor mal hasta apretar el botón, que los reiniciaba. Ahora:

- **Mientras usas el visor, nunca se rinde**: si algo cambia la ventana o la imagen cada vez que cambias de imagen o de estudio, se corrige cada vez. Solo se pausa (30 s) ante un bucle real: otro programa que la mueve una y otra vez **sin** que estés usando el visor.
- Además de reaccionar a cada cambio, **revisa cada 3 segundos** y cada vez que vuelves al visor desde otra ventana.
- Una imagen que se sale de la ventana **nunca** se da por buena (solo una imagen más chica puede ser a propósito, por ejemplo con un panel abierto).
- **Al apretar el botón aparece un aviso que dice qué estaba mal** (la ventana, el zoom, la página o la imagen), con un botón **Copiar diagnóstico** para enviarlo.

---

## Versión 2.0.3: la imagen queda siempre del tamaño de la ventana

Si tenías que apretar el botón de la extensión cada vez que recargabas, cambiabas de imagen o manipulabas el estudio, la causa era esta: Synapse, al abrir un estudio o cambiar imágenes, intenta devolver la ventana a su tamaño "guardado". La extensión bloquea ese intento (si no, el visor quedaría en un solo monitor), pero Synapse igual acomodaba la imagen para el tamaño que pidió, y solo se corregía cuando algo le avisaba el tamaño real de la ventana, que es justo lo que hace el botón. Ahora:

- Cada vez que Synapse intenta cambiar el tamaño de la ventana, la extensión lo bloquea **y le avisa al instante el tamaño real**, igual que el botón: la imagen queda bien sin que hagas nada.
- Además, si la imagen queda fuera de la ventana (o mucho más chica) con el visor quieto, se reacomoda sola. **Nunca mientras arrastras, mides o recorres imágenes**: espera a que sueltes el mouse.
- Si un layout de Synapse es así a propósito (por ejemplo, con un panel abierto), lo detecta y no insiste.
- Diagnóstico: al apretar el botón queda registrado cómo estaba el visor antes y cómo quedó, y el registro muestra cada intento de Synapse de cambiar el tamaño (y cuántos segundos después de usar el visor).

---

## Versión 2.0.2: el visor se mantiene solo en su lugar

Antes, si algo movía o achicaba la ventana del visor pasados los primeros segundos (al interactuar con Synapse, su agente, otra extensión o Windows), había que apretar el ícono de la extensión (o Ctrl+Shift+Y) para volver a ubicarlo. Ahora la extensión lo vigila **todo el tiempo**:

- Si la ventana del visor **se mueve, cambia de tamaño (aunque sea unos pocos píxeles), se maximiza o pasa a pantalla completa**, vuelve sola a su lugar en una fracción de segundo y se le pide a Synapse reacomodar la imagen (lo mismo que hace el botón).
- Si la **página del visor queda desplazada** (toda la imagen corrida, por ejemplo cuando Chrome desplaza la página para mostrar un control), vuelve a su lugar.
- La **pantalla completa pedida por Synapse** se bloquea: dejaría el visor en un solo monitor.
- Si **otro programa insiste** en mover la ventana (la devuelve y la vuelve a mover una y otra vez), la extensión deja de pelear por un minuto y te avisa. El registro de *Opciones* muestra qué la movió.
- Si cambian los monitores (se apaga uno, se conecta el dock), no pelea con Windows: espera a que se estabilicen y recién ahí reubica el visor.
- La medición automática de bordes es más prudente: solo achica la ventana cuando se pasa de la pantalla (nunca la agranda por una medida), una vez por estudio y nunca mientras la ventana se está moviendo.
- Para mover el visor a mano, desactiva **Mantener el visor siempre en su lugar** en *Opciones*.

---

## ¿Qué cambió en la versión 2.0?

### 1. Dimensiones correctas → mediciones confiables

Synapse exige que el **zoom del navegador** y la **escala de Windows** estén al **100%**, y calibra el visor cuando abre el estudio. Si después la ventana cambia de monitor, de escala o de tamaño, las mediciones y el *True Size* pueden quedar mal.

Eso es justo lo que pasaba con la versión anterior: el visor **nacía en el notebook** (que suele tener escala 125–150%), se calibraba ahí, y recién después la extensión lo estiraba a los dos monitores. Además peleaba con Synapse, que al abrir cada estudio "restaura" la posición guardada del visor y Chrome la recorta a un solo monitor, achicando la ventana a mitad de carga.

Ahora:

- **La ventana se ubica en los dos externos *antes* de que cargue el visor** (desde que aparece la lanzadera). El visor nace con su tamaño y escala finales.
- **Se bloquea el "restaurar posición" de Synapse** (sus llamadas `moveTo`/`resizeTo`), que dejaba la ventana en un solo monitor.
- **Siempre en su lugar** (2.0.2): si algo mueve, achica, maximiza o pone en pantalla completa la ventana, vuelve sola a su lugar.
- **Zoom de Synapse fijo en 100%**. En el visor, Ctrl+rueda, Ctrl+ y Ctrl− ya no hacen zoom al navegador (Synapse sigue recibiendo esas teclas).
- **El visor informa su escala**: si cambió *después* de abrir el estudio, se recarga solo (si aún no lo usaste) o te avisa con un botón **Recargar visor**, para no medir sobre un visor mal calibrado.
- **El visor nunca se pasa del borde de la pantalla**: con el primer movimiento del mouse sobre el visor, la extensión mide dónde quedó de verdad el área del visor; si se pasa (por ejemplo hacia abajo), corrige la ventana y recuerda esa medida para los próximos estudios. Si ya estabas usando el visor no lo mueve: te ofrece **Ajustar ahora**.
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

> Nota: como la extensión mantiene el visor en su lugar, no se puede mover, maximizar ni poner en pantalla completa (F11) mientras **Mantener el visor siempre en su lugar** esté activa: vuelve solo. Si necesitas moverlo a mano, desactiva esa opción. **Ctrl+Shift+Y** lo reubica en cualquier momento.

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
| Mantener el visor siempre en su lugar | Sí | Si algo mueve, achica, maximiza o pone en pantalla completa la ventana, desplaza la página o deja la imagen fuera de la ventana, todo vuelve solo a su lugar. Desactívala solo si necesitas mover el visor a mano. |
| Impedir que Synapse mueva, achique o ponga en pantalla completa la ventana | Sí | Evita que el "restaurar posición" o la pantalla completa de Synapse lo dejen en un monitor, y le avisa el tamaño real para que la imagen quede bien. |
| Mantener el zoom en 100% | Sí | Synapse lo exige para medir. Bloquea Ctrl+rueda / Ctrl+ / Ctrl− en el visor. |
| Recargar el visor solo si quedó mal | Sí | Solo si aún no lo usaste; si no, te avisa con botón. |
| Verificar que el estudio abra | Sí | Maneja el aviso "abierta en otra ventana", reintenta y cierra visores zombie. |
| Cerrar visores anteriores o huérfanos | Sí | Evita que un visor viejo mantenga el "candado" de Synapse. |
| Mostrar avisos en pantalla | Sí | Los errores se muestran siempre. |
| Si hay un solo monitor externo, usarlo solo | No | Útil si a veces trabajas con un solo externo. |
| Borde invisible de Windows (lados, valor inicial) | 7 px | Punto de partida para los lados (abajo parte en 0). Después se usan los bordes medidos en tu equipo; en *Monitores* puedes **Volver a medir los bordes**. |
| Sin «mantener siempre»: proteger tras cargar | 12 s | Solo si desactivas «mantener siempre»: segundos tras cargar el visor en que igual se corrige cualquier movimiento. |
| Monitores del visor | Automático | En la tabla de monitores puedes marcar a mano cuáles usar. |

---

## Si algo no funciona

1. Abre **Opciones** y revisa la sección *Monitores* (escala 100% en los externos) y *Visor y lanzamientos*.
2. Si el visor se ve mal, aprieta **una vez** el botón de la extensión (o Ctrl+Shift+Y): aparece un aviso que dice qué estaba mal, con el botón **Copiar diagnóstico** (también está en *Opciones*). Envíamelo: queda registrado cómo estaba el visor antes del botón y cómo quedó. El registro también muestra qué movió el visor (por ejemplo *"Algo movió o cambió el tamaño de la ventana del visor… vuelve a su lugar"*, *"Synapse intentó resizeTo… bloqueado; se le avisa el tamaño real"* o *"La imagen del visor quedó fuera de la ventana… reacomodada"*). No guarda datos del paciente: las direcciones se guardan sin parámetros y no se guardan títulos de ventana.
3. Si aun así la imagen queda mal, prueba desactivar **Impedir que Synapse mueva, achique o ponga en pantalla completa la ventana**: Synapse podrá mover la ventana y la extensión la devolverá al instante a los dos monitores (como la versión 1).
4. Para más detalle: `chrome://extensions` → PACS Dual Monitor → **Inspeccionar service worker** (consola con los mensajes `[PACS]`).

---

## Para desarrolladores: pruebas

- Geometría (sin dependencias): `node --test tests/geometry.test.js`
- Extremo a extremo en Chromium real contra un Synapse simulado (Linux, requiere Xvfb, openssl y Playwright):
  `npm install` y luego `npm run test:e2e`. La prueba de bordes mueve el mouse real con python-xlib
  (`pip install python-xlib`; si no está, se omite). Para usar otro Python: `PACS_PYTHON=/ruta/python`.
  Con `PACS_DUMP_LOG=1` se muestra el registro de la extensión de cada prueba.

---

## Contacto

**Marcelo Salinas Villagra** — Imagenología, HSJD
marcelo.salinas@mail.udp.cl
