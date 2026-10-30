// -----------------------------------------------------------------------------
// The hub against the SDK's fake Gladys and a fake Kener: discovery, states,
// transitions and scene events, incidents, persistence across restarts,
// errors, scene actions, the widget, quiet logs, and the reading timer of the
// container.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { FEATURE_KEYS, INSTANCE_KEYS, instanceIds } from '../src/devices.js';
import { TRIGGERS, WIDGET_KEY } from '../src/hub.js';
import {
  API_KEY,
  BASE,
  FakeKener,
  createClock,
  createDevices,
  createWorld,
  idsOf,
  incident,
  monitor,
} from './helpers/world.js';

const events = (world, key) => world.fake.sceneEvents.filter((event) => event.key === key);
const MINUTE = 60_000;

/** One minute later, a point of `status` for each name given, then a read. */
async function step(world, points = {}) {
  world.clock.advance(MINUTE);
  for (const item of world.kener.monitors) {
    world.kener.add(item.name, points[item.name] ?? item.points.at(-1)?.status ?? 'UP');
  }
  await world.hub.pollNow();
}

async function captureLogs(t, level, fn) {
  const lines = [];
  const write = (chunk) => {
    lines.push(...String(chunk).split('\n').filter(Boolean));
    return true;
  };
  const before = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  const stdout = t.mock.method(process.stdout, 'write', write);
  const stderr = t.mock.method(process.stderr, 'write', write);
  try {
    await fn();
  } finally {
    stdout.mock.restore();
    stderr.mock.restore();
    process.env.LOG_LEVEL = before;
  }
  return lines;
}

async function widget(world, settings = {}, language = 'en') {
  const ack = await world.fake.widgetGet(WIDGET_KEY, { settings, language });
  assert.equal(ack.success, true, ack.error);
  validateWidgetContent(ack.data.content);
  return ack.data.content;
}

test('one device per monitor and one for the instance, proposed in Discovery, nothing polled by Gladys', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const devices = world.fake.discoveredDevices;
  assert.deepEqual(
    devices.map((d) => d.name),
    ['Kener', 'Website', 'API', 'NAS'],
  );
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
  }
  assert.deepEqual(devices[2].params, [
    { name: 'KENER_TAG', value: 'api' },
    { name: 'KENER_CATEGORY', value: 'Backend' },
  ]);
  assert.equal(world.fake.states.length, 0, 'nothing for devices not added');
  assert.equal(world.fake.connectionStatus.connected, true);
});

test('paused and hidden monitors are left out; hidden ones come with the option', async (t) => {
  const clock = createClock();
  const kener = new FakeKener({
    now: clock.now,
    monitors: [
      monitor('Website', 'website'),
      monitor('Old', 'old', { status: 'INACTIVE' }),
      monitor('Secret', 'secret', { is_hidden: 'YES' }),
    ],
  });
  const world = await createWorld({ clock, kener });
  t.after(() => world.app.stop());
  assert.deepEqual(
    world.fake.discoveredDevices.map((d) => d.name),
    ['Kener', 'Website'],
  );
  await world.fake.configUpdated({ url: BASE, api_key: API_KEY, include_hidden: true });
  assert.deepEqual(
    world.fake.discoveredDevices.map((d) => d.name),
    ['Kener', 'Website', 'Secret'],
  );
});

test('the states of an added device, at once, then only the changes', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const ids = idsOf(world, 'Website');
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.ONLINE)), 1);
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.DEGRADED)), 0);
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.RESPONSE_TIME)), 42);
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.UPTIME_24H)), 100);
  const instance = instanceIds(world.gladys);
  assert.equal(world.fake.lastState(instance.feature(INSTANCE_KEYS.DOWN)), 0);
  assert.equal(world.fake.lastState(instance.feature(INSTANCE_KEYS.DEGRADED)), 0);
  assert.equal(world.fake.lastState(instance.feature(INSTANCE_KEYS.INCIDENTS)), 0);
  // 192.0.2.10 is not a private address: a public status page.
  assert.deepEqual([...new Set(world.fake.transports.map((e) => e.transport))], ['cloud']);

  const before = world.fake.states.length;
  await world.hub.pollNow();
  assert.equal(world.fake.states.length, before, 'nothing changed, nothing sent');
});

