// -----------------------------------------------------------------------------
// Gladys devices, proposed in the Discovery tab (the user adds the ones to
// follow, nothing is created on their behalf):
//
//   - one device per Kener monitor, identified by its tag (platformIdOf in
//     src/kener/client.js):
//       online         input/binary         1 up or degraded, 0 down — the
//                                           green / red badge, a Yes/No
//                                           condition in scenes; nothing
//                                           before the first data point
//       degraded       input/binary         1 degraded (Kener's amber), else 0
//       response_time  duration/integer ms  latency of the last check that
//                                           was not down
//       uptime_24h     unknown/unknown %    over the last 24 hours, with the
//                                           uptime formula of the monitor
//   - one "Kener" device for the instance: monitors down, degraded, incidents
//     in progress.
//
// The core has no "percent" category: the uptime is `unknown/unknown` with the
// percent unit (as gladys-gatus does), so its name shows.
//
// Published with should_poll: false: the integration reads Kener on its own
// timer (src/hub.js), at the interval chosen in the configuration.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const MONITOR_TYPE = 'monitor';
export const INSTANCE_TYPE = 'instance';
export const INSTANCE_ID = 'summary';
export const MODEL = 'Kener';

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  ONLINE: 'online',
  DEGRADED: 'degraded',
  RESPONSE_TIME: 'response_time',
  UPTIME_24H: 'uptime_24h',
});

export const INSTANCE_KEYS = Object.freeze({
  DOWN: 'down',
  DEGRADED: 'degraded',
  INCIDENTS: 'incidents',
});

// Feature names, in the language chosen in the configuration (Gladys does not
// tell a device integration the user's language). Frozen at creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.ONLINE]: 'Online',
    [FEATURE_KEYS.DEGRADED]: 'Degraded',
    [FEATURE_KEYS.RESPONSE_TIME]: 'Response time',
    [FEATURE_KEYS.UPTIME_24H]: 'Uptime 24 h',
  },
  fr: {
    [FEATURE_KEYS.ONLINE]: 'En ligne',
    [FEATURE_KEYS.DEGRADED]: 'Dégradé',
    [FEATURE_KEYS.RESPONSE_TIME]: 'Temps de réponse',
    [FEATURE_KEYS.UPTIME_24H]: 'Disponibilité 24 h',
  },
  de: {
    [FEATURE_KEYS.ONLINE]: 'Online',
    [FEATURE_KEYS.DEGRADED]: 'Beeinträchtigt',
    [FEATURE_KEYS.RESPONSE_TIME]: 'Antwortzeit',
    [FEATURE_KEYS.UPTIME_24H]: 'Verfügbarkeit 24 h',
  },
  es: {
    [FEATURE_KEYS.ONLINE]: 'En línea',
    [FEATURE_KEYS.DEGRADED]: 'Degradado',
    [FEATURE_KEYS.RESPONSE_TIME]: 'Tiempo de respuesta',
    [FEATURE_KEYS.UPTIME_24H]: 'Disponibilidad 24 h',
  },
};

export const INSTANCE_NAMES = {
  en: {
    [INSTANCE_KEYS.DOWN]: 'Monitors down',
    [INSTANCE_KEYS.DEGRADED]: 'Monitors degraded',
    [INSTANCE_KEYS.INCIDENTS]: 'Incidents in progress',
  },
  fr: {
    [INSTANCE_KEYS.DOWN]: 'Moniteurs en panne',
    [INSTANCE_KEYS.DEGRADED]: 'Moniteurs dégradés',
    [INSTANCE_KEYS.INCIDENTS]: 'Incidents en cours',
  },
  de: {
    [INSTANCE_KEYS.DOWN]: 'Ausgefallene Monitore',
    [INSTANCE_KEYS.DEGRADED]: 'Beeinträchtigte Monitore',
    [INSTANCE_KEYS.INCIDENTS]: 'Laufende Vorfälle',
  },
  es: {
    [INSTANCE_KEYS.DOWN]: 'Monitores caídos',
    [INSTANCE_KEYS.DEGRADED]: 'Monitores degradados',
    [INSTANCE_KEYS.INCIDENTS]: 'Incidentes en curso',
  },
};

// Display bounds (the core never applies them on write).
export const MAX_RESPONSE_TIME_MS = 60_000;
export const MAX_COUNT = 10_000;

// The response time changes at every check, the uptime at every reading:
// published at most every few minutes (src/hub.js), at once with a change of
// state or when the device is added.
export const VOLATILE = new Set([FEATURE_KEYS.RESPONSE_TIME, FEATURE_KEYS.UPTIME_24H]);

export const monitorIds = (gladys, id) => gladys.externalIds(MONITOR_TYPE, id);
export const instanceIds = (gladys) => gladys.externalIds(INSTANCE_TYPE, INSTANCE_ID);

/** The platform id of a device external id, null when it is not a monitor of ours. */
export function parseMonitorId(gladys, externalId) {
  const prefix = monitorIds(gladys, '').device;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) {
    return null;
  }
  const id = externalId.slice(prefix.length);
  return /^[a-z0-9][a-z0-9_-]{0,119}$/.test(id) ? id : null;
}

