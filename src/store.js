// Persistencia local en archivos JSON dentro de data/ (ignorado por git).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.TRACKER_DATA_DIR || path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

const files = {
  session: () => path.join(DATA_DIR, 'session.json'),
  data: () => path.join(DATA_DIR, 'data.json'),
  overrides: () => path.join(DATA_DIR, 'overrides.json'),
};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function writeJson(file, value, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode });
  await fs.rename(tmp, file);
}

/** La sesión guarda solo la dirección y el token. Nunca la contraseña. */
export const loadSession = () => readJson(files.session(), null);
export const saveSession = (s) => writeJson(files.session(), { ...s, savedAt: Date.now() }, 0o600);

export const loadData = () => readJson(files.data(), null);
export const saveData = (d) => writeJson(files.data(), d);

export const loadOverrides = () => readJson(files.overrides(), {});
export async function setOverride(id, done) {
  const o = await loadOverrides();
  if (done) o[id] = true;
  else delete o[id];
  await writeJson(files.overrides(), o);
  return o;
}

// Configuración personal: cursos que no quieres ver (por ejemplo, uno al que te inscribieron por error).
export const loadConfig = async () => ({ excludeCourses: [], ...(await readJson(path.join(DATA_DIR, 'config.json'), {})) });
export async function saveConfig(cfg) {
  await writeJson(path.join(DATA_DIR, 'config.json'), cfg);
  return cfg;
}