test('a Kener on the home network gets the local badge', async (t) => {
  const clock = createClock();
  const kener = new FakeKener({ now: clock.now });
  const request = (url, options) =>
    kener.request(url.replace('http://192.168.1.2:3000', BASE), options);
  const world = await createWorld({
    clock,
    kener: { ...kener, request, get: (name) => kener.get(name), monitors: kener.monitors },
    config: { url: 'http://192.168.1.2:3000', api_key: API_KEY, language: 'en' },
  });
  t.after(() => world.app.stop());
  await createDevices(world);
  assert.deepEqual([...new Set(world.fake.transports.map((e) => e.transport))], ['local']);
});

test('degraded: online stays 1, degraded goes 1, no scene event', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  await step(world, { API: 'DEGRADED' });
  const ids = idsOf(world, 'API');
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.ONLINE)), 1);
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.DEGRADED)), 1);
  assert.equal(world.fake.lastState(instanceIds(world.gladys).feature(INSTANCE_KEYS.DEGRADED)), 1);
  assert.deepEqual(world.fake.sceneEvents, []);
});

test('the response time goes at most every 5 minutes, a change of state at once', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const ids = idsOf(world, 'API');
  world.clock.advance(MINUTE);
  world.kener.add('API', 'UP', 90);
  await world.hub.pollNow();
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.RESPONSE_TIME)), 42);
  world.clock.advance(4 * MINUTE);
  world.kener.add('API', 'UP', 90);
  await world.hub.pollNow();
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.RESPONSE_TIME)), 90);
  await step(world, { API: 'DOWN' });
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.ONLINE)), 0);
  assert.equal(world.fake.lastState(instanceIds(world.gladys).feature(INSTANCE_KEYS.DOWN)), 1);
  // A down check measures nothing: the last response time stays.
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.RESPONSE_TIME)), 90);
});

test('a hundred monitors read every minute stay under 300 states per minute', async (t) => {
  const clock = createClock();
  const monitors = Array.from({ length: 100 }, (_, i) => monitor(`Service ${i}`, `service-${i}`));
  const kener = new FakeKener({ now: clock.now, monitors });
  const world = await createWorld({ clock, kener });
  t.after(() => world.app.stop());
  await createDevices(world);
  let worst = 0;
  for (let i = 1; i <= 30; i += 1) {
    world.clock.advance(MINUTE);
    for (const item of monitors) {
      world.kener.add(item.name, i % 7 === 0 ? 'DEGRADED' : 'UP', (i % 9) * 10 + 5);
    }
    const before = world.fake.states.length;
    await world.hub.pollNow();
    worst = Math.max(worst, world.fake.states.length - before);
  }
  assert.ok(worst < 300, `${worst} states in a minute`);
});

test('the second read asks Kener for the last minutes only', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const data = (request) => new URL(request.url).searchParams;
  const first = world.kener.requests.find((r) => r.url.includes('/website/data'));
  const span = (r) => Number(data(r).get('end_ts')) - Number(data(r).get('start_ts'));
  assert.ok(span(first) >= 24 * 3600, '24 hours at first');
  world.kener.requests.length = 0;
  await step(world);
  const next = world.kener.requests.find((r) => r.url.includes('/website/data'));
  assert.ok(span(next) <= 10 * 60, `${span(next)} s the next time`);
});

test('"a monitor goes down", "is back online" with the outage, for any monitor', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await step(world, { NAS: 'DOWN' });
  for (let i = 0; i < 29; i += 1) {
    await step(world);
  }
  await step(world, { NAS: 'DEGRADED' });
  const device = idsOf(world, 'NAS').device;
  assert.deepEqual(
    world.fake.sceneEvents.map((event) => [event.key, event.data.device, event.data.monitor]),
    [
      [TRIGGERS.DOWN, device, 'NAS'],
      [TRIGGERS.UP, device, 'NAS'],
    ],
  );
  assert.equal(events(world, TRIGGERS.DOWN)[0].data.category, 'Home');
  assert.equal(
    events(world, TRIGGERS.UP)[0].data.downtime_minutes,
    31,
    'from the first DOWN point (10:01) to 10:31:30',
  );
});

