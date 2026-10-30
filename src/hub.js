// -----------------------------------------------------------------------------
// The Kener hub: the instance read on a timer of the container (the interval
// chosen in the configuration); the states of the added devices published
// when they change, the scene events fired on transitions and new incidents,
// and the views the widget and the scene actions read. (Adapted from
// guim31/gladys-gatus.)
//
// Gladys never polls these devices (should_poll: false): the interval goes up
// to 5 minutes, beyond the fixed list of the core scheduler, and the scene
// events must fire for every monitor, added to Gladys or not — "a monitor
// goes down" spares the user one scene per device.
//
// A read: the monitor list, then the new data points of each monitor (the
// last 24 hours at the first read, then only the last minutes: the points
// stay in memory for the uptime), then the incidents. The state of a monitor
// is its newest point; Kener already confirms a state before writing it
// (`confirmation_threshold`). The last state of each monitor and the newest
// incident seen are kept in /data (src/store.js): what changed while the
// integration or Gladys restarted is still announced, once.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  VOLATILE,
  buildInstanceDevice,
  buildMonitorDevice,
  instanceIds,
  instanceValues,
  monitorIds,
  monitorValues,
  parseMonitorId,
} from './devices.js';
import { ERROR_KINDS, KenerClient, KenerError, isOngoing } from './kener/client.js';
import { hostOf, isLocalAddress, normalizeConfig } from './config.js';
import { ProblemLog } from './problems.js';
import { CONNECTION_TEXT, ERROR_TEXT, REPORT_TEXT, labelled, pick } from './texts.js';

const logger = createLogger({ name: 'kener-hub' });

export const WIDGET_KEY = 'kener';

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  DOWN: 'monitor_down',
  UP: 'monitor_up',
  INCIDENT: 'incident_opened',
});

export const HUB_TIMINGS = {
  // The response time changes at every check: published at most this often
  // per monitor (a change of state publishes it at once), so a hundred
  // monitors read every minute stay far below the 300 states per minute
  // Gladys accepts.
  volatileEveryMs: 5 * 60_000,
  // An unchanged value is sent again this often: Gladys shows "no recent
  // value" after 48 hours.
  heartbeatMs: 12 * 3600_000,
  // A scene action reads Kener again when the last read is older.
  freshMs: 15_000,
  // A monitor missing from the answers of Kener is forgotten after this.
  forgetMs: 24 * 3600_000,
  // The window of the uptime, and of the points kept in memory.
  windowMs: 24 * 3600_000,
  // Points read again at each reading: Kener may rewrite the last minutes.
  overlapMs: 5 * 60_000,
};

const MAX_TRANSPORTS_PER_REQUEST = 100;
const DATA_CONCURRENCY = 4;
const MINUTE = 60_000;

const STATE_OF = { UP: 'up', DEGRADED: 'degraded', DOWN: 'down' };

/** The state of a monitor from its points (oldest first). */
export function stateFrom(points) {
  return points.length === 0 ? 'unknown' : STATE_OF[points.at(-1).status];
}

/** When the DOWN points at the end started, null when the last one is not down. */
export function downSince(points) {
  let since = null;
  for (let i = points.length - 1; i >= 0 && points[i].status === 'DOWN'; i -= 1) {
    since = points[i].time;
  }
  return since;
}

/**
 * The uptime in percent over the points, with the formula of the monitor
 * (maintenance never appears in the points: it counts 0); null without point.
 */
export function uptimeOf(points, formula) {
  const counts = { up: 0, down: 0, degraded: 0, maintenance: 0 };
  for (const point of points) {
    counts[STATE_OF[point.status]] += 1;
  }
  const sum = (terms) => terms.reduce((total, term) => total + counts[term], 0);
  const denominator = sum(formula.denominator);
  if (denominator === 0) {
    return null;
  }
  const ratio = Math.min(1, Math.max(0, sum(formula.numerator) / denominator));
  return Math.round(ratio * 10_000) / 100;
}

