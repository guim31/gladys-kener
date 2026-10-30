// -----------------------------------------------------------------------------
// The Kener client and the configuration, against the real answers of Kener
// 4.1 recorded in Docker (test/fixtures/kener) and the fake Kener of the other
// tests, checked to answer the same way.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_FORMULA,
  ERROR_KINDS,
  KenerClient,
  isOngoing,
  normalizeIncident,
  normalizeMonitor,
  parseFormula,
  platformIdOf,
} from '../src/kener/client.js';
import { isLocalAddress, normalizeConfig, parseServerUrl } from '../src/config.js';
import { downSince, mergePoints, stateFrom, uptimeOf } from '../src/hub.js';
import { API_KEY, BASE, FakeKener } from './helpers/fakeKener.js';

const fixture = async (name) =>
  readFile(new URL(`./fixtures/kener/${name}.json`, import.meta.url), 'utf8');

/** A client answering the recorded body, whatever the path. */
const recorded = (body, status = 200) => {
  const calls = [];
  const client = new KenerClient({
    url: BASE,
    apiKey: API_KEY,
    request: async (url, options) => {
      calls.push({ url, options });
      return { status, body };
    },
  });
  return { client, calls };
};

test('the monitors of a real Kener: tag, name, category, active, formula', async () => {
  const { client, calls } = recorded(await fixture('monitors'));
  const monitors = await client.monitors();
  assert.equal(calls[0].url, `${BASE}/api/v4/monitors`);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(
    monitors.map((m) => [m.tag, m.name, m.category, m.active, m.hidden]),
    [
      ['api-slow', 'API', 'Backend', true, false],
      ['nas-down', 'NAS', 'Home', true, false],
      ['web-up', 'Website', 'Home', true, false],
      ['kener', 'Kener.ing', 'Home', true, false],
      ['earth', 'Earth - Planet 3', 'Home', true, false],
    ],
  );
  // The seeded monitors count degraded as down; the new ones, as up.
  assert.deepEqual(monitors[3].formula, {
    numerator: ['up', 'maintenance'],
    denominator: ['up', 'maintenance', 'down', 'degraded'],
  });
  assert.deepEqual(monitors[0].formula, DEFAULT_FORMULA);
});

test('the points of a real Kener: seconds to milliseconds, oldest first', async () => {
  const { client, calls } = recorded(await fixture('data-nas-down'));
  const points = await client.data('nas-down', 1_793_380_800_000, 1_793_381_100_000);
  assert.match(
    calls[0].url,
    /\/api\/v4\/monitors\/nas-down\/data\?start_ts=1793380800&end_ts=1793381100$/,
  );
  assert.deepEqual(points.slice(0, 2), [
    { time: 1_793_380_920_000, status: 'DOWN', latencyMs: 31 },
    { time: 1_793_380_980_000, status: 'DOWN', latencyMs: 79 },
  ]);
  assert.ok(points.every((p, i) => i === 0 || p.time - points[i - 1].time === 60_000));
  assert.equal(stateFrom(points), 'down');
  // The real "Website": its first check timed out (DOWN) while Kener started,
  // then UP, then DEGRADED (slow answers); the "API" monitor is DEGRADED only.
  const web = await recorded(await fixture('data-web-up')).client.data('web-up', 0, 1);
  assert.equal(web[0].status, 'DOWN');
  assert.equal(stateFrom(web), 'degraded');
  assert.equal(downSince(web), null);
  const slow = await recorded(await fixture('data-api-slow')).client.data('api-slow', 0, 1);
  assert.ok(slow.length > 0 && slow.every((point) => point.status === 'DEGRADED'));
  assert.equal(uptimeOf(slow, DEFAULT_FORMULA), 100, 'degraded counts as up by default');
});