test('no event at the first read, nor for a monitor without data', async (t) => {
  const clock = createClock();
  const kener = new FakeKener({
    now: clock.now,
    monitors: [monitor('NAS', 'nas'), monitor('New', 'new')],
  });
  kener.fill('nas', 'DOWN', 3);
  kener.get('New').points = [];
  const world = await createWorld({ clock, kener });
  t.after(() => world.app.stop());
  await createDevices(world);
  assert.deepEqual(world.fake.sceneEvents, []);
  const ids = idsOf(world, 'New');
  assert.equal(world.fake.lastState(ids.feature(FEATURE_KEYS.ONLINE)), undefined);
});

test('a monitor that went down during a restart is announced once, the outage counted from before', async (t) => {
  const clock = createClock();
  const kener = new FakeKener({ now: clock.now });
  const first = await createWorld({ clock, kener });
  await first.app.stop();
  clock.advance(10 * MINUTE);
  kener.fill('nas', 'DOWN', 5);
  const second = await createWorld({ clock, kener, dataDir: first.dataDir });
  t.after(() => second.app.stop());
  assert.deepEqual(
    second.fake.sceneEvents.map((e) => e.key),
    [TRIGGERS.DOWN],
  );
  await second.app.stop();
  clock.advance(20 * MINUTE);
  kener.fill('nas', 'UP', 1);
  const third = await createWorld({ clock, kener, dataDir: first.dataDir });
  t.after(() => third.app.stop());
  const up = events(third, TRIGGERS.UP);
  assert.equal(up.length, 1);
  assert.equal(up[0].data.downtime_minutes, 25, 'from the first DOWN point (10:06)');
  assert.deepEqual(events(third, TRIGGERS.DOWN), []);
});

test('"a new incident is opened": once, with its monitors; none at first read nor when resolved', async (t) => {
  const clock = createClock();
  const kener = new FakeKener({ now: clock.now, incidents: [incident(1, 'Old outage')] });
  const world = await createWorld({ clock, kener });
  t.after(() => world.app.stop());
  assert.deepEqual(events(world, TRIGGERS.INCIDENT), [], 'existing incidents are not new');
  kener.incidents.push(
    incident(2, 'NAS unreachable', { monitors: [{ monitor_tag: 'nas', impact: 'DOWN' }] }),
    incident(3, 'Already over', { state: 'RESOLVED' }),
  );
  await step(world);
  await step(world);
  const opened = events(world, TRIGGERS.INCIDENT);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0].data, {
    title: 'NAS unreachable',
    monitors: 'NAS',
    url: 'http://192.0.2.10:3000/incidents/2',
  });
  assert.equal(world.hub.incidents.length, 2, 'the two open incidents');
});

test('another Kener address: the states saved for the previous one are dropped', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  assert.ok(Object.keys(world.hub.saved.monitors).length > 0);
  world.kener.failure = 'down';
  await world.fake.configUpdated({ url: 'http://192.0.2.20:3000', api_key: API_KEY });
  assert.deepEqual(world.hub.saved.monitors, {});
});

test('Kener unreachable: status, badges, one warning, no monitor event', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  world.kener.failure = 'down';
  const lines = await captureLogs(t, 'info', async () => {
    await world.hub.pollNow();
    await world.hub.pollNow();
    await world.hub.pollNow();
  });
  assert.equal(lines.length, 1, 'one line for an outage, not one per read');
  assert.equal(world.fake.connectionStatus.connected, false);
  assert.deepEqual(world.fake.connectionStatus.message, {
    en: 'Kener does not answer',
    fr: 'Kener ne répond pas',
    de: 'Kener antwortet nicht',
    es: 'Kener no responde',
  });
  assert.equal(world.fake.transports.at(-1).transport, 'unreachable');
  assert.deepEqual(world.fake.sceneEvents, []);
  world.kener.failure = null;
  await world.hub.pollNow();
  assert.equal(world.fake.connectionStatus.connected, true);
  assert.equal(world.fake.transports.at(-1).transport, 'cloud');
});

