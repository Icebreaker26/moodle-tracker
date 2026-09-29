# moodle-tracker

![licencia](https://img.shields.io/badge/licencia-MIT-b967ff) ![node](https://img.shields.io/badge/node-%3E%3D20-00ffa2) ![dependencias](https://img.shields.io/badge/dependencias-0-ff2e88) ![build](https://img.shields.io/badge/build%20step-ninguno-eef0f6)

```
     .-""""""-.
    /  ()  ()  \
   |      ▽     |
    \  '----'  /
     '-......-'

root@aula:~$ whoami
moodle-tracker — no pierdas el rastro de tus entregas
```

Panel local para no perder el rastro de las tareas del aula virtual (Moodle): qué está vencido, qué vence hoy o esta semana, y qué ya entregaste.

Usa la **API oficial de web services de Moodle** (la misma que usa la app móvil), no scraping de páginas. Todo corre en tu computador: no hay servidores intermedios, no hay cuentas nuevas, no hay `npm install`.

> **Principio de diseño: sencillez por encima de todo.** Cero dependencias, cero paso de build, cero framework. Vanilla JS/CSS/HTML en el panel, vanilla Node en el backend. Si una función nueva solo se justifica agregando una dependencia, probablemente no pertenece aquí — ver [Contribuir](#contribuir).

## Índice

- [Qué muestra](#qué-muestra)
- [Requisitos](#requisitos)
- [Inicio rápido](#inicio-rápido)
- [Uso completo](#uso-completo)
- [Docker (opcional)](#docker-opcional)
- [Si sos un agente / le vas a pedir a uno que opere esto](#si-sos-un-agente--le-vas-a-pedir-a-uno-que-opere-esto)
- [Privacidad y seguridad](#privacidad-y-seguridad)
- [Estructura del repo](#estructura-del-repo)
- [Usarlo con tu propio Moodle](#usarlo-con-tu-propio-moodle)
- [Pruebas](#pruebas)
- [Si algo falla](#si-algo-falla)
- [Contribuir](#contribuir)
- [Licencia](#licencia)

## Qué muestra

- Tareas agrupadas por urgencia: **vencidas sin entregar**, **vencen hoy**, **esta semana**, **más adelante**, sin fecha, sin entrega en línea y entregadas.
- Estado real de tu entrega en Moodle: sin entregar, borrador sin enviar, entregada, calificada (con la nota).
- Cuestionarios y otras actividades con fecha, tomadas del calendario de Moodle.
- Filtro por curso y buscador. Puedes marcar una tarea como hecha a mano (por ejemplo, si la entregaste por otro medio).
- Fechas en hora de Colombia.
- Solo cursos **en progreso**: usa la misma clasificación que el panel de Moodle. Los cursos terminados y los que excluyas no aparecen.

## Requisitos

- Node.js 20 o superior. No hay que instalar dependencias (`npm install` no hace nada porque no hay ninguna).
- Que tu Moodle tenga habilitado el servicio móvil (si usas la app de Moodle con tu cuenta, lo tiene).

## Inicio rápido

Cuatro comandos, sin configuración manual:

```bash
npm run login     # una sola vez: pide dirección, usuario y contraseña en tu terminal
npm run sync      # descarga tus cursos, tareas y contenido
npm start         # abre el panel en http://127.0.0.1:4173
npm run status    # o, si no quieres abrir el navegador, un resumen en la terminal
```

## Uso completo

### Comandos básicos

```bash
npm run pending   # solo lo que NO has entregado, por curso (usa --json para otros programas)
npm run exclude -- "Nombre del curso"   # oculta un curso (por ejemplo, uno al que te inscribieron por error)
npm run exclude -- --remove "Nombre del curso"
```

También puedes sincronizar desde el botón del panel — el comando y el botón hacen exactamente lo mismo.

### Leer todo el contenido de los cursos

`npm run sync` no solo trae las tareas: lee el contenido completo de cada curso en progreso (secciones, actividades, foros, cuestionarios, material) y lo guarda en `data/content.json`.

- **Foros con fecha, cuestionarios y otras actividades** (encuestas, nubes de palabras, lecciones...) aparecen en la lista de pendientes junto a las tareas.
- **Finalización real:** para las actividades con seguimiento, la app usa los detalles de finalización de Moodle y muestra exactamente qué falta (por ejemplo, "Publicar respuestas: 1; Hacer publicaciones en el foro: 2"). Un foro donde publicaste un hilo puede seguir incompleto si exige responder a otros.
- Los cuestionarios se cuentan como hechos si tienen un intento terminado.

```bash
npm run content                      # esquema de cada curso: secciones, actividades, fechas y si las completaste
npm run content -- Geopolítica       # solo un curso
npm run content -- --forums          # mensajes recientes de los foros y avisos
npm run content -- --material        # material que Moodle marca como no visto
npm run material                     # descarga los archivos de los cursos a data/material/ (no repite lo ya bajado)
npm run material -- Ética --max-mb 50
```

### Entregar tareas (siempre con tu autorización)

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
- El panel web **no** puede entregar: es una acción que solo existe en la terminal, a propósito.

## Docker (opcional)

**No es el camino recomendado.** Node ya es más simple de instalar que Docker, y esta app no necesita nada que Docker resuelva (no hay dependencias que aislar, no hay "funciona en mi máquina"). Está acá para quien ya tiene Docker y lo prefiere así, o lo necesita para un ejercicio de dockerización.

```bash
docker compose build

# Comandos de una sola vez (comparten el volumen ./data con el panel):
docker compose run --rm tracker node src/cli.js login     # interactivo: pide usuario y contraseña
docker compose run --rm tracker node src/cli.js sync
docker compose run --rm tracker node src/cli.js status
docker compose run --rm tracker node src/cli.js submit -- "Taller No. 1" --file /app/data/informe.pdf

# El panel (queda en segundo plano):
docker compose up -d          # http://127.0.0.1:4173
docker compose down
```

- `data/` del host se monta dentro del contenedor: tu sesión y tus datos sobreviven a `docker compose down` y nunca quedan horneados dentro de la imagen (el `.dockerignore` los excluye a propósito — una imagen es tan distribuible como un commit).
- Para `submit --file`, el archivo tiene que estar dentro de `./data` en tu máquina (ahí es donde el contenedor lo puede ver); referencialo como `/app/data/lo-que-sea`.
- El `docker-compose.yml` publica el puerto como `127.0.0.1:4173:4173`, no como `4173:4173`. Es a propósito: `4173:4173` sale en `0.0.0.0` del host, cualquiera en tu red vería tu panel. No lo cambies sin querer eso.

## Si sos un agente / le vas a pedir a uno que opere esto

Este repo está pensado para que un asistente (Claude u otro) lo maneje directamente por vos, no solo para que lo lea. Las reglas completas están en **[AGENTS.md](AGENTS.md)**; el resumen que no te podés saltar:

| Puede hacer sin preguntar | Necesita tu sí explícito cada vez |
|---|---|
| `login`, `sync`, `status`, `pending`, `content`, `material` — todo de solo lectura contra Moodle | Ejecutar `submit -- --confirm <código>` (el paso 2 de una entrega) |
| Leer `data/` en tu máquina para responder preguntas sobre tus cursos | Exponer el servidor local fuera de `127.0.0.1` |
| Enumerar `core_webservice_get_site_info` (metadata, ya lo hace `login`) | Invocar cualquier función de Moodle que la app no usa, "para ver qué hace" |

Regla dura, sin excepciones: **un agente nunca corre el paso de confirmación de una entrega sin que vos hayas visto la vista previa y hayas dicho que sí.** Si te pidió "entrega esto", lo correcto es que te muestre el paso 1 tal cual sale en la terminal y espere tu respuesta antes de tocar `--confirm`.

## Privacidad y seguridad

- **La contraseña no se guarda.** Solo se usa en `npm run login` para pedirle un token a Moodle. Se guarda ese token en `data/session.json`.
- `data/` está en `.gitignore`: el token y tus datos no se suben a git. No compartas ese archivo, porque el token da acceso de lectura a tu cuenta.
- Para invalidar el token, en Moodle ve a *Preferencias → Claves de seguridad* y restablécelo, o cambia tu contraseña.
- El servidor solo escucha en `127.0.0.1` y las acciones que modifican algo exigen una cabecera propia, para que otra página abierta en tu navegador no pueda disparar peticiones contra él.
- El programa **lee** datos de Moodle. Solo escribe cuando entregas una tarea con el flujo de dos pasos de arriba: nunca borra nada.

## Estructura del repo

```
moodle-tracker/
├── src/
│   ├── cli.js       # punto de entrada de todos los comandos (npm run <comando>)
│   ├── moodle.js    # cliente de la API: pide el token y llama a las funciones de web services
│   ├── sync.js       # descarga cursos, tareas, estado de entrega y eventos del calendario
│   ├── content.js    # lee el contenido de los cursos: foros, cuestionarios, actividades, material
│   ├── submit.js     # entrega en dos pasos: vista previa y confirmación con código
│   ├── status.js     # clasifica cada tarea por urgencia (hora de Bogotá)
│   ├── store.js      # guarda sesión, datos, marcas manuales y cursos excluidos en data/
│   └── server.js     # servidor local del panel y su API
├── public/
│   └── index.html   # el panel: HTML + CSS + JS en un solo archivo, sin build
├── test/            # pruebas contra un Moodle simulado, nunca contra el real
├── data/            # tu sesión y tus datos (gitignored, nunca se sube)
├── Dockerfile / docker-compose.yml   # opcional, ver "Docker" arriba
├── AGENTS.md        # reglas de operación para agentes/asistentes
└── LICENSE
```

Funciones de Moodle que usa (las de escritura solo al entregar: `mod_assign_save_submission`, `mod_assign_submit_for_grading` y la subida de archivos a tu área de borradores): `core_webservice_get_site_info`, `core_course_get_enrolled_courses_by_timeline_classification` (cursos en progreso; con `core_enrol_get_users_courses` como respaldo), `mod_assign_get_assignments`, `mod_assign_get_submission_status` y `core_calendar_get_action_events_by_timesort`.

## Usarlo con tu propio Moodle

No hay nada de una universidad en particular escrito en el código: la dirección que ves en `npm run login` es solo un valor por defecto para no tenerla que escribir cada vez. Cualquiera con cuenta en un Moodle que tenga habilitado el servicio móvil puede usar este mismo programa apuntando a su propia institución — cada quien guarda su propio token en su copia local de `data/`, nadie comparte nada con nadie.

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

## Contribuir

1. Antes de tocar cualquier cosa que hable con Moodle, lee [AGENTS.md](AGENTS.md) — humano o agente, las reglas son las mismas.
2. Antes de agregar una dependencia, un build step o un framework, preguntate si de verdad hace falta. La respuesta casi siempre es que no: el proyecto entero vive sin ninguno de los tres.
3. `npm test` tiene que seguir en verde. Si tu cambio toca `public/index.html`, ábrelo y probalo en el navegador — los tests no verifican que la interfaz se vea o se sienta bien, solo que el servidor responda lo que debe.
4. PRs pequeños y de un solo tema. Un tipo de actividad nuevo, un idioma nuevo, una vista nueva: cada uno por separado.

## Licencia

[MIT](LICENSE) — úsalo, cópialo, cámbiale hasta el nombre.
