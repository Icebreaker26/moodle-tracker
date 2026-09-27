// Cliente mínimo de la API de web services de Moodle (solo lectura).
// Usa fetch nativo: no requiere dependencias.

export class MoodleError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MoodleError';
    this.code = code || 'moodle_error';
  }
}

/** Normaliza la dirección: quita rutas de login y barras finales. */
export function normalizeBaseUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new MoodleError('Falta la dirección de Moodle', 'missing_url');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  const url = new URL(u);
  let path = url.pathname.replace(/\/(login|my|course|mod|webservice)\/.*$/i, '').replace(/\/+$/, '');
  return url.origin + path;
}

/** Convierte parámetros anidados al formato que espera Moodle: a[0]=1, b[0][x]=2. */
export function flatten(params, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((x, i) => {
        if (x && typeof x === 'object') flatten(x, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(x));
      });
    } else if (v && typeof v === 'object') {
      flatten(v, key, out);
    } else if (v !== undefined && v !== null) {
      out.append(key, String(v));
    }
  }
  return out;
}

async function postForm(url, body, timeoutMs = 30000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new MoodleError(`El servidor respondió HTTP ${res.status}`, 'http_' + res.status);
  try {
    return await res.json();
  } catch {
    throw new MoodleError('La respuesta de Moodle no es JSON (¿dirección incorrecta?)', 'bad_response');
  }
}

/**
 * Pide un token a Moodle con usuario y contraseña.
 * La contraseña solo viaja en esta petición: nunca se guarda.
 */
export async function requestToken(baseUrl, username, password, service = 'moodle_mobile_app') {
  const body = new URLSearchParams({ username, password, service });
  const data = await postForm(`${baseUrl}/login/token.php`, body);
  if (data.error || !data.token) {
    throw new MoodleError(data.error || 'Moodle no entregó un token', data.errorcode || 'no_token');
  }
  return data.token;
}

export class Moodle {
  constructor({ baseUrl, token }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
  }

  async call(wsfunction, params = {}) {
    const body = flatten(params);
    body.set('wstoken', this.token);
    body.set('wsfunction', wsfunction);
    body.set('moodlewsrestformat', 'json');
    const data = await postForm(`${this.baseUrl}/webservice/rest/server.php`, body);
    if (data && typeof data === 'object' && !Array.isArray(data) && data.exception) {
      throw new MoodleError(data.message || data.exception, data.errorcode || data.exception);
    }
    return data;
  }
}
