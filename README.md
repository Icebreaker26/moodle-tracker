# moodle-tracker

Panel local para no perder el rastro de las tareas del aula virtual (Moodle): qué está vencido, qué vence hoy o esta semana, y qué ya entregaste.

Usa la **API oficial de web services de Moodle** (la misma que usa la app móvil), no scraping de páginas. Todo corre en tu computador: no hay servidores intermedios ni cuentas nuevas.

## Qué muestra

- Tareas agrupadas por urgencia: **vencidas sin entregar**, **vencen hoy**, **esta semana**, **más adelante**, sin fecha, sin entrega en línea y entregadas.
- Estado real de tu entrega en Moodle: sin entregar, borrador sin enviar, entregada, calificada (con la nota).
- Cuestionarios y otras actividades con fecha, tomadas del calendario de Moodle.
- Filtro por curso y buscador. Puedes marcar una tarea como hecha a mano (por ejemplo, si la entregaste por otro medio).
- Fechas en hora de Colombia.

## Requisitos

- Node.js 20 o superior. No hay que instalar dependencias.
- Que tu Moodle tenga habilitado el servicio móvil (si usas la app de Moodle con tu cuenta, lo tiene).

## Uso

```bash
npm run login     # una sola vez: pide dirección, usuario y contraseña en tu terminal
npm run sync      # descarga tus cursos y tareas
npm start         # abre el panel en http://127.0.0.1:4173
npm run status    # resumen rápido en la terminal, sin abrir el panel
```

También puedes sincronizar desde el botón del panel.

## Privacidad y seguridad

- **La contraseña no se guarda.** Solo se usa en `npm run login` para pedirle un token a Moodle. Se guarda ese token en `data/session.json`.
- `data/` está en `.gitignore`: el token y tus datos no se suben a git. No compartas ese archivo, porque el token da acceso de lectura a tu cuenta.
- Para invalidar el token, en Moodle ve a *Preferencias → Claves de seguridad* y restablécelo, o cambia tu contraseña.
- El servidor solo escucha en `127.0.0.1` y las acciones que modifican algo exigen una cabecera propia, para que otra página abierta en tu navegador no pueda disparar peticiones contra él.
- El programa **solo lee** datos de Moodle. No entrega, borra ni modifica nada.

## Cómo funciona

| Archivo | Función |
|---|---|
| `src/moodle.js` | Cliente de la API: pide el token y llama a las funciones de web services |
| `src/sync.js` | Descarga cursos, tareas, estado de entrega y eventos del calendario |
| `src/status.js` | Clasifica cada tarea por urgencia (hora de Bogotá) |
| `src/store.js` | Guarda sesión, datos y marcas manuales en `data/` |
| `src/server.js` | Servidor local del panel y su API |
| `public/index.html` | El panel |

Funciones de Moodle que usa: `core_webservice_get_site_info`, `core_enrol_get_users_courses`, `mod_assign_get_assignments`, `mod_assign_get_submission_status` y `core_calendar_get_action_events_by_timesort`.

## Pruebas

```bash
npm test
```

Las pruebas usan un Moodle simulado. No se conectan a tu Moodle real.

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| `Usuario o contraseña incorrectos` | Revisa tus datos; la contraseña es la de la plataforma |
| `Moodle no ofrece el servicio móvil` | La universidad no lo habilitó; habría que usar el calendario exportable (iCal) |
| `El token ya no sirve` | Ejecuta `npm run login` otra vez |
| Avisos en el panel sobre una función | Tu Moodle no permite esa función; el resto sigue funcionando |
