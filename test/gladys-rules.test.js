// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from the real
// answers of Kener 4.1 in Docker (test/fixtures/kener: monitors up, down and
// degraded, one without type, one without any point, incidents), in every
// feature-name language.
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { registerHandlers } from '../src/app.js';
import { Store } from '../src/store.js';

process.env.LOG_LEVEL ??= 'silent';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const fixture = async (name) =>
  readFile(new URL(`./fixtures/kener/${name}.json`, import.meta.url), 'utf8');
const answers = {
  monitors: await fixture('monitors'),
  incidents: await fixture('incidents'),
  'web-up': await fixture('data-web-up'),
  'nas-down': await fixture('data-nas-down'),
  earth: await fixture('data-earth'),
  'api-slow': await fixture('data-api-slow'),
};

async function discover(language) {
  const gladys = createFakeGladys({
    config: { url: 'http://192.0.2.10:3000', api_key: 'kener_test_key_0001', language },
  });
  const app = registerHandlers(gladys, {
    store: new Store(mkdtempSync(join(tmpdir(), 'gladys-kener-rules-'))),
    timers: false,
    // The recorded answers of Kener 4.1 (no point for the "kener" monitor).
    request: async (url) => {
      const path = new URL(url).pathname;
      const tag = path.match(/\/monitors\/([^/]+)\/data$/)?.[1];
      const body = tag ? (answers[tag] ?? '{"data":[]}') : answers[path.split('/').at(-1)];
      return { status: 200, body };
    },
  });
  await gladys.connect();
  await app.ready;
  await app.stop();
  return gladys.fake.discoveredDevices;
}

const scenarios = ['en', 'fr', 'de', 'es'].map((language) => ({
  label: `${language} names`,
  language,
}));

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const devices = await discover(scenario.language);
    assert.equal(devices.length, 6, 'the five monitors of the fixture and the instance');
    assert.equal(
      new Set(devices.map((device) => device.external_id)).size,
      devices.length,
      'unique device external ids',
    );

    for (const device of devices) {
      const where = device.name;

      // should_poll: true if and only if poll_frequency is provided, in ms.
      if (device.poll_frequency === undefined) {
        assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
      } else {
        assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
        assert.ok(
          table.poll_frequencies_ms.includes(device.poll_frequency),
          `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
        );
      }

      assert.ok(device.features.length > 0, `${where}: no feature`);
      const externalIds = new Set();
      const names = new Set();
      for (const feature of device.features) {
        const at = `${where} / ${feature.name}`;
        const pair = table.pairs[`${feature.category}/${feature.type}`];
        assert.ok(pair, `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`);
        assert.ok(
          pair.label_en && pair.label_fr && pair.icon,
          `${at}: couple without label or icon`,
        );

        assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
        assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
        assert.ok(
          Number.isFinite(feature.min) && Number.isFinite(feature.max),
          `${at}: finite min/max`,
        );
        assert.ok(feature.min <= feature.max, `${at}: min > max`);
        assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
        assert.equal(
          typeof feature.has_feedback,
          'boolean',
          `${at}: has_feedback must be a boolean`,
        );
        if (feature.unit !== undefined) {
          assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
        }

        assert.ok(!externalIds.has(feature.external_id), `${at}: duplicate external_id`);
        externalIds.add(feature.external_id);
        assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
        names.add(feature.name);
      }
    }
  });
}
