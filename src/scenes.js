// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// "Is this monitor online?" is already a scene condition on the device
// feature. The actions are about what a condition cannot do: put the state of
// a monitor in a message ("NAS: Down, 97.5 % over 24 h"), and sum up the
// instance or one category — monitors down and degraded, added to Gladys or
// not, and the incidents in progress — for a morning message or a vocal
// answer. Both read Kener again when the last read is older than 15 seconds.
// -----------------------------------------------------------------------------

import { responseTimeOf } from './devices.js';
import { ACTION_TEXT, SENTENCE_TEXT, STATE_TEXT, formatNumber, labelled, pick } from './texts.js';

// Names listed in a text output, at most (the rest is counted).
export const MAX_LISTED_NAMES = 20;

const listed = (names) => {
  const shown = names.slice(0, MAX_LISTED_NAMES);
  return names.length > shown.length
    ? `${shown.join(', ')}, +${names.length - shown.length}`
    : shown.join(', ');
};

const byName = (a, b) => a.localeCompare(b);

async function readFresh(hub) {
  // An error of the last reading is not final: read again first.
  if (!hub.client) {
    hub.assertReadable();
  }
  await hub.refreshIfStale();
  hub.assertReadable();
}

export const SCENE_ACTIONS = {
  async get_monitor_status(hub, { fields = {} }) {
    await readFresh(hub);
    const language = hub.config.language;
    const monitor = hub.find(fields.device);
    if (!monitor) {
      throw new Error(pick(ACTION_TEXT.unknownMonitor, language));
    }
    const stateText = pick(STATE_TEXT[monitor.state], language);
    const responseTime = responseTimeOf(monitor);
    const parts = [stateText];
    if (monitor.state !== 'down' && monitor.state !== 'unknown' && responseTime !== null) {
      parts.push(`${responseTime} ms`);
    }
    if (Number.isFinite(monitor.uptime)) {
      parts.push(SENTENCE_TEXT[language].uptime(formatNumber(monitor.uptime, language)));
    }
    return {
      online: monitor.state === 'up' || monitor.state === 'degraded',
      degraded: monitor.state === 'degraded',
      state: stateText,
      name: monitor.label,
      category: monitor.category,
      response_time: responseTime ?? 0,
      uptime_24h: Number.isFinite(monitor.uptime) ? monitor.uptime : 0,
      sentence: `${labelled(monitor.label, parts.join(', '), language)}.`,
    };
  },

  async get_status_summary(hub, { fields = {} }) {
    await readFresh(hub);
    const language = hub.config.language;
    const category =
      typeof fields.category === 'string' ? fields.category.trim().toLowerCase() : '';
    const monitors = hub
      .list()
      .filter((monitor) => !category || monitor.category.toLowerCase() === category);
    const tags = new Set(monitors.map((monitor) => monitor.tag));
    // In a category: the incidents of its monitors only.
    const incidents = hub.incidents.filter(
      (incident) => !category || incident.monitors.some((item) => tags.has(item.tag)),
    );
    const namesIn = (state) =>
      monitors
        .filter((monitor) => monitor.state === state)
        .map((monitor) => monitor.label)
        .sort(byName);
    const down = namesIn('down');
    const degraded = namesIn('degraded');
    const titles = incidents.map((incident) => incident.title);
    const text = SENTENCE_TEXT[language];
    const sentence = [];
    if (down.length > 0) {
      sentence.push(text.down(listed(down)));
    }
    if (degraded.length > 0) {
      sentence.push(text.degraded(listed(degraded)));
    }
    if (sentence.length === 0) {
      sentence.push(text.allUp);
    }
    if (titles.length > 0) {
      sentence.push(text.incidents(listed(titles)));
    }
    return {
      down: down.length,
      degraded: degraded.length,
      total: monitors.length,
      down_names: listed(down),
      incidents: incidents.length,
      incident_titles: listed(titles),
      sentence: sentence.join(' '),
    };
  },
};
