// -----------------------------------------------------------------------------
// Kener client: the REST API v4 of the Kener status page (MIT,
// https://github.com/rajnandan1/kener), checked against Kener 4.1 in Docker
// (test/fixtures/kener). Every route asks for `Authorization: Bearer <API key>`
// (Manage → API Keys):
//
//   GET /api/v4/monitors
//       every monitor: `tag`, `name`, `category_name`, `status` (ACTIVE when
//       Kener checks it), `is_hidden`, `monitor_settings_json` (the formula of
//       its uptime). Secrets of `type_data` come masked; never read here.
//   GET /api/v4/monitors/{tag}/data?start_ts=…&end_ts=…
//       one point per check in [start_ts, end_ts), seconds, minute-aligned:
//       `status` UP | DOWN | DEGRADED, `latency` in milliseconds
//   GET /api/v4/incidents
//       the 1000 newest incidents: `id`, `title`, `start_date_time`,
//       `end_date_time` (seconds, null while open), `state`
//       (INVESTIGATING | IDENTIFIED | MONITORING | RESOLVED), `monitors`
//       (`monitor_tag`, `impact`), `url` of the public page
//
// Kener 3 has no v4 API (404): reported as "not Kener 4". Redirects are not
// followed: the API key would go wherever the address points.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';

export const ERROR_KINDS = Object.freeze({
  UNREACHABLE: 'unreachable', // no answer: down, wrong address, firewall
  TLS: 'tls', // the certificate does not verify
  AUTH: 'auth', // the API key is missing, wrong or disabled
  NOT_KENER: 'not_kener', // something answers, not the API v4 of Kener
  REDIRECT: 'redirect', // the address redirects (usually HTTP to HTTPS)
  HTTP: 'http', // any other HTTP error
});

export class KenerError extends Error {
  /**
   * @param {string} kind one of ERROR_KINDS
   * @param {string} message English, for the logs (never contains a secret)
   * @param {object} [extra] { status }
   */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'KenerError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

// The states of a data point, as Kener writes them.
export const STATUSES = Object.freeze({ UP: 'UP', DOWN: 'DOWN', DEGRADED: 'DEGRADED' });

/**
 * The one function that talks to the network (fetch). The client takes it as
 * a parameter: the tests replace it with an in-memory Kener
 * (test/helpers/fakeKener.js).
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function httpRequest(url, { method = 'GET', headers = {}, timeoutMs = 10_000 } = {}) {
  const response = await fetch(url, {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new Error('Response too large');
  }
  const body = await response.text();
  if (body.length > MAX_BODY_BYTES) {
    throw new Error('Response too large');
  }
  return { status: response.status, body };
}

/**
 * The platform id of a monitor: its Kener tag when it is a plain identifier
 * (Kener 4 only accepts `[a-z0-9_-]`), a hash of it otherwise (tags created
 * by older versions). A hash starts with `h-` and holds 20 hex digits; a tag
 * of that very shape is hashed as well, so they cannot collide.
 */
export function platformIdOf(tag) {
  return /^[a-z0-9][a-z0-9_-]{0,119}$/.test(tag) && !/^h-[0-9a-f]{20}$/.test(tag)
    ? tag
    : `h-${createHash('sha1').update(tag).digest('hex').slice(0, 20)}`;
}

const clean = (value, max) =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

const seconds = (value) => (Number.isFinite(value) && value > 0 ? value * 1000 : null);

const VARIABLES = ['up', 'down', 'degraded', 'maintenance'];

/**
 * A Kener uptime formula (`up + maintenance + degraded`) as the list of the
 * states it adds up; null when it is anything else than a plain sum (Kener
 * accepts arithmetic, rare: the default formula is used then).
 */
export function parseFormula(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const terms = text
    .toLowerCase()
    .split('+')
    .map((term) => term.trim());
  return terms.length > 0 && terms.every((term) => VARIABLES.includes(term))
    ? [...new Set(terms)]
    : null;
}

// Kener's default: degraded counts as available.
export const DEFAULT_FORMULA = Object.freeze({
  numerator: ['up', 'maintenance', 'degraded'],
  denominator: ['up', 'down', 'degraded', 'maintenance'],
});

/** One monitor of the API, normalized; null when it cannot be identified. */
export function normalizeMonitor(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.tag !== 'string' || !raw.tag.trim()) {
    return null;
  }
  const tag = raw.tag.trim();
  const settings = raw.monitor_settings_json && typeof raw.monitor_settings_json === 'object';
  const numerator = settings
    ? parseFormula(raw.monitor_settings_json.uptime_formula_numerator)
    : null;
  const denominator = settings
    ? parseFormula(raw.monitor_settings_json.uptime_formula_denominator)
    : null;
  return {
    tag,
    id: platformIdOf(tag),
    name: clean(raw.name, 255) || tag,
    category: clean(raw.category_name, 255),
    // A paused monitor (INACTIVE) is not checked any more.
    active: raw.status === undefined || raw.status === 'ACTIVE',
    hidden: raw.is_hidden === 'YES',
    formula: numerator && denominator ? { numerator, denominator } : DEFAULT_FORMULA,
  };
}