const sensor = (name, externalId, category, type, extra) => ({
  name,
  external_id: externalId,
  category,
  type,
  read_only: true,
  has_feedback: false,
  ...extra,
});

const binary = (name, externalId) =>
  sensor(name, externalId, DEVICE_FEATURE_CATEGORIES.INPUT, DEVICE_FEATURE_TYPES.SENSOR.BINARY, {
    keep_history: true,
    min: 0,
    max: 1,
  });

const counter = (name, externalId) =>
  sensor(
    name,
    externalId,
    DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
    DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
    { keep_history: true, min: 0, max: MAX_COUNT },
  );

/** The discovery payload of a monitor. */
export function buildMonitorDevice(gladys, monitor, language = 'en') {
  const ids = monitorIds(gladys, monitor.id);
  const names = NAMES[language] ?? NAMES.en;
  const params = [{ name: 'KENER_TAG', value: monitor.tag.slice(0, 255) }];
  if (monitor.category) {
    params.push({ name: 'KENER_CATEGORY', value: monitor.category });
  }
  return {
    name: monitor.name,
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params,
    features: [
      binary(names[FEATURE_KEYS.ONLINE], ids.feature(FEATURE_KEYS.ONLINE)),
      binary(names[FEATURE_KEYS.DEGRADED], ids.feature(FEATURE_KEYS.DEGRADED)),
      sensor(
        names[FEATURE_KEYS.RESPONSE_TIME],
        ids.feature(FEATURE_KEYS.RESPONSE_TIME),
        DEVICE_FEATURE_CATEGORIES.DURATION,
        DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        {
          unit: DEVICE_FEATURE_UNITS.MILLISECONDS,
          keep_history: true,
          min: 0,
          max: MAX_RESPONSE_TIME_MS,
        },
      ),
      sensor(
        names[FEATURE_KEYS.UPTIME_24H],
        ids.feature(FEATURE_KEYS.UPTIME_24H),
        DEVICE_FEATURE_CATEGORIES.UNKNOWN,
        DEVICE_FEATURE_TYPES.UNKNOWN.UNKNOWN,
        { unit: DEVICE_FEATURE_UNITS.PERCENT, keep_history: true, min: 0, max: 100 },
      ),
    ],
  };
}

/** The discovery payload of the instance summary. */
export function buildInstanceDevice(gladys, language = 'en') {
  const ids = instanceIds(gladys);
  const names = INSTANCE_NAMES[language] ?? INSTANCE_NAMES.en;
  return {
    name: 'Kener',
    external_id: ids.device,
    model: MODEL,
    should_poll: false,
    params: [],
    features: Object.values(INSTANCE_KEYS).map((key) => counter(names[key], ids.feature(key))),
  };
}

/** The response time of the last check that was not down, null when unknown. */
export function responseTimeOf(monitor) {
  for (let i = monitor.points.length - 1; i >= 0; i -= 1) {
    const point = monitor.points[i];
    if (point.status !== 'DOWN') {
      return point.latencyMs;
    }
  }
  return null;
}

/**
 * The value of every known feature of a monitor: `{ key, device_feature_external_id, state }`.
 * @param {object} monitor normalized monitor, with `state`
 *   ('up'|'degraded'|'down'|'unknown'), `points` and `uptime` set by the hub
 */
export function monitorValues(gladys, monitor) {
  const ids = monitorIds(gladys, monitor.id);
  const values = [];
  if (monitor.state !== 'unknown') {
    values.push({ key: FEATURE_KEYS.ONLINE, state: monitor.state === 'down' ? 0 : 1 });
    values.push({ key: FEATURE_KEYS.DEGRADED, state: monitor.state === 'degraded' ? 1 : 0 });
  }
  const responseTime = responseTimeOf(monitor);
  if (responseTime !== null) {
    values.push({
      key: FEATURE_KEYS.RESPONSE_TIME,
      state: Math.min(responseTime, MAX_RESPONSE_TIME_MS),
    });
  }
  if (Number.isFinite(monitor.uptime)) {
    values.push({ key: FEATURE_KEYS.UPTIME_24H, state: monitor.uptime });
  }
  return values.map(({ key, state }) => ({
    key,
    device_feature_external_id: ids.feature(key),
    state,
  }));
}

/** The values of the instance summary. */
export function instanceValues(gladys, monitors, incidents) {
  const ids = instanceIds(gladys);
  return [
    { key: INSTANCE_KEYS.DOWN, state: monitors.filter((m) => m.state === 'down').length },
    { key: INSTANCE_KEYS.DEGRADED, state: monitors.filter((m) => m.state === 'degraded').length },
    { key: INSTANCE_KEYS.INCIDENTS, state: incidents.length },
  ].map(({ key, state }) => ({
    key,
    device_feature_external_id: ids.feature(key),
    state: Math.min(state, MAX_COUNT),
  }));
}