test('API key: missing or refused is reported, never logged', async (t) => {
  const missing = await createWorld({ config: { url: BASE } });
  t.after(() => missing.app.stop());
  assert.match(missing.fake.connectionStatus.message.fr, /clé d'API/);
  let lines;
  const refused = await createWorld({ connect: false, config: { url: BASE, api_key: 'nope-key' } });
  t.after(() => refused.app.stop());
  lines = await captureLogs(t, 'debug', async () => {
    await refused.gladys.connect();
    await refused.app.ready;
  });
  assert.match(refused.fake.connectionStatus.message.en, /API key refused/);
  assert.ok(!lines.some((line) => line.includes('nope-key')), 'the key never in the logs');
});

test('"State of a monitor" and "Status page summary", in the language of the configuration', async (t) => {
  const clock = createClock();
  const kener = new FakeKener({
    now: clock.now,
    incidents: [incident(4, 'Backend slow', { monitors: [{ monitor_tag: 'api' }] })],
  });
  kener.fill('nas', 'DOWN', 6);
  kener.fill('api', 'DEGRADED', 1, 300);
  const world = await createWorld({
    clock,
    kener,
    config: { url: BASE, api_key: API_KEY, language: 'fr' },
  });
  t.after(() => world.app.stop());
  await createDevices(world);
  const nas = await world.fake.sceneAction('get_monitor_status', {
    device: idsOf(world, 'NAS').device,
  });
  assert.equal(nas.success, true, nas.error);
  assert.equal(nas.data.outputs.online, false);
  assert.equal(nas.data.outputs.sentence, 'NAS : En panne, 90 % sur 24 h.');
  const api = await world.fake.sceneAction('get_monitor_status', {
    device: idsOf(world, 'API').device,
  });
  assert.deepEqual(
    [
      api.data.outputs.online,
      api.data.outputs.degraded,
      api.data.outputs.response_time,
      api.data.outputs.category,
    ],
    [true, true, 300, 'Backend'],
  );
  const summary = await world.fake.sceneAction('get_status_summary', {});
  assert.deepEqual(summary.data.outputs, {
    down: 1,
    degraded: 1,
    total: 3,
    down_names: 'NAS',
    incidents: 1,
    incident_titles: 'Backend slow',
    sentence: 'En panne : NAS. Dégradés : API. Incidents en cours : Backend slow.',
  });
  const home = await world.fake.sceneAction('get_status_summary', { category: 'home' });
  assert.deepEqual([home.data.outputs.total, home.data.outputs.incidents], [2, 0]);
  const unknown = await world.fake.sceneAction('get_monitor_status', { device: 'nope' });
  assert.equal(unknown.success, false);
});

test('the widget: incidents and monitors down first, Gladys names, settings to hide', async (t) => {
  const clock = createClock();
  const kener = new FakeKener({ now: clock.now, incidents: [incident(1, 'NAS unreachable')] });
  kener.fill('nas', 'DOWN', 1);
  const world = await createWorld({ clock, kener });
  t.after(() => world.app.stop());
  await createDevices(world);
  const website = world.gladys.devices.find(
    (d) => d.external_id === idsOf(world, 'Website').device,
  );
  website.name = 'Blog';
  const content = await widget(world);
  const tiles = content.components.filter((c) => c.type === 'value');
  assert.deepEqual(
    tiles.map((c) => [c.label, c.value]),
    [
      ['Down', 1],
      ['Degraded', 0],
      ['Incidents', 1],
      ['Uptime 24 h', 99.44],
    ],
  );
  const rows = content.components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((row) => row.label),
    ['NAS unreachable', 'NAS', 'API', 'Blog'],
  );
  assert.equal(rows[0].value, 'Investigating');
  assert.equal(content.components.at(-1).type, 'button');
  const quiet = await widget(world, { show_incidents: false, show_refresh: false });
  assert.deepEqual(
    quiet.components.find((c) => c.type === 'status').items.map((row) => row.label),
    ['NAS', 'API', 'Blog'],
  );
  assert.ok(!quiet.components.some((c) => c.type === 'button'));
  const backend = await widget(world, { category: 'backend' });
  assert.equal(backend.components.find((c) => c.label === 'Incidents').value, 0);
  const ack = await world.fake.widgetAction(WIDGET_KEY, 'refresh');
  assert.equal(ack.success, true, ack.error);
});