/** One data point, normalized; null when it has no known state. */
export function normalizePoint(raw) {
  if (!raw || typeof raw !== 'object' || !Object.values(STATUSES).includes(raw.status)) {
    return null;
  }
  const time = seconds(raw.timestamp);
  if (time === null) {
    return null;
  }
  return {
    time,
    status: raw.status,
    latencyMs: Number.isFinite(raw.latency) && raw.latency >= 0 ? Math.round(raw.latency) : null,
  };
}

/** One incident, normalized; null when it cannot be identified. */
export function normalizeIncident(raw) {
  if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.id)) {
    return null;
  }
  return {
    id: raw.id,
    title: clean(raw.title, 255) || `#${raw.id}`,
    start: seconds(raw.start_date_time),
    end: seconds(raw.end_date_time),
    state: clean(raw.state, 40).toUpperCase(),
    monitors: (Array.isArray(raw.monitors) ? raw.monitors : [])
      .filter((item) => item && typeof item.monitor_tag === 'string')
      .map((item) => ({ tag: item.monitor_tag, impact: clean(item.impact, 20) || 'DOWN' })),
    url: typeof raw.url === 'string' && /^https?:\/\//.test(raw.url) ? raw.url.slice(0, 500) : '',
  };
}

/**
 * Is an incident in progress at `now`? As Kener's status page tells it:
 * started, not ended yet; and not marked resolved.
 */
export function isOngoing(incident, now) {
  return (
    incident.state !== 'RESOLVED' &&
    (incident.start === null || incident.start <= now) &&
    (incident.end === null || incident.end >= now)
  );
}

export class KenerClient {
  /**
   * @param {object} options
   * @param {string} options.url base URL, `http(s)://host[:port][/path]`
   * @param {string} options.apiKey the Kener API key
   * @param {typeof httpRequest} [options.request] test seam
   * @param {number} [options.timeoutMs]
   */
  constructor({ url, apiKey, request = httpRequest, timeoutMs = 10_000 }) {
    this.url = url;
    this.apiKey = apiKey;
    this.request = request;
    this.timeoutMs = timeoutMs;
  }

  async get(path) {
    let response;
    try {
      response = await this.request(`${this.url}/api/v4${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${this.apiKey}` },
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      const code = err.cause?.code ?? err.code;
      if (TLS_CODES.has(code)) {
        throw new KenerError(ERROR_KINDS.TLS, `Certificate refused (${code})`);
      }
      throw new KenerError(ERROR_KINDS.UNREACHABLE, code ?? err.name ?? err.message);
    }
    const { status } = response;
    if (status === 401 || status === 403) {
      throw new KenerError(ERROR_KINDS.AUTH, `API key refused (HTTP ${status})`, { status });
    }
    if (status >= 300 && status < 400) {
      throw new KenerError(ERROR_KINDS.REDIRECT, `Redirected (HTTP ${status})`, { status });
    }
    if (status === 404) {
      throw new KenerError(ERROR_KINDS.NOT_KENER, 'No Kener 4 API at this address (HTTP 404)', {
        status,
      });
    }
    if (status < 200 || status >= 300) {
      throw new KenerError(ERROR_KINDS.HTTP, `Unexpected answer (HTTP ${status})`, { status });
    }
    try {
      return JSON.parse(response.body);
    } catch {
      throw new KenerError(ERROR_KINDS.NOT_KENER, 'The answer is not JSON');
    }
  }

  /**
   * Every monitor, paused ones included (`active: false`).
   * @returns {Promise<object[]>}
   * @throws {KenerError}
   */
  async monitors() {
    const data = await this.get('/monitors');
    if (!Array.isArray(data?.monitors)) {
      throw new KenerError(ERROR_KINDS.NOT_KENER, 'The answer is not a Kener monitor list');
    }
    return data.monitors.map(normalizeMonitor).filter(Boolean);
  }

  /**
   * The data points of a monitor in [startMs, endMs), oldest first.
   * @returns {Promise<object[]>}
   * @throws {KenerError}
   */
  async data(tag, startMs, endMs) {
    const query = new URLSearchParams({
      start_ts: String(Math.floor(startMs / 1000)),
      end_ts: String(Math.floor(endMs / 1000)),
    });
    const data = await this.get(`/monitors/${encodeURIComponent(tag)}/data?${query}`);
    if (!Array.isArray(data?.data)) {
      throw new KenerError(ERROR_KINDS.NOT_KENER, 'The answer is not a Kener data list');
    }
    return data.data
      .map(normalizePoint)
      .filter(Boolean)
      .sort((a, b) => a.time - b.time);
  }

  /**
   * The newest incidents (1000 at most, the newest first).
   * @returns {Promise<object[]>}
   * @throws {KenerError}
   */
  async incidents() {
    const data = await this.get('/incidents');
    if (!Array.isArray(data?.incidents)) {
      throw new KenerError(ERROR_KINDS.NOT_KENER, 'The answer is not a Kener incident list');
    }
    return data.incidents.map(normalizeIncident).filter(Boolean);
  }
}