test('the incidents of a real Kener: the open one is in progress, the ended one is not', async () => {
  const { client } = recorded(await fixture('incidents'));
  const incidents = await client.incidents();
  assert.deepEqual(
    incidents.map((i) => [i.id, i.title, i.state, i.monitors]),
    [
      [2, 'NAS unreachable', 'INVESTIGATING', [{ tag: 'nas-down', impact: 'DOWN' }]],
      [1, 'Old outage', 'INVESTIGATING', [{ tag: 'web-up', impact: 'DEGRADED' }]],
    ],
  );
  const now = 1_793_381_000_000;
  assert.equal(isOngoing(incidents[0], now), true);
  assert.equal(isOngoing(incidents[1], now), false, 'ended an hour ago');
  assert.equal(isOngoing({ ...incidents[0], state: 'RESOLVED' }, now), false);
  assert.equal(isOngoing({ ...incidents[0], start: now + 60_000 }, now), false, 'not started');
  assert.equal(incidents[0].url, 'http://localhost:3000/incidents/2');
});

test('the fake Kener answers like the real one', async () => {
  const shape = (value) =>
    value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).map((key) => [key, typeof value[key]]))
      : typeof value;
  const fake = new FakeKener({ now: () => 1_793_381_000_000 });
  const read = async (path) =>
    JSON.parse(
      (
        await fake.request(`${BASE}${path}`, {
          headers: { authorization: `Bearer ${API_KEY}` },
        })
      ).body,
    );
  const real = JSON.parse(await fixture('data-web-up')).data[0];
  const fakePoint = (await read('/api/v4/monitors/website/data?start_ts=0&end_ts=1793381060'))
    .data[0];
  assert.deepEqual(shape(fakePoint), shape(real));
  const realMonitor = JSON.parse(await fixture('monitors')).monitors[2];
  const fakeMonitor = (await read('/api/v4/monitors')).monitors[0];
  for (const key of [
    'tag',
    'name',
    'category_name',
    'status',
    'is_hidden',
    'monitor_settings_json',
  ]) {
    assert.equal(typeof fakeMonitor[key], typeof realMonitor[key], key);
  }
});

test('errors: unreachable, certificate, key refused, not Kener 4, redirect, other', async () => {
  const kinds = [];
  const cases = [
    async () => {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'ECONNREFUSED' };
      throw error;
    },
    async () => {
      const error = new TypeError('fetch failed');
      error.cause = { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' };
      throw error;
    },
    async () => ({
      status: 401,
      body: '{"error":{"code":"UNAUTHORIZED","message":"Invalid API key"}}',
    }),
    async () => ({ status: 404, body: '<!doctype html>' }),
    async () => ({ status: 200, body: '<!doctype html>' }),
    async () => ({ status: 200, body: '{"status":"ok"}' }),
    async () => ({ status: 301, body: '' }),
    async () => ({ status: 500, body: '' }),
  ];
  for (const request of cases) {
    const client = new KenerClient({ url: BASE, apiKey: 'secret-key-value', request });
    try {
      await client.monitors();
      kinds.push('none');
    } catch (err) {
      assert.ok(!err.message.includes('secret-key-value'), 'never the key in a message');
      kinds.push(err.kind);
    }
  }
  assert.deepEqual(kinds, [
    ERROR_KINDS.UNREACHABLE,
    ERROR_KINDS.TLS,
    ERROR_KINDS.AUTH,
    ERROR_KINDS.NOT_KENER,
    ERROR_KINDS.NOT_KENER,
    ERROR_KINDS.NOT_KENER,
    ERROR_KINDS.REDIRECT,
    ERROR_KINDS.HTTP,
  ]);
});

test('normalization: odd monitors, points and incidents are skipped or repaired', () => {
  assert.equal(normalizeMonitor({ name: 'no tag' }), null);
  assert.equal(normalizeMonitor({ tag: 'paused', status: 'INACTIVE' }).active, false);
  assert.equal(normalizeMonitor({ tag: 'hidden', is_hidden: 'YES' }).hidden, true);
  assert.equal(normalizeMonitor({ tag: 'x' }).name, 'x');
  assert.equal(normalizeIncident({ title: 'no id' }), null);
  assert.equal(normalizeIncident({ id: 3 }).title, '#3');
  assert.equal(normalizeIncident({ id: 3, url: 'javascript:alert(1)' }).url, '');
});