/** Merge new points into the known ones (same minute: the new one wins). */
export function mergePoints(known, fresh, since) {
  const byTime = new Map();
  for (const point of [...known, ...fresh]) {
    if (point.time >= since) {
      byTime.set(point.time, point);
    }
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

export class KenerHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {Function} [options.request] HTTP seam (src/kener/client.js)
   * @param {boolean} [options.timers] the reading timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, request, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.request = request;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    // Defaults until start(): a handler reached after a failed start still
    // answers with a readable message.
    this.config = normalizeConfig({});
    this.client = null;
    this.signature = null;
    /** @type {Map<string, object>} monitors of the last read, by platform id */
    this.monitors = new Map();
    /** @type {Map<string, object[]>} the points of the last 24 hours, by platform id */
    this.points = new Map();
    /** Incidents in progress, the newest first. */
    this.incidents = [];
    this.readAt = 0;
    this.error = null;
    this.polling = null;
    /** When the volatile features of a monitor were last published, by id. */
    this.volatileAt = new Map();
    this.transports = new Map();
    this.connection = null;
    this.discovered = null;
    this.saved = { monitors: {}, lastIncidentId: null };
    this.pollTimer = null;
    this.stopped = false;
    // What fails again at every cycle (Gladys refusing, the reading loop):
    // one line when it starts, one when it ends.
    this.problems = new ProblemLog(logger);
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.saved = {
      monitors: saved.monitors && typeof saved.monitors === 'object' ? saved.monitors : {},
      lastIncidentId: Number.isInteger(saved.lastIncidentId) ? saved.lastIncidentId : null,
    };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.gladys.forgetPublishedStates?.();
    this.volatileAt.clear();
    this.transports.clear();
    this.connection = null;
    this.discovered = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const previous = this.config;
    const languageChanged = this.signature !== null && previous.language !== config.language;
    const hiddenChanged =
      this.signature !== null && previous.includeHidden !== config.includeHidden;
    this.config = config;
    const signature = JSON.stringify([config.url, config.apiKey]);
    if (signature !== this.signature) {
      if (this.signature !== null && JSON.parse(this.signature)[0] !== config.url) {
        // Another Kener: the states saved for the previous one mean nothing.
        this.saved = { monitors: {}, lastIncidentId: null };
        this.store.save(this.saved);
      }
      this.signature = signature;
      this.client =
        config.url && config.apiKey
          ? new KenerClient({ url: config.url, apiKey: config.apiKey, request: this.request })
          : null;
      this.monitors = new Map();
      this.points = new Map();
      this.transports.clear();
      this.incidents = [];
      this.readAt = 0;
      this.error = null;
      this.polling = null;
    }
    if (languageChanged || hiddenChanged) {
      // New names, or more or fewer monitors, for the Discovery tab.
      this.discovered = null;
    }
    try {
      if (this.client) {
        await this.pollNow({ publish: true });
      } else {
        await this.afterChanges(true, { publish: true });
      }
    } finally {
      this.schedulePoll();
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.store.flush();
  }

  /** The next read by the timer, after `delayMs` (the refresh interval by default). */
  schedulePoll(delayMs = this.config.pollIntervalMs) {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.client) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollNow();
        this.problems.recover('poll', 'Reading Kener works again');
      } catch (err) {
        this.problems.fail('poll', `Poll failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, delayMs);
  }

  // --- Reading Kener -----------------------------------------------------------

  /** Read the instance now and publish what changed. */
  async pollNow({ publish = false } = {}) {
    const changed = await this.poll();
    await this.afterChanges(changed, { publish });
  }

  /** Read again when the last read is older than `freshMs` (scene actions). */
  async refreshIfStale() {
    if (this.client && this.now() - this.readAt >= this.timings.freshMs) {
      await this.pollNow();
    }
  }

  /**
   * Read the instance and apply what changed. Concurrent calls share the read.
   * @returns {Promise<boolean>} whether the widget shows something new
   */
  poll() {
    if (!this.client) {
      return Promise.resolve(false);
    }
    if (!this.polling) {
      const polling = this.read(this.client).finally(() => {
        // A read of a previous client must not drop the promise of the current one.
        if (this.polling === polling) {
          this.polling = null;
        }
      });
      this.polling = polling;
    }
    return this.polling;
  }

  async read(client) {
    let monitors;
    try {
      monitors = (await client.monitors()).filter(
        (monitor) => monitor.active && (this.config.includeHidden || !monitor.hidden),
      );
    } catch (err) {
      if (!(err instanceof KenerError)) {
        throw err;
      }
      return client === this.client && this.applyFailure(err);
    }
    if (client !== this.client) {
      return false;
    }
    const points = await this.readPoints(client, monitors);
    const incidents = await this.readIncidents(client);
    // Checked once more after the last await: applySuccess changes the state
    // before its first await, so a read of a previous client never lands.
    if (client !== this.client) {
      return false;
    }
    return this.applySuccess(monitors, points, incidents);
  }

  /** The points of the last 24 hours of every monitor, the known ones completed. */
  async readPoints(client, monitors) {
    const now = this.now();
    const since = now - this.timings.windowMs;
    // Up to the end of the current minute (Kener aligns on minutes, end excluded).
    const until = Math.floor(now / MINUTE) * MINUTE + MINUTE;
    const queue = [...monitors];
    const next = new Map();
    const failures = [];
    const worker = async () => {
      for (let monitor = queue.shift(); monitor; monitor = queue.shift()) {
        const known = this.points.get(monitor.id) ?? [];
        const from =
          known.length > 0 ? Math.max(since, known.at(-1).time - this.timings.overlapMs) : since;
        try {
          const fresh = await client.data(monitor.tag, from, until);
          next.set(monitor.id, mergePoints(known, fresh, since));
        } catch (err) {
          failures.push(`${monitor.tag}: ${err.message}`);
          // The known points stay.
          next.set(monitor.id, mergePoints(known, [], since));
        }
      }
    };
    await Promise.all(Array.from({ length: DATA_CONCURRENCY }, worker));
    if (failures.length > 0) {
      this.problems.fail('data', `Data not read (${failures.length}): ${failures[0]}`);
    } else {
      this.problems.recover('data', 'Data read again');
    }
    return next;
  }

  /** The incidents; the last known ones when Kener refuses them. */
  async readIncidents(client) {
    try {
      const incidents = await client.incidents();
      this.problems.recover('incidents', 'Incidents read again');
      return incidents;
    } catch (err) {
      if (!(err instanceof KenerError)) {
        throw err;
      }
      this.problems.fail('incidents', `Incidents not read: ${err.message}`);
      return null;
    }
  }

  async applySuccess(monitors, points, incidents) {
    let widgetChanged = this.error !== null || this.readAt === 0;
    if (this.error) {
      logger.info('Kener answers again');
    }
    if (this.readAt === 0) {
      logger.info(`Kener (${hostOf(this.config.url)}): ${monitors.length} monitor(s)`);
    }
    this.error = null;
    const now = this.now();
    this.readAt = now;

    // Everything below up to the events is synchronous: a concurrent read
    // (a new configuration) cannot interleave with it.
    const next = new Map();
    const stateChanged = new Set();
    const events = [];
    let dirty = false;
    for (const raw of monitors) {
      if (next.has(raw.id)) {
        continue;
      }
      const monitorPoints = points.get(raw.id) ?? [];
      const monitor = {
        ...raw,
        state: stateFrom(monitorPoints),
        uptime: uptimeOf(monitorPoints, raw.formula),
      };
      const previous = this.monitors.get(raw.id);
      next.set(raw.id, monitor);
      if (
        !previous ||
        previous.state !== monitor.state ||
        previous.name !== monitor.name ||
        previous.category !== monitor.category
      ) {
        widgetChanged = true;
      }
      if (previous && previous.state !== monitor.state) {
        stateChanged.add(raw.id);
      }
      dirty = this.transition(monitor, monitorPoints, events) || dirty;
    }
    if ([...this.monitors.keys()].some((id) => !next.has(id))) {
      widgetChanged = true; // a monitor removed, paused or hidden in Kener
    }
    this.monitors = next;
    this.points = new Map([...points].filter(([id]) => next.has(id)));
    // A monitor missing from the answer is forgotten after a day only: a
    // monitor paused for a while still ends its outage with "is back online".
    for (const [id, saved] of Object.entries(this.saved.monitors)) {
      if (next.has(id)) {
        continue;
      }
      if (saved.missingSince === undefined) {
        saved.missingSince = now;
        dirty = true;
      } else if (now - saved.missingSince >= this.timings.forgetMs) {
        delete this.saved.monitors[id];
        dirty = true;
      }
    }
    if (incidents) {
      const { changed, opened } = this.applyIncidents(incidents, now);
      widgetChanged = widgetChanged || changed;
      dirty = dirty || opened !== null;
      for (const incident of opened ?? []) {
        events.push([TRIGGERS.INCIDENT, incident]);
      }
    }
    // Written only when something changed: no wear of the SD card at every read.
    if (dirty) {
      this.store.save(this.saved);
    }
    for (const [key, subject, extra] of events) {
      await (key === TRIGGERS.INCIDENT
        ? this.fireIncident(subject)
        : this.fireMonitor(key, subject, extra));
    }
    await this.publishStates({ changed: stateChanged });
    return widgetChanged;
  }

  /**
   * Keep the incidents in progress; find the ones opened since the last read.
   * @returns {{ changed: boolean, opened: object[]|null }} opened: null when
   *   the newest id saved did not move
   */
  applyIncidents(incidents, now) {
    const ongoing = incidents.filter((incident) => isOngoing(incident, now));
    const signature = (list) => JSON.stringify(list.map((i) => [i.id, i.title, i.state]));
    const changed = signature(ongoing) !== signature(this.incidents);
    this.incidents = ongoing;
    const newest = incidents.reduce((max, incident) => Math.max(max, incident.id), 0);
    const last = this.saved.lastIncidentId;
    if (last === newest) {
      return { changed, opened: null };
    }
    this.saved.lastIncidentId = newest;
    // First read ever, or a Kener database started again: no event.
    if (last === null || newest < last) {
      return { changed, opened: [] };
    }
    const opened = ongoing.filter((incident) => incident.id > last).sort((a, b) => a.id - b.id);
    for (const incident of opened) {
      logger.info(`New incident: ${incident.title}`);
    }
    return { changed, opened };
  }

  applyFailure(err) {
    const wasError = this.error?.kind;
    this.error = { kind: err.kind, message: err.message };
    this.readAt = this.now();
    if (wasError !== err.kind) {
      logger.warn(`Kener: ${err.message}`);
    }
    return wasError !== err.kind;
  }

  /**
   * Compare a monitor with its last saved state; queue the scene events.
   * @returns {boolean} whether the saved state changed
   */
  transition(monitor, points, events) {
    const previous = this.saved.monitors[monitor.id];
    const { state } = monitor;
    let dirty = false;
    if (previous?.missingSince !== undefined) {
      delete previous.missingSince;
      dirty = true;
    }
    if (state === 'unknown' || previous?.state === state) {
      return dirty;
    }
    const now = this.now();
    // An outage starts at its first DOWN point.
    const since = state === 'down' ? Math.min(now, downSince(points) ?? now) : now;
    this.saved.monitors[monitor.id] = {
      state,
      // Up and degraded are both online: an outage is measured from its start.
      since: state !== 'down' && previous && previous.state !== 'down' ? previous.since : since,
    };
    if (!previous) {
      return true; // first sight: no event
    }
    if (state === 'down') {
      logger.info(`${monitor.name} is down`);
      events.push([TRIGGERS.DOWN, monitor, {}]);
    } else if (previous.state === 'down') {
      const minutes = Math.max(0, Math.round((now - previous.since) / MINUTE));
      logger.info(`${monitor.name} is back online after ${minutes} min`);
      events.push([TRIGGERS.UP, monitor, { downtime_minutes: minutes }]);
    }
    return true;
  }

  async fireMonitor(key, monitor, extra = {}) {
    await this.fire(key, {
      device: monitorIds(this.gladys, monitor.id).device,
      monitor: this.view(monitor).label,
      category: monitor.category,
      ...extra,
    });
  }

  async fireIncident(incident) {
    await this.fire(TRIGGERS.INCIDENT, {
      title: incident.title,
      monitors: this.monitorNames(incident).join(', ').slice(0, 1000),
      url: incident.url,
    });
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Scene event ${key} refused: ${err.message}`);
    }
  }

  /** The names of the monitors an incident affects (the tag when unknown). */
  monitorNames(incident) {
    const byTag = new Map(this.list().map((m) => [m.tag, m.label]));
    return incident.monitors.map((item) => byTag.get(item.tag) ?? item.tag);
  }

  // --- Publishing to Gladys ----------------------------------------------------

  isCreated(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  /**
   * A monitor with its points, as the views read it. `label` is the name
   * the user gave the device in Gladys, the Kener name when not added.
   */
  view(monitor) {
    const externalId = monitorIds(this.gladys, monitor.id).device;
    const device = (this.gladys.devices ?? []).find((item) => item.external_id === externalId);
    const label = typeof device?.name === 'string' && device.name.trim() ? device.name.trim() : '';
    return { ...monitor, label: label || monitor.name, points: this.points.get(monitor.id) ?? [] };
  }

  list() {
    return [...this.monitors.values()].map((monitor) => this.view(monitor));
  }

  discoveredDevices() {
    const language = this.config.language;
    if (!this.client || this.readAt === 0 || this.error) {
      return null; // nothing read: keep the list Gladys has
    }
    return [
      buildInstanceDevice(this.gladys, language),
      ...[...this.monitors.values()].map((monitor) =>
        buildMonitorDevice(this.gladys, monitor, language),
      ),
    ];
  }

  /** Publish the Discovery list when it changed (a monitor added, renamed…). */
  async publishDevices({ force = false } = {}) {
    const devices = this.discoveredDevices() ?? (this.client ? null : []);
    if (devices === null) {
      return;
    }
    const key = JSON.stringify(devices);
    if (!force && key === this.discovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discovered = key;
      this.problems.recover('discovered', 'Discovered devices accepted again');
    } catch (err) {
      this.problems.fail('discovered', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read Kener, publish the list again. */
  async rediscover() {
    await this.poll();
    await this.afterChanges(true, { publish: true });
  }

  /**
   * The user added (or updated) a device: its states sent before were dropped
   * by Gladys, and a device deleted then added again needs its badge.
   */
  async onDeviceCreated(device) {
    const id = parseMonitorId(this.gladys, device.external_id);
    if (id) {
      this.volatileAt.delete(id);
    }
    this.transports.delete(device.external_id);
    // The SDK forgets what it sent for this device: everything goes again.
    await this.publishStates({ changed: new Set(id ? [id] : []) });
    await this.publishTransports();
    this.gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  /** Gladys asks for a refresh (onPoll, only if it polls anyway). */
  async pollDevice() {
    await this.pollNow();
  }

  /**
   * The states of the added devices. The SDK skips the values Gladys already
   * has (and sends an unchanged one again after `heartbeatMs`).
   * @param {{ changed?: Set<string> }} options monitors whose volatile features go now
   */
  async publishStates({ changed = new Set() } = {}) {
    if (this.readAt === 0 || this.error) {
      return;
    }
    const now = this.now();
    const states = [];
    let index = -1;
    for (const monitor of this.monitors.values()) {
      index += 1;
      const externalId = monitorIds(this.gladys, monitor.id).device;
      if (!this.isCreated(externalId)) {
        continue; // Gladys drops the states of a device not added
      }
      const volatileDue =
        changed.has(monitor.id) ||
        !this.volatileAt.has(monitor.id) ||
        now - this.volatileAt.get(monitor.id) >= this.timings.volatileEveryMs;
      if (volatileDue) {
        // Spread over the period: a fifth of the monitors come due each
        // time, not all of them at once.
        const spread = this.volatileAt.has(monitor.id)
          ? 0
          : ((index % 5) * this.timings.volatileEveryMs) / 5;
        this.volatileAt.set(monitor.id, now - spread);
      }
      for (const { key, ...state } of monitorValues(this.gladys, this.view(monitor))) {
        if (volatileDue || !VOLATILE.has(key)) {
          states.push(state);
        }
      }
    }
    if (this.isCreated(instanceIds(this.gladys).device)) {
      for (const { key: _key, ...state } of instanceValues(
        this.gladys,
        this.list(),
        this.incidents,
      )) {
        states.push(state);
      }
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      this.problems.recover('states', 'States accepted again');
    } catch (err) {
      this.problems.fail('states', `States refused: ${err.message}`);
    }
  }

  async afterChanges(widgetChanged, { publish = false } = {}) {
    await this.publishDevices({ force: publish });
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (widgetChanged) {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    }
  }

  /** The badge of the added devices: local or cloud (by the address), or unreachable. */
  async publishTransports() {
    if (!this.client || this.readAt === 0) {
      return;
    }
    const transport = this.error
      ? DEVICE_TRANSPORTS.UNREACHABLE
      : isLocalAddress(this.config.url)
        ? DEVICE_TRANSPORTS.LOCAL
        : DEVICE_TRANSPORTS.CLOUD;
    const entries = [];
    const ids = [
      instanceIds(this.gladys).device,
      ...[...this.monitors.keys()].map((id) => monitorIds(this.gladys, id).device),
    ];
    for (const externalId of ids) {
      if (this.isCreated(externalId) && this.transports.get(externalId) !== transport) {
        entries.push({ external_id: externalId, transport });
      }
    }
    for (let at = 0; at < entries.length; at += MAX_TRANSPORTS_PER_REQUEST) {
      const batch = entries.slice(at, at + MAX_TRANSPORTS_PER_REQUEST);
      try {
        await this.gladys.publishTransports(batch);
        for (const entry of batch) {
          this.transports.set(entry.external_id, entry.transport);
        }
        this.problems.recover('transports', 'Transports accepted again');
      } catch (err) {
        this.problems.fail('transports', `Transports refused: ${err.message}`);
      }
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (this.config.url === '') {
      return { connected: false, message: CONNECTION_TEXT.noUrl };
    }
    if (!this.config.url) {
      return { connected: false, message: CONNECTION_TEXT.invalidUrl };
    }
    if (!this.config.apiKey) {
      return { connected: false, message: CONNECTION_TEXT.noKey };
    }
    if (this.error) {
      return { connected: false, message: ERROR_TEXT[this.error.kind] };
    }
    return { connected: true };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.problems.recover('connection', 'Connection status accepted again');
    } catch (err) {
      this.problems.fail('connection', `Connection status refused: ${err.message}`);
    }
  }

  // --- Views and commands (widget, scene actions, report) ----------------------

  /** The monitor of a device external id (with its points), null when unknown. */
  find(externalId) {
    const id = parseMonitorId(this.gladys, externalId);
    const monitor = id ? this.monitors.get(id) : null;
    return monitor ? this.view(monitor) : null;
  }

  /** Throws the reason Kener cannot answer, if any. */
  assertReadable() {
    const status = this.connectionStatus();
    if (!status.connected) {
      throw new Error(pick(status.message, this.config.language));
    }
  }

  /** "Test the connection": read Kener now, one line. */
  async testConnection() {
    await this.pollNow({ publish: true });
    const message = {};
    for (const [language, text] of Object.entries(REPORT_TEXT)) {
      const status = this.connectionStatus();
      if (!status.connected) {
        message[language] = pick(status.message, language);
        continue;
      }
      const monitors = [...this.monitors.values()];
      const parts = [text.ok, text.monitors(monitors.length)];
      const down = monitors.filter((monitor) => monitor.state === 'down').length;
      if (down > 0) {
        parts.push(text.down(down));
      }
      if (this.incidents.length > 0) {
        parts.push(text.incidents(this.incidents.length));
      }
      message[language] = labelled('Kener', parts.join(', '), language);
    }
    return message;
  }
}

export { ERROR_KINDS };
