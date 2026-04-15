# PACS Dual Monitor

Extensión de Chrome que expande automáticamente el visor de imágenes de Synapse (ImageViewer) para que ocupe tus dos monitores externos completos. Así tienes el máximo espacio disponible para revisar imágenes sin tener que arrastrar y redimensionar la ventana cada vez.

**No cambia nada de tu flujo de trabajo.** Se instala una sola vez y funciona automáticamente cada vez que se abre el ImageViewer.

---

## ¿Qué hace?

Cada vez que se abre una ventana de Synapse con el visor de imágenes (`/ImageViewer/layout`), la extensión automáticamente:

- Detecta tus tres monitores (notebook + dos externos)
- Identifica los dos monitores externos (los que no son la pantalla principal)
- Reposiciona y redimensiona la ventana del ImageViewer para que cubra ambos monitores de borde a borde
- Elimina la barra de Chrome (ventana tipo popup) para maximizar el área de imagen

Todo ocurre en menos de un segundo. Tu ventana principal de Chrome queda intacta en el notebook.

---

## Instalación (2 minutos)

### Paso 1 — Descargar

Descarga el archivo `pacs-dual-monitor.zip` y descomprímelo en una carpeta que no vayas a borrar (por ejemplo, en Documentos).

### Paso 2 — Abrir extensiones de Chrome

Escribe esto en la barra de direcciones de Chrome y presiona Enter:

```
chrome://extensions
```

### Paso 3 — Activar modo desarrollador

En la esquina **superior derecha** de la página, activa el switch que dice **"Modo de desarrollador"**.

### Paso 4 — Cargar la extensión

Haz click en **"Cargar descomprimida"** (botón que aparece arriba a la izquierda).

Navega hasta la carpeta que descomprimiste y selecciónala (la que contiene `manifest.json` y `background.js`).

### Paso 5 — Verificar

La extensión aparece en la lista como **"PACS Dual Monitor"**. Ahora abre un estudio en Synapse — al cargar el ImageViewer, la ventana debería expandirse automáticamente a los dos monitores externos.

---

## Requisitos

- **3 monitores conectados:** un notebook (pantalla principal) y dos monitores externos.
- Los dos monitores externos deben ser los que **no** están configurados como pantalla principal en Windows.
- No importa en qué orden estén los monitores externos — la extensión los detecta automáticamente.

---

## Preguntas frecuentes

**¿Tengo que hacer algo cada vez que abro el ImageViewer?**
No. La extensión detecta la URL automáticamente y mueve la ventana sola.

**¿Cambia algo en Synapse?**
No. El visor funciona exactamente igual. La extensión solo mueve y redimensiona la ventana.

**¿Funciona si los monitores cambian de orden?**
Sí. La extensión identifica los dos monitores que no son la pantalla principal, sin importar su posición.

**¿Funciona en Edge?**
Sí, el mismo proceso de instalación funciona en Microsoft Edge.

**¿Funciona si actualizo Chrome?**
Sí. Puede que Chrome muestre un aviso de "extensiones en modo desarrollador" al abrir el navegador — solo ciérralo y sigue.

**¿Puedo desinstalarla?**
Sí, en `chrome://extensions` haz click en "Quitar".

---

## Solución de problemas

Si la ventana no se mueve, abre `chrome://extensions` → **PACS Dual Monitor** → **"Inspeccionar service worker"** y revisa los mensajes en la consola. Los logs muestran qué monitores detectó y qué bounds calculó.

---

## Contacto

Cualquier duda o problema con la extensión, escríbeme.

**Marcelo Salinas Villagra** — Imagenología, HSJD
marcelo.salinas@mail.udp.cl