test('uptime formulas: plain sums only, the default otherwise', () => {
  assert.deepEqual(parseFormula('up + maintenance + degraded'), ['up', 'maintenance', 'degraded']);
  assert.deepEqual(parseFormula('UP+DOWN'), ['up', 'down']);
  assert.equal(parseFormula('up * 2'), null);
  assert.equal(parseFormula(''), null);
  assert.deepEqual(
    normalizeMonitor({ tag: 'x', monitor_settings_json: { uptime_formula_numerator: '(up)' } })
      .formula,
    DEFAULT_FORMULA,
  );
});

test('state, outage start, uptime and merge of the points', () => {
  const at = (minute, status) => ({ time: minute * 60_000, status, latencyMs: 10 });
  const points = [at(1, 'UP'), at(2, 'DEGRADED'), at(3, 'DOWN'), at(4, 'DOWN')];
  assert.equal(stateFrom([]), 'unknown');
  assert.equal(stateFrom(points), 'down');
  assert.equal(stateFrom(points.slice(0, 2)), 'degraded');
  assert.equal(downSince(points), 3 * 60_000);
  assert.equal(downSince(points.slice(0, 2)), null);
  assert.equal(uptimeOf(points, DEFAULT_FORMULA), 50);
  assert.equal(
    uptimeOf(points, { numerator: ['up'], denominator: ['up', 'down', 'degraded'] }),
    25,
    'degraded counted as down',
  );
  assert.equal(uptimeOf([], DEFAULT_FORMULA), null);
  const merged = mergePoints(points, [at(4, 'UP'), at(5, 'UP')], 2 * 60_000);
  assert.deepEqual(
    merged.map((p) => [p.time / 60_000, p.status]),
    [
      [2, 'DEGRADED'],
      [3, 'DOWN'],
      [4, 'UP'],
      [5, 'UP'],
    ],
  );
});

test('platform ids: the tag when plain, a hash otherwise', () => {
  assert.equal(platformIdOf('web-up'), 'web-up');
  assert.equal(platformIdOf('my_api'), 'my_api');
  assert.match(platformIdOf('Old Tag'), /^h-[0-9a-f]{20}$/);
  assert.notEqual(platformIdOf('h-0123456789abcdef0123'), 'h-0123456789abcdef0123');
});

test('the address: bare host, copied page, sub-path, refused forms', () => {
  assert.equal(parseServerUrl('192.0.2.10:3000'), 'http://192.0.2.10:3000');
  assert.equal(parseServerUrl('https://status.example.com/'), 'https://status.example.com');
  assert.equal(
    parseServerUrl('https://status.example.com/monitors/web-up'),
    'https://status.example.com',
  );
  assert.equal(
    parseServerUrl('https://example.com/status/manage/app'),
    'https://example.com/status',
  );
  assert.equal(parseServerUrl('https://user:pass@example.com'), null);
  assert.equal(parseServerUrl('ftp://example.com'), null);
  assert.equal(parseServerUrl(''), null);
});

test('the configuration: defaults, trimmed key, choices', () => {
  assert.deepEqual(normalizeConfig({}), {
    url: '',
    apiKey: '',
    pollIntervalMs: 60_000,
    includeHidden: false,
    language: 'fr',
  });
  const config = normalizeConfig({
    url: ' 192.0.2.10:3000 ',
    api_key: ' key \n',
    poll_interval: '300',
    include_hidden: true,
    language: 'de',
  });
  assert.equal(config.url, 'http://192.0.2.10:3000');
  assert.equal(config.apiKey, 'key');
  assert.equal(config.pollIntervalMs, 300_000);
  assert.equal(config.includeHidden, true);
  assert.equal(normalizeConfig({ poll_interval: '5' }).pollIntervalMs, 60_000);
  assert.equal(normalizeConfig({ url: 'ftp://x' }).url, null);
});

test('local or cloud: the badge follows the address', () => {
  for (const url of [
    'http://192.168.1.2:3000',
    'http://10.0.0.5',
    'http://172.20.0.2:3000',
    'http://kener:3000',
    'http://status.local',
    'http://100.101.102.103',
    'http://[fd00::1]:3000',
  ]) {
    assert.equal(isLocalAddress(url), true, url);
  }
  for (const url of [
    'https://status.example.com',
    'http://192.0.2.10:3000',
    'http://[2001:db8::1]',
  ]) {
    assert.equal(isLocalAddress(url), false, url);
  }
});
