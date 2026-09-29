# AGENTS.md — reglas para cualquier agente que opere este repo

Este archivo formaliza las reglas de operación para un asistente/agente (humano con copiloto, o un LLM con herramientas) que trabaje sobre `moodle-tracker`. No reemplaza el [README.md](README.md): ahí está el qué y el cómo del programa; aquí está qué tiene permitido *hacer* un agente sin preguntar, y qué necesita autorización explícita cada vez.

## 1. Modelo de permisos con Moodle

- **Por defecto, todo es de solo lectura.** `src/sync.js`, `src/content.js` y el servidor (`src/server.js`) solo llaman funciones `get_`/`view_` de la API de Moodle. Un agente puede ejecutarlas libremente (`npm run sync`, `npm run content`, abrir el panel) sin pedir permiso: es exactamente lo que hace la app.
- **La única escritura contra Moodle real es la entrega de tareas**, y vive solo en `src/submit.js` + el comando `npm run submit`. Tiene que seguir siendo de dos pasos:
  1. Vista previa (sin `--confirm`): no sube ni guarda nada, solo genera un código.
  2. Confirmación (`--confirm <código>`): ejecuta de verdad.
- **Un agente nunca ejecuta el paso de confirmación por su cuenta.** Si el usuario le pidió "entrega esto", el agente corre la vista previa, se la muestra tal cual (curso, tarea, archivos, si es borrador o definitiva, avisos) y espera un sí explícito antes de correr `--confirm`. Esto ya estaba en el README; aquí queda como regla dura, no como sugerencia.
- **No se agregan funciones de Moodle nuevas "por si sirven".** Si una tarea requiere llamar una función de `core_webservice_get_site_info` que hoy no se usa, se añade explícitamente para esa tarea (con su propio código en `src/moodle.js`/`src/sync.js`), no se deja un cliente genérico que invoque cualquier función por nombre.
- **Nunca invocar, a modo de prueba, funciones de Moodle que la app no usa** (el servicio móvil de cualquier Moodle trae habilitadas muchas más funciones de las que esta app llama) solo para ver qué hacen. Enumerar `core_webservice_get_site_info` y leer su metadata está bien —es lo que ya hace `login`/`sync`—; ejecutar funciones de escritura o de otros módulos para "tantear" el alcance ya no es leer tus propios datos, es sondear la infraestructura de la institución sin su autorización. Ese análisis se hace de forma estática (nombres de función, capacidades documentadas por Moodle, avisos de seguridad públicos), nunca invocando en producción.
- **Nada de esto autoriza pruebas de seguridad activas contra el Moodle real** (intentar bypass de permisos, credential stuffing, fuzzing de la API, etc.), con o sin el token del usuario. Si en el camino se encuentra una falla real, el siguiente paso es reportarla de forma responsable a quien administra ese Moodle (nunca a un canal público como este repo) y esperar a que se corrija antes de hablar de ella en detalle — no explotarla ni usarla como demostración.

## 2. Datos y credenciales

- El token vive únicamente en `data/session.json`. Nunca se imprime completo en logs, commits, mensajes de chat ni capturas. `data/` ya está en `.gitignore`: no se fuerza su inclusión.
- La contraseña de Moodle solo se usa una vez, en `requestToken` (`src/moodle.js`), para pedir el token. No se guarda en ningún archivo ni variable persistente.
- `npm test` corre contra un Moodle simulado (mocks en los tests). Un agente nunca apunta los tests, ni ningún script de prueba nuevo, contra el Moodle real de la universidad.

## 3. Servidor local (`src/server.js`)

- Escucha solo en `127.0.0.1`. No se cambia a `0.0.0.0` ni se expone a la red sin que el usuario lo pida explícitamente y entienda que eso comparte su sesión de Moodle con cualquiera en esa red. Esto aplica igual si corre en Docker: el `docker-compose.yml` publica el puerto como `127.0.0.1:4173:4173`, nunca como `4173:4173` (que en Docker sí escucha en `0.0.0.0` del host aunque el proceso adentro solo escuche en `127.0.0.1`).
- Toda mutación (`POST`) exige el header `x-requested-with: moodle-tracker`. Si se agregan rutas nuevas que cambien estado, deben respetar ese mismo chequeo.
- El panel web (`public/index.html`) nunca entrega tareas. Esa acción sigue existiendo solo por CLI, a propósito, para forzar que pase por el flujo de dos pasos en un terminal que el usuario está mirando.

## 4. Interfaz (estética hacker)

- Mantener la paleta y el lenguaje visual ya definidos en `public/index.html` (magenta/violeta/verde sobre negro, tipografía monoespaciada, glitch, scanlines, calaveras pixel, lluvia de fondo).
- Las calaveras y el resto del arte son **originales, generados en código** (bitmaps propios dibujados en `<canvas>`), no assets calcados de terceros. No se importan logos ni artes de franquicias (p. ej. el logo de DedSec de Watch Dogs) aunque el proyecto sea de uso local: se puede tomar la paleta/estilo, no la obra puntual.
- Toda animación nueva respeta `prefers-reduced-motion` (si está activo, se desactiva la animación, no solo se atenúa).
- Cero dependencias de build. Todo sigue siendo HTML/CSS/JS plano sin frameworks ni bundler; una fuente web opcional (Google Fonts) es aceptable siempre que tenga fallback a fuente monoespaciada del sistema si no hay internet.

## 5. Git

- No commitear nada dentro de `data/` (sesión, contenido descargado, material, logs de entregas).
- No commitear el token ni ninguna credencial, aunque aparezca solo en un ejemplo o en un mensaje de commit.
