// Descarga cursos, tareas y su estado de entrega desde Moodle y los normaliza.

import { isExcluded } from './status.js';

const DAY = 86400;

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Cursos "en progreso": la misma clasificación que usa el panel de Moodle.
 * Si esa función no está permitida, se usa un respaldo por fechas de los cursos.
 */
async function listCourses(client, { userid, nowSec, includePast, warnings }) {
  try {
    const out = [];
    let offset = 0;
    for (let i = 0; i < 20; i++) {
      const r = await client.call('core_course_get_enrolled_courses_by_timeline_classification', {
        classification: includePast ? 'all' : 'inprogress',
        limit: 0,
        offset,
        sort: 'fullname',
      });
      const page = r.courses || [];
      out.push(...page);
      if (!page.length || !(r.nextoffset > offset)) break;
      offset = r.nextoffset;
    }
    const unique = new Map(out.map((c) => [c.id, { id: c.id, name: c.fullname, short: c.shortname }]));
    return [...unique.values()];
  } catch (e) {
    warnings.push(`No se pudo usar la clasificación "en progreso" de Moodle (${e.message}); se filtraron los cursos por sus fechas.`);
    const raw = await client.call('core_enrol_get_users_courses', { userid });
    return raw
      .filter((c) => includePast || !(c.enddate > 0 && c.enddate < nowSec - 30 * DAY))
      .map((c) => ({ id: c.id, name: c.fullname, short: c.shortname }));
  }
}

/** Interpreta la respuesta de mod_assign_get_submission_status. */
export function parseSubmission(res) {
  const la = res?.lastattempt || {};
  const sub = la.submission || la.teamsubmission || null;
  const status = sub?.status || 'new';
  const graded = la.gradingstatus === 'graded';
  const gradeText = res?.feedback?.gradefordisplay ? String(res.feedback.gradefordisplay).replace(/<[^>]*>/g, '').trim() : null;
  let state = 'pendiente';
  if (status === 'submitted') state = graded ? 'calificada' : 'entregada';
  else if (status === 'draft') state = 'borrador';
  else if (la.submissionsenabled === false) state = 'sin_entrega_en_linea';
  return { state, graded, grade: graded ? gradeText : null };
}

/**
 * @param client instancia de Moodle (o algo con .call y .baseUrl)
 * @param opts.nowSec  segundos unix (para pruebas)
 * @param opts.includePast incluir cursos ya terminados
 */
export async function syncAll(client, { nowSec = Math.floor(Date.now() / 1000), includePast = false, exclude = [], log = () => {} } = {}) {
  const warnings = [];
  const info = await client.call('core_webservice_get_site_info');
  const userid = info.userid;
  log(`Sesión de ${info.fullname}`);

  const courses = (await listCourses(client, { userid, nowSec, includePast, warnings })).filter((c) => !isExcluded(c.name, exclude));
  const courseById = new Map(courses.map((c) => [c.id, c]));
  log(`${courses.length} cursos en progreso`);

  const tasks = [];

  // 1) Tareas (assign) con su estado de entrega
  if (courses.length) {
    let assignData = { courses: [] };
    try {
      assignData = await client.call('mod_assign_get_assignments', { courseids: courses.map((c) => c.id) });
    } catch (e) {
      warnings.push(`No se pudieron leer las tareas: ${e.message}`);
    }
    const assigns = [];
    for (const c of assignData.courses || []) {
      if (!courseById.has(c.id)) continue; // por si Moodle devuelve más cursos de los pedidos
      for (const a of c.assignments || []) assigns.push({ ...a, courseId: c.id });
    }
    log(`${assigns.length} tareas encontradas`);

    const statuses = await pool(assigns, 5, async (a) => {
      try {
        return parseSubmission(await client.call('mod_assign_get_submission_status', { assignid: a.id }));
      } catch (e) {
        warnings.push(`Estado de "${a.name}": ${e.message}`);
        return { state: 'desconocido', graded: false, grade: null };
      }
    });

    assigns.forEach((a, i) => {
      const st = statuses[i];
      tasks.push({
        id: `assign:${a.id}`,
        kind: 'tarea',
        courseId: a.courseId,
        course: courseById.get(a.courseId)?.name || `Curso ${a.courseId}`,
        name: a.name,
        dueAt: a.duedate > 0 ? a.duedate * 1000 : null,
        cutoffAt: a.cutoffdate > 0 ? a.cutoffdate * 1000 : null,
        state: a.nosubmissions ? 'sin_entrega_en_linea' : st.state,
        graded: st.graded,
        grade: st.grade,
        url: `${client.baseUrl}/mod/assign/view.php?id=${a.cmid}`,
      });
    });
  }

  // 2) Eventos de acción del calendario (cuestionarios, foros, etc.), sin repetir tareas
  try {
    const cal = await client.call('core_calendar_get_action_events_by_timesort', {
      timesortfrom: nowSec - 7 * DAY,
      limitnum: 100,
    });
    let added = 0;
    for (const ev of cal.events || []) {
      if (ev.modulename === 'assign') continue;
      if (ev.action && ev.action.actionable === false) continue;
      const courseId = ev.course?.id;
      if (!courseById.has(courseId)) continue; // solo cursos en progreso
      tasks.push({
        id: `cal:${ev.id}`,
        kind: ev.modulename || 'evento',
        courseId,
        course: ev.course?.fullname || courseById.get(courseId)?.name || 'Sin curso',
        name: ev.name,
        dueAt: ev.timesort > 0 ? ev.timesort * 1000 : null,
        cutoffAt: null,
        state: 'pendiente',
        graded: false,
        grade: null,
        url: ev.url || null,
      });
      added++;
    }
    log(`${added} eventos del calendario`);
  } catch (e) {
    warnings.push(`No se pudo leer el calendario: ${e.message}`);
  }

  return {
    generatedAt: nowSec * 1000,
    baseUrl: client.baseUrl,
    user: { id: userid, name: info.fullname },
    courses,
    tasks,
    warnings,
  };
}