test('the widget folds more than ten monitors into one row per category', async (t) => {
  const clock = createClock();
  const monitors = Array.from({ length: 14 }, (_, i) =>
    monitor(`Service ${i}`, `service-${i}`, { category_name: i < 7 ? 'Web' : 'Lab' }),
  );
  const kener = new FakeKener({ now: clock.now, monitors });
  kener.fill('service-9', 'DOWN', 1);
  const world = await createWorld({ clock, kener });
  t.after(() => world.app.stop());
  const content = await widget(world, {}, 'fr');
  const rows = content.components.find((c) => c.type === 'status').items;
  assert.deepEqual(
    rows.map((row) => [row.label, row.value]),
    [
      ['Lab', 'En panne : 1 / 7'],
      ['Web', 'En ligne : 7 / 7'],
    ],
  );
});

test('the widget says what to do without address or key, and when Kener does not answer', async (t) => {
  const empty = await createWorld({ config: {} });
  t.after(() => empty.app.stop());
  const first = await widget(empty);
  assert.match(first.components[0].text, /address of your Kener/);
  const world = await createWorld();
  t.after(() => world.app.stop());
  world.kener.failure = 'down';
  await world.hub.pollNow();
  const content = await widget(world);
  assert.ok(
    content.components.some((c) => c.type === 'text' && c.text === 'Kener does not answer'),
  );
  assert.ok(content.components.length <= 8);
});

test('a device added later gets its states at once, and the widget refreshes', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  const refreshes = world.fake.widgetRefreshes?.length ?? 0;
  await createDevices(world, (d) => d.name === 'NAS');
  assert.equal(world.fake.lastState(idsOf(world, 'NAS').feature(FEATURE_KEYS.ONLINE)), 1);
  if (world.fake.widgetRefreshes) {
    assert.ok(world.fake.widgetRefreshes.length > refreshes);
  }
});

test('Gladys restarted: everything is sent again', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const before = world.fake.states.length;
  await world.hub.resync(world.hub.config);
  assert.ok(world.fake.states.length > before);
});

test('"Test the connection" reads Kener and reports in the four languages', async (t) => {
  const clock = createClock();
  const kener = new FakeKener({ now: clock.now, incidents: [incident(1, 'Outage')] });
  kener.fill('nas', 'DOWN', 1);
  const world = await createWorld({ clock, kener });
  t.after(() => world.app.stop());
  const ack = await world.fake.action('test_connection');
  assert.equal(ack.success, true, ack.error);
  assert.equal(
    ack.data.message.en,
    'Kener: Connected, 3 monitor(s), 1 down, 1 incident(s) in progress',
  );
  assert.equal(
    ack.data.message.fr,
    'Kener : Connecté, 3 moniteur(s), 1 en panne, 1 incident(s) en cours',
  );
  world.kener.failure = 404;
  const refused = await world.fake.action('test_connection');
  assert.match(refused.data.message.de, /kein Kener 4/);
});

test('a normal reading cycle writes nothing at the info level', async (t) => {
  const world = await createWorld();
  t.after(() => world.app.stop());
  await createDevices(world);
  const sent = world.fake.states.length;
  const lines = await captureLogs(t, 'info', async () => {
    for (let cycle = 0; cycle < 6; cycle += 1) {
      world.clock.advance(5 * MINUTE);
      world.kener.add('API', 'UP', 50 + cycle);
      await world.hub.pollNow();
    }
  });
  assert.ok(world.fake.states.length > sent, 'states were published');
  assert.deepEqual(lines, []);
});

test('the internal timer reads Kener and publishes the changes, without any poll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const world = await createWorld({ timers: true });
  t.after(() => world.app.stop());
  await createDevices(world);
  const reads = world.kener.requests.length;
  world.clock.advance(MINUTE);
  world.kener.add('NAS', 'DOWN');
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 40; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(world.kener.requests.length > reads);
  assert.equal(world.fake.lastState(idsOf(world, 'NAS').feature('online')), 0);
});
