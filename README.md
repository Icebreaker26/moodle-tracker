# moodle-tracker

Panel local para no perder el rastro de las tareas del aula virtual (Moodle): qué está vencido, qué vence hoy o esta semana, y qué ya entregaste.

Usa la **API oficial de web services de Moodle** (la misma que usa la app móvil), no scraping de páginas. Todo corre en tu computador: no hay servidores intermedios ni cuentas nuevas.

## Qué muestra

- Tareas agrupadas por urgencia: **vencidas sin entregar**, **vencen hoy**, **esta semana**, **más adelante**, sin fecha, sin entrega en línea y entregadas.
- Estado real de tu entrega en Moodle: sin entregar, borrador sin enviar, entregada, calificada (con la nota).
- Cuestionarios y otras actividades con fecha, tomadas del calendario de Moodle.
- Filtro por curso y buscador. Puedes marcar una tarea como hecha a mano (por ejemplo, si la entregaste por otro medio).
- Fechas en hora de Colombia.
- Solo cursos **en progreso**: usa la misma clasificación que el panel de Moodle. Los cursos terminados y los que excluyas no aparecen.

## Requisitos

- Node.js 20 o superior. No hay que instalar dependencias.
- Que tu Moodle tenga habilitado el servicio móvil (si usas la app de Moodle con tu cuenta, lo tiene).

## Uso

```bash
npm run login     # una sola vez: pide dirección, usuario y contraseña en tu terminal
npm run sync      # descarga tus cursos y tareas
npm start         # abre el panel en http://127.0.0.1:4173
npm run status    # resumen rápido en la terminal, sin abrir el panel
npm run pending   # solo lo que NO has entregado, por curso (usa --json para otros programas)
npm run exclude -- "Nombre del curso"   # oculta un curso (por ejemplo, uno al que te inscribieron por error)
```

También puedes sincronizar desde el botón del panel.

## Entregar tareas (siempre con tu autorización)

La entrega tiene **dos pasos** y no hay atajo para saltarse el primero:

```bash
# 1) Vista previa: NO sube ni guarda nada. Muestra qué se entregaría y da un código.
npm run submit -- "Taller No. 1" --file informe.pdf [--file anexo.docx] [--text "..."] [--final]

# 2) Confirmación: solo con el código de la vista previa.
npm run submit -- --confirm <código> [--acepto-declaracion]

npm run submit -- --cancel     # descarta la vista previa
```

- **Borrador o envío definitivo:** sin `--final`, si la tarea tiene botón "Enviar", se guarda como borrador (el profesor no lo ve). Con `--final` se envía. Si la tarea **no** tiene ese botón, guardar ya es entregar, y la vista previa lo avisa.
- **El código solo vale para ese plan exacto:** depende de la tarea, del contenido de los archivos, del texto y de si es definitiva. Si algo cambia, se rechaza. Caduca a los 30 minutos y no se puede reutilizar.
- **Comprobaciones antes de tocar Moodle:** entregas abiertas o cerradas, fecha de cierre, entrega bloqueada, número, tamaño y tipo de archivos, si la tarea acepta archivos o texto, y qué archivos ya subidos se reemplazarían. Marca las entregas tardías.
- **Declaración de autoría:** si Moodle la exige para el envío definitivo, hay que aceptarla de forma explícita con `--acepto-declaracion`.
- Cada entrega queda anotada en `data/submissions.log`.
- El panel web **no** puede entregar: es una acción que solo existe en la terminal.

Quien use esto en nombre de otra persona (por ejemplo, un asistente) debe enseñar la vista previa a esa persona y ejecutar la confirmación solo después de un sí explícito.

## Privacidad y seguridad

- **La contraseña no se guarda.** Solo se usa en `npm run login` para pedirle un token a Moodle. Se guarda ese token en `data/session.json`.
- `data/` está en `.gitignore`: el token y tus datos no se suben a git. No compartas ese archivo, porque el token da acceso de lectura a tu cuenta.
- Para invalidar el token, en Moodle ve a *Preferencias → Claves de seguridad* y restablécelo, o cambia tu contraseña.
- El servidor solo escucha en `127.0.0.1` y las acciones que modifican algo exigen una cabecera propia, para que otra página abierta en tu navegador no pueda disparar peticiones contra él.
- El programa **lee** datos de Moodle. Solo escribe cuando entregas una tarea con el flujo de dos pasos de arriba: nunca borra nada.

## Cómo funciona

| Archivo | Función |
|---|---|
| `src/moodle.js` | Cliente de la API: pide el token y llama a las funciones de web services |
| `src/sync.js` | Descarga cursos, tareas, estado de entrega y eventos del calendario |
| `src/status.js` | Clasifica cada tarea por urgencia (hora de Bogotá) |
| `src/store.js` | Guarda sesión, datos, marcas manuales y cursos excluidos en `data/` |
| `src/submit.js` | Entrega en dos pasos: vista previa y confirmación con código |
| `src/server.js` | Servidor local del panel y su API |
| `public/index.html` | El panel |

Funciones de Moodle que usa (las de escritura solo al entregar: `mod_assign_save_submission`, `mod_assign_submit_for_grading` y la subida de archivos a tu área de borradores): `core_webservice_get_site_info`, `core_course_get_enrolled_courses_by_timeline_classification` (cursos en progreso; con `core_enrol_get_users_courses` como respaldo), `mod_assign_get_assignments`, `mod_assign_get_submission_status` y `core_calendar_get_action_events_by_timesort`.

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
