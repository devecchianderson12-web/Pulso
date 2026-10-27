<p align="center"><img src="assets/icon.png" width="96" alt="Pulso"></p>

<h1 align="center">Pulso</h1>
<p align="center"><b>Tu WhatsApp, en tu estilo.</b><br>Más simple · Más rápido · Más tuyo</p>
<p align="center">
  <a href="https://github.com/devecchianderson12-web/Pulso/releases/latest"><b>Descargar para Windows</b></a>
</p>

---

Pulso es un cliente de escritorio **no oficial** de WhatsApp para Windows. Ejecuta el cliente
oficial de **WhatsApp Web** dentro de Electron, así que tiene todas sus funciones y se mantiene al
día. Encima le añade integración con Windows y un diseño propio. No está afiliado a WhatsApp ni a Meta.

## Funciones

- **Diseño Pulso:** tema oscuro verde, barra de título propia con el logo y contador de no leídos,
  chats redondeados y transiciones suaves.
- **Gráficos optimizados para tu PC:** en el primer arranque Pulso mide los fps reales y, si no
  va fluido, prueba otros modos gráficos (GPU integrada, OpenGL, GPU dedicada, sin GPU) y se
  queda con el mejor. Se puede repetir en **☰ → Ajustes → Optimizar gráficos**.
- **Todo WhatsApp Web:** chats, grupos, comunidades, canales, estados, archivos, notas de voz,
  stickers, encuestas, búsqueda y archivados.
- Notificaciones nativas de Windows. Al hacer clic se abre el chat.
- Contador de no leídos en la bandeja y en la barra de tareas, con parpadeo al llegar mensajes.
- Cerrar a la bandeja, iniciar con Windows, iniciar minimizado y una sola instancia.
- La sesión se queda guardada: el QR se escanea solo una vez.
- Corrector ortográfico en varios idiomas, con sugerencias en el menú contextual. Se puede
  apagar en **☰ → Ajustes → Corrector ortográfico → Activado**.
- **Actualizaciones automáticas:** al publicarse una versión aparece un aviso al pie de la lista
  de chats con **Actualizar** y **Más tarde**. También está en **☰ → Ajustes → Buscar
  actualizaciones…** y en la bandeja.
- **Modo ligero automático:** si el equipo no tiene GPU utilizable (dibujo por CPU), Pulso
  desactiva los efectos más costosos.
- Sin avisos para descargar otras apps de WhatsApp.
- Los enlaces se abren en tu navegador. Las descargas usan el diálogo "Guardar como" y muestran
  el progreso en la barra de tareas.
- Atajos: Ctrl + = / - / 0 (zoom), F11 (pantalla completa), Ctrl+R (recargar), Ctrl+W (ocultar)
  y Ctrl+Q (salir).

**Limitación:** WhatsApp Web no tiene llamadas de voz ni videollamadas, así que Pulso tampoco.

**Tema:** el diseño Pulso se aplica con el tema oscuro de WhatsApp. Pulso lo activa por defecto,
salvo que en WhatsApp hayas elegido el tema claro a mano (Ajustes → Chats → Tema → Predeterminado
del sistema).

## Desarrollo

```bash
npm install
npm start
```

El icono se dibuja con formas vectoriales en `src/icons.js`. Tras cambiarlo, regenera
`assets/icon.ico` (todos los tamaños de Windows) y `assets/icon.png` con:

```bash
node scripts/make-icons.js
```

## Publicar una versión nueva

```powershell
.\scripts\release.ps1 -Version 1.3.0 -Notes "Qué cambió"
```

El script sube la versión, compila en una carpeta de ruta corta (NSIS falla con rutas de más de
260 caracteres) y sube el código a `main` con la etiqueta `v1.3.0`. Después crea el release en
GitHub con el instalador, `latest.yml`, el `.blockmap` y la versión portable. Las copias
instaladas lo detectan solas (al arrancar y cada 4 horas) y se actualizan al pulsar **Actualizar**.

Licencia: GPL-3.0-or-later.
