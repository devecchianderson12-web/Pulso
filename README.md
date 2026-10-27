# Whatsdesk para Windows

Cliente de escritorio **no oficial** de WhatsApp para Windows, inspirado en
[mohanrex/whatsdesk](https://github.com/mohanrex/whatsdesk). No está afiliado a WhatsApp ni a Meta.

El Whatsdesk original usaba Yowsup2, que reimplementaba el protocolo de WhatsApp. Esa vía
dejó de funcionar y provoca bloqueos de cuenta. Esta versión ejecuta el cliente oficial de
**WhatsApp Web** dentro de Electron, así que tiene todas sus funciones y se actualiza sola.

## Funciones

- Todo WhatsApp Web: chats, grupos, comunidades, canales, estados, archivos, notas de voz,
  stickers, encuestas, búsqueda y archivados.
- Notificaciones nativas de Windows. Al hacer clic se abre el chat.
- Contador de no leídos en la bandeja y en la barra de tareas, con parpadeo al llegar mensajes.
- Cerrar a la bandeja, iniciar con Windows, iniciar minimizado y una sola instancia.
- La sesión se queda guardada: el QR se escanea solo una vez.
- Corrector ortográfico en varios idiomas, con sugerencias en el menú contextual.
- Los enlaces se abren en tu navegador. Las descargas usan el diálogo "Guardar como" y
  muestran el progreso en la barra de tareas.
- Zoom (Ctrl + = / - / 0), pantalla completa (F11), Ctrl+R para recargar, Ctrl+W para ocultar
  y Ctrl+Q para salir.
- Opciones para borrar la caché o cerrar sesión y borrar los datos.

**Limitación:** WhatsApp Web no tiene llamadas de voz ni videollamadas, así que esta app
tampoco. Para llamar desde Windows necesitas la app oficial de la Microsoft Store.

## Desarrollo

```bash
npm install
npm start
```

## Generar el instalador

```bash
npm run dist
```

Genera en `dist/` el instalador (`Whatsdesk Setup x.y.z.exe`) y la versión portable.
NSIS falla con rutas de más de 260 caracteres: compila desde una carpeta con ruta corta.

Licencia: GPL-3.0-or-later, igual que el proyecto original.
