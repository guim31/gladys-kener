// -----------------------------------------------------------------------------
// A complete test world: the SDK's fake Gladys, a fake Kener, a temporary
// /data and a manual clock, with the integration wired on top through
// registerHandlers. No timer runs: the tests read Kener with
// `world.hub.pollNow()`. (Adapted from guim31/gladys-gatus.)
// -----------------------------------------------------------------------------

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../../src/app.js';
import { monitorIds } from '../../src/devices.js';
import { platformIdOf } from '../../src/kener/client.js';
import { Store } from '../../src/store.js';
import { API_KEY, BASE, FakeKener, incident, monitor } from './fakeKener.js';

// The integration logs every change; keep the test output readable.
process.env.LOG_LEVEL ??= 'silent';

/** A manual clock, shared by the hub, the fake Kener and the tests. */
export function createClock(start = Date.UTC(2026, 9, 30, 10, 0, 30)) {
  const clock = {
    time: start,
    now: () => clock.time,
    advance(ms) {
      clock.time += ms;
    },
  };
  return clock;
}

export async function createWorld({
  clock = createClock(),
  kener,
  config = { url: BASE, api_key: API_KEY, language: 'en' },
  devices = [],
  connect = true,
  dataDir = mkdtempSync(join(tmpdir(), 'gladys-kener-')),
  timings = {},
  timers = false,
} = {}) {
  const fake = kener ?? new FakeKener({ now: clock.now });
  const gladys = createFakeGladys({ config, devices });
  const app = registerHandlers(gladys, {
    store: new Store(dataDir),
    request: fake.request,
    timers,
    timings,
    now: clock.now,
  });
  if (connect) {
    await gladys.connect();
    await app.ready;
  }
  return { gladys, fake: gladys.fake, kener: fake, app, hub: app.hub, clock, dataDir };
}

/** External ids of the device of a monitor of the fake, by name. */
export const idsOf = (world, name) =>
  monitorIds(world.gladys, platformIdOf(world.kener.get(name).tag));

/** Add discovered devices in Gladys, as the user would (all by default). */
export async function createDevices(world, filter = () => true) {
  for (const device of world.fake.discoveredDevices.filter(filter)) {
    await world.fake.deviceCreated(device);
  }
}

export { API_KEY, BASE, FakeKener, incident, monitor };
