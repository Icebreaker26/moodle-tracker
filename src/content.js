// Lectura del contenido completo de los cursos: secciones, actividades, foros, cuestionarios y material.
// Todo es de solo lectura.
import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** HTML de Moodle a texto plano legible. */
export function stripHtml(html = '') {
  return String(html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Tipos que son material de lectura (no una entrega).
const MATERIAL = new Set(['resource', 'url', 'page', 'folder', 'book', 'imscp', 'label']);
// Tipos que ya se cubren por otro lado o que no requieren acción.
const SKIP_ACTIVITY = new Set([...MATERIAL, 'assign', 'quiz', 'forum', 'subsection']);

const isDone = (m) => m.completion > 0 && [1, 2].includes(m.completiondata?.state);
const DATE_LABEL = /cierre|cierra|cerr[oó]|vencimiento|vence|fecha l[ií]mite|hasta|due|clos/i;

function moduleInfo(m, section, st) {
  const done = m.completion > 0 ? (st ? [1, 2].includes(st.state) : isDone(m)) : null;
  return {
    cmid: m.id,
    instance: m.instance,
    modname: m.modname,
    name: m.name,
    section: section.name,
    url: m.url || null,
    visible: m.uservisible !== false,
    completion: m.completion || 0, // 0 no aplica · 1 manual · 2 automática
    completed: done,
    // Reglas de finalización que aún faltan (por ejemplo: "Publicar respuestas: 1").
    missing: (st?.details || []).filter((d) => d.rulevalue?.status === 0).map((d) => d.rulevalue.description),
    dates: (m.dates || []).map((d) => ({ label: String(d.label || '').replace(/:$/, ''), at: d.timestamp * 1000 })),
    description: stripHtml(m.description || ''),
    files: (m.contents || []).filter((c) => c.type === 'file').map((c) => ({
      filename: c.filename, size: c.filesize, mime: c.mimetype, modified: (c.timemodified || 0) * 1000, url: c.fileurl,
    })),
    links: (m.contents || []).filter((c) => c.type === 'url').map((c) => c.fileurl),
  };
}

/**
 * Lee todo el contenido de los cursos indicados.
 * Devuelve { courses, tasks, warnings }: courses con su esquema; tasks son entregas/actividades pendientes
 * que el calendario no mostraba (foros con fecha, cuestionarios, actividades por completar).
 */
export async function readContent(client, courses, { userid, log = () => {}, forumMessages = 10 } = {}) {
  const warnings = [];
  const out = { courses: [], tasks: [], warnings };
  if (!courses.length) return out;
  const ids = courses.map((c) => c.id);
  const byId = new Map(courses.map((c) => [c.id, c]));
  const safe = async (label, fn, fallback) => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${label}: ${e.message}`);
      return fallback;
    }
  };

  const [forumList, quizList] = await Promise.all([
    safe('Foros', () => client.call('mod_forum_get_forums_by_courses', { courseids: ids }), []),
    safe('Cuestionarios', async () => (await client.call('mod_quiz_get_quizzes_by_courses', { courseids: ids })).quizzes || [], []),
  ]);
  const forumById = new Map(forumList.map((f) => [f.id, f]));
  const quizById = new Map(quizList.map((q) => [q.id, q]));

  for (const c of courses) {
    const sections = await safe(`Contenido de "${c.name}"`, () => client.call('core_course_get_contents', { courseid: c.id }), null);
    if (!sections) continue;
    const cs = await safe(`Finalización de "${c.name}"`, () => client.call('core_completion_get_activities_completion_status', { courseid: c.id, userid }), null);
    const statusByCm = new Map((cs?.statuses || []).map((x) => [x.cmid, x]));
    const modules = sections.flatMap((s) => s.modules.map((m) => moduleInfo(m, s, statusByCm.get(m.id))));
    const course = { id: c.id, name: c.name, short: c.short, sections: sections.map((s) => ({
      name: s.name, summary: stripHtml(s.summary || ''),
      modules: modules.filter((m) => m.section === s.name),
    })), forums: [], quizzes: [] };
    log(`${c.name}: ${modules.length} actividades`);

    const taskBase = (m) => ({ courseId: c.id, course: c.name, name: m.name, url: m.url, cutoffAt: null, graded: false, grade: null });

    // --- Foros: mensajes recientes y, si tienen fecha, si ya participaste
    for (const m of modules.filter((x) => x.modname === 'forum')) {
      const f = forumById.get(m.instance);
      if (!f) continue;
      const disc = await safe(`Foro "${m.name}"`, async () =>
        (await client.call('mod_forum_get_forum_discussions', { forumid: f.id, sortorder: -1, page: 0, perpage: forumMessages })).discussions || [], []);
      const messages = disc.map((d) => ({
        discussion: d.discussion, subject: d.subject || d.name, author: d.userfullname, authorId: d.userid,
        at: (d.timemodified || d.created || 0) * 1000, text: stripHtml(d.message || ''),
      }));
      const dueAt = f.duedate > 0 ? f.duedate * 1000 : null;
      course.forums.push({ id: f.id, cmid: m.cmid, name: m.name, type: f.type, dueAt, cutoffAt: f.cutoffdate > 0 ? f.cutoffdate * 1000 : null, messages });

      if (dueAt || (m.completion > 0 && !m.completed)) {
        let done;
        if (m.completion > 0) {
          done = m.completed; // Moodle sabe qué exige el foro (respuestas, número de mensajes...)
        } else {
          done = messages.some((x) => x.authorId === userid);
          if (!done && disc.length) {
            // Puede que hayas respondido en un hilo de otra persona: se revisan las respuestas.
            for (const d of disc.slice(0, 15)) {
              const posts = await safe(`Mensajes de "${d.name}"`, async () =>
                (await client.call('mod_forum_get_discussion_posts', { discussionid: d.discussion })).posts || [], []);
              if (posts.some((p) => p.author?.id === userid)) { done = true; break; }
            }
          }
        }
        out.tasks.push({ ...taskBase(m), id: `forum:${f.id}`, kind: 'foro', dueAt, cutoffAt: f.cutoffdate > 0 ? f.cutoffdate * 1000 : null,
          state: done ? 'entregada' : 'pendiente', missing: done ? [] : m.missing, graded: false, grade: null });
      }
    }

    // --- Cuestionarios: intentos hechos
    for (const m of modules.filter((x) => x.modname === 'quiz')) {
      const q = quizById.get(m.instance);
      if (!q) continue;
      const att = await safe(`Intentos de "${m.name}"`, async () =>
        (await client.call('mod_quiz_get_user_attempts', { quizid: q.id, userid, status: 'all', includepreviews: 0 })).attempts || [], null);
      const finished = (att || []).some((a) => a.state === 'finished');
      const inprogress = (att || []).some((a) => a.state === 'inprogress');
      const state = att === null ? 'desconocido' : finished ? 'entregada' : inprogress ? 'borrador' : 'pendiente';
      course.quizzes.push({ id: q.id, cmid: m.cmid, name: m.name, opensAt: q.timeopen > 0 ? q.timeopen * 1000 : null, closesAt: q.timeclose > 0 ? q.timeclose * 1000 : null, attempts: (att || []).length, state });
      out.tasks.push({ ...taskBase(m), id: `quiz:${q.id}`, kind: 'cuestionario', dueAt: q.timeclose > 0 ? q.timeclose * 1000 : null,
        opensAt: q.timeopen > 0 ? q.timeopen * 1000 : null, state });
    }

    // --- Otras actividades con seguimiento de finalización (encuestas, nubes de palabras, lecciones...)
    for (const m of modules) {
      if (SKIP_ACTIVITY.has(m.modname) || m.completion <= 0 || m.completed || !m.visible) continue;
      const due = m.dates.find((d) => DATE_LABEL.test(d.label));
      out.tasks.push({ ...taskBase(m), id: `mod:${m.cmid}`, kind: m.modname, dueAt: due?.at || null, state: 'pendiente', missing: m.missing });
    }

    out.courses.push(course);
  }
  return out;
}

/** Material de lectura que Moodle marca como no visto todavía. */
export function unviewedMaterial(course) {
  return course.sections.flatMap((s) => s.modules)
    .filter((m) => MATERIAL.has(m.modname) && m.modname !== 'label' && m.completion > 0 && !m.completed && m.visible);
}

const safeName = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'archivo';

/**
 * Descarga los archivos del material a una carpeta local. No sobrescribe archivos ya descargados con el mismo tamaño.
 * Devuelve { downloaded, skipped, failed }.
 */
export async function downloadMaterial(client, course, dir, { maxBytes = 100 * 1024 * 1024, only = null, log = () => {} } = {}) {
  const result = { downloaded: [], skipped: [], failed: [] };
  const mods = course.sections.flatMap((s, si) => s.modules.map((m) => ({ ...m, si })));
  for (const m of mods) {
    if (only && !only(m)) continue;
    if (!m.files.length) continue;
    for (const f of m.files) {
      const folder = path.join(dir, safeName(course.short || course.name), `${String(m.si + 1).padStart(2, '0')} ${safeName(m.section)}`);
      const dest = path.join(folder, safeName(f.filename));
      try {
        if (f.size > maxBytes) { result.skipped.push({ file: f.filename, why: `pesa más de ${Math.round(maxBytes / 1048576)} MB` }); continue; }
        const st = await fs.stat(dest).catch(() => null);
        if (st && st.size === f.size) { result.skipped.push({ file: f.filename, why: 'ya descargado' }); continue; }
        await fs.mkdir(folder, { recursive: true });
        const url = f.url + (f.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(client.token);
        const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
        result.downloaded.push({ file: f.filename, path: dest, size: f.size });
        log(`↓ ${f.filename}`);
      } catch (e) {
        result.failed.push({ file: f.filename, why: e.message });
      }
    }
  }
  return result;
}
