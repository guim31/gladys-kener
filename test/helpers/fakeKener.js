// -----------------------------------------------------------------------------
// An in-memory Kener: its monitors, data points and incidents rendered like
// the API v4 (checked against the real answers of test/fixtures/kener in
// test/client.test.js): one point per minute, timestamps in seconds, the
// `[start_ts, end_ts)` window, the incidents newest first, and the bearer API
// key.
// -----------------------------------------------------------------------------

export const BASE = 'http://192.0.2.10:3000';
export const API_KEY = 'kener_test_key_0001';

const MINUTE = 60_000;

/** A monitor, with no point until `fill` or `add` gives it some. */
export function monitor(name, tag, fields = {}) {
  return {
    tag,
    name,
    category_name: 'Home',
    status: 'ACTIVE',
    is_hidden: 'NO',
    monitor_type: 'API',
    monitor_settings_json: {
      uptime_formula_numerator: 'up + maintenance + degraded',
      uptime_formula_denominator: 'up + down + degraded + maintenance',
    },
    points: [],
    ...fields,
  };
}

export function incident(id, title, fields = {}) {
  return {
    id,
    title,
    start_date_time: 1_792_000_000,
    end_date_time: null,
    state: 'INVESTIGATING',
    incident_source: 'API',
    monitors: [],
    url: `http://192.0.2.10:3000/incidents/${id}`,
    ...fields,
  };
}

export class FakeKener {
  /** @param {{ now: () => number, monitors?: object[], incidents?: object[] }} options */
  constructor({ now, monitors, incidents } = {}) {
    this.now = now;
    this.monitors = monitors ?? [
      monitor('Website', 'website'),
      monitor('API', 'api', { category_name: 'Backend' }),
      monitor('NAS', 'nas'),
    ];
    this.incidents = incidents ?? [];
    /** 'down': the server does not answer; a number: that HTTP status. */
    this.failure = null;
    this.requests = [];
    for (const item of this.monitors) {
      if (item.points.length === 0) {
        this.fill(item.tag, 'UP', 60);
      }
    }
  }

  get(name) {
    return this.monitors.find((item) => item.name === name);
  }

  /** `count` points of `status`, one per minute, up to the current minute. */
  fill(tag, status, count, latency = 42) {
    const item = this.monitors.find((m) => m.tag === tag);
    const last = Math.floor(this.now() / MINUTE) * MINUTE;
    for (let i = count - 1; i >= 0; i -= 1) {
      this.write(item, last - i * MINUTE, status, latency);
    }
  }

  /** One point of `status` at the current minute (by name). */
  add(name, status, latency = 42) {
    this.write(this.get(name), Math.floor(this.now() / MINUTE) * MINUTE, status, latency);
  }

  write(item, time, status, latency) {
    item.points = item.points.filter((point) => point.time !== time);
    item.points.push({ time, status, latency });
    item.points.sort((a, b) => a.time - b.time);
  }

  render(item) {
    const { points: _points, ...out } = item;
    return { id: this.monitors.indexOf(item) + 1, ...out, type_data: { url: '********' } };
  }

  /** The request seam of src/kener/client.js. */
  request = async (url, { method = 'GET', headers = {} } = {}) => {
    this.requests.push({ url, method, headers });
    if (this.failure === 'down') {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    }
    if (typeof this.failure === 'number') {
      return { status: this.failure, body: '' };
    }
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (headers.authorization !== `Bearer ${API_KEY}`) {
      return {
        status: 401,
        body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } }),
      };
    }
    if (path === '/api/v4/monitors') {
      return {
        status: 200,
        body: JSON.stringify({ monitors: this.monitors.map((item) => this.render(item)) }),
      };
    }
    const data = path.match(/^\/api\/v4\/monitors\/([^/]+)\/data$/);
    if (data) {
      const item = this.monitors.find((m) => m.tag === decodeURIComponent(data[1]));
      if (!item) {
        return { status: 404, body: '{"error":{"code":"NOT_FOUND"}}' };
      }
      const start = Number(parsed.searchParams.get('start_ts')) * 1000;
      const end = Number(parsed.searchParams.get('end_ts')) * 1000;
      const points = item.points
        .filter((point) => point.time >= start && point.time < end)
        .map((point) => ({
          monitor_tag: item.tag,
          timestamp: point.time / 1000,
          status: point.status,
          latency: point.latency,
          type: 'REALTIME',
        }));
      return { status: 200, body: JSON.stringify({ data: points }) };
    }
    if (path === '/api/v4/incidents') {
      const incidents = [...this.incidents].sort((a, b) => b.id - a.id);
      return { status: 200, body: JSON.stringify({ incidents }) };
    }
    return { status: 404, body: '{"error":{"code":"NOT_FOUND"}}' };
  };
}
