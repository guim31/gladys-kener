// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `kener`.
//
// The use case: a glance at the wall tablet tells whether the services the
// status page watches answer, which one does not, and what incident is open.
// Four tiles (monitors down, degraded, incidents in progress, average uptime
// over 24 hours), then one status list:
//   - the incidents in progress first (title, state), unless hidden;
//   - ten monitors or fewer: one row per monitor, the ones down first, with
//     their response time and uptime;
//   - more: one row per Kener category ("Down: 2 / 7"), the categories with
//     a monitor down first — the status page, folded.
//
// Every monitor by default, or one category, or the devices chosen in the
// widget settings. The figures are sent as values, not bound to device
// features: the widget works before the devices are added.
//
// Budget (8 components, 2 texts): four tiles, one text when Kener does not
// answer, the status list, a Refresh button (can be hidden).
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { responseTimeOf } from './devices.js';
import { WIDGET_KEY } from './hub.js';
import {
  CONNECTION_TEXT,
  ERROR_TEXT,
  INCIDENT_STATE_TEXT,
  NO_CATEGORY,
  STATE_TEXT,
  formatNumber,
  labelled,
  pick,
} from './texts.js';

// Action key of the button: permanent once published.
export const ACTIONS = Object.freeze({ REFRESH: 'refresh' });

export const MAX_ROWS = 10;

export const TEXT = {
  empty: {
    en: 'No monitor to show: check the category chosen, or the Kener configuration.',
    fr: 'Aucun moniteur à afficher : vérifiez la catégorie choisie, ou la configuration de Kener.',
    de: 'Kein Monitor anzuzeigen: Prüfe die gewählte Kategorie oder die Kener-Konfiguration.',
    es: 'Ningún monitor que mostrar: compruebe la categoría elegida o la configuración de Kener.',
  },
  down: { en: 'Down', fr: 'En panne', de: 'Ausgefallen', es: 'Caídos' },
  degraded: { en: 'Degraded', fr: 'Dégradés', de: 'Beeinträchtigt', es: 'Degradados' },
  incidents: { en: 'Incidents', fr: 'Incidents', de: 'Vorfälle', es: 'Incidentes' },
  uptime: { en: 'Uptime 24 h', fr: 'Dispo. 24 h', de: 'Verfügbar 24 h', es: 'Dispon. 24 h' },
  up: { en: 'Up', fr: 'En ligne', de: 'Online', es: 'En línea' },
  more: { en: 'Others', fr: 'Autres', de: 'Weitere', es: 'Otros' },
  refresh: { en: 'Refresh', fr: 'Actualiser', de: 'Aktualisieren', es: 'Actualizar' },
  refreshed: {
    en: 'Kener read again.',
    fr: 'Kener relu.',
    de: 'Kener neu gelesen.',
    es: 'Kener leído de nuevo.',
  },
};

// Row order: what needs attention first.
const SEVERITY = ['down', 'degraded', 'unknown', 'up'];

const ROW_STYLE = {
  down: { icon: 'x-circle', color: WIDGET_COLORS.DANGER },
  degraded: { icon: 'alert-circle', color: WIDGET_COLORS.WARNING },
  unknown: { icon: 'circle', color: WIDGET_COLORS.NEUTRAL },
  up: { icon: 'check-circle', color: WIDGET_COLORS.SUCCESS },
};

const fit = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function message(text, language) {
  return {
    ttl_seconds: 300,
    components: [{ type: 'text', variant: 'body', text: pick(text, language) }],
  };
}

const enabled = (value) => value !== false && value !== 'false';

/** The monitors the widget shows: the chosen devices, else a category, else all. */
export function selectMonitors(hub, settings) {
  const chosen = [settings?.monitors ?? []].flat().filter((id) => typeof id === 'string' && id);
  if (chosen.length > 0) {
    return [...new Set(chosen)].map((id) => hub.find(id)).filter(Boolean);
  }
  const category =
    typeof settings?.category === 'string' ? settings.category.trim().toLowerCase() : '';
  return hub.list().filter((monitor) => !category || monitor.category.toLowerCase() === category);
}

const byName = (a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label);

export function sortMonitors(monitors) {
  return [...monitors].sort(
    (a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state) || byName(a, b),
  );
}

const percent = (value, language) => `${formatNumber(value, language)} %`;

function monitorRow(monitor, language) {
  const parts = [];
  const responseTime = responseTimeOf(monitor);
  if (monitor.state !== 'up') {
    parts.push(pick(STATE_TEXT[monitor.state], language));
  } else if (responseTime !== null) {
    parts.push(`${responseTime} ms`);
  }
  if (Number.isFinite(monitor.uptime)) {
    parts.push(percent(monitor.uptime, language));
  }
  return {
    label: fit(monitor.label, 40),
    value: fit(parts.join(' · ') || pick(STATE_TEXT[monitor.state], language), 40),
    ...ROW_STYLE[monitor.state],
  };
}

function categoryRows(monitors, language) {
  const categories = new Map();
  for (const monitor of monitors) {
    const list = categories.get(monitor.category) ?? [];
    list.push(monitor);
    categories.set(monitor.category, list);
  }
  return [...categories]
    .map(([category, list]) => {
      const count = (state) => list.filter((monitor) => monitor.state === state).length;
      const worst = SEVERITY.find((state) => count(state) > 0) ?? 'unknown';
      const shown = worst === 'unknown' ? 'up' : worst;
      return {
        rank: SEVERITY.indexOf(worst),
        label: fit(category || pick(NO_CATEGORY, language), 40),
        // "Down: 1 / 8", "Up: 8 / 8": no plural to agree.
        value: labelled(pick(TEXT[shown], language), `${count(shown)} / ${list.length}`, language),
        ...ROW_STYLE[worst],
      };
    })
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ rank: _rank, ...row }) => row);
}

function incidentRow(incident, language) {
  const state = INCIDENT_STATE_TEXT[incident.state];
  return {
    label: fit(incident.title, 40),
    value: fit(state ? pick(state, language) : incident.state || '—', 40),
    icon: 'alert-triangle',
    color: WIDGET_COLORS.WARNING,
  };
}

async function get(hub, { settings, language = 'en' }) {
  if (!hub.client) {
    return message(hub.connectionStatus().message ?? CONNECTION_TEXT.noUrl, language);
  }
  const monitors = sortMonitors(selectMonitors(hub, settings));
  if (monitors.length === 0 && !hub.error) {
    return message(TEXT.empty, language);
  }
  const tags = new Set(monitors.map((monitor) => monitor.tag));
  const filtered =
    (settings?.monitors?.length ?? 0) > 0 || (settings?.category ?? '').trim() !== '';
  // Chosen monitors or a category: their incidents only.
  const incidents = hub.incidents.filter(
    (incident) => !filtered || incident.monitors.some((item) => tags.has(item.tag)),
  );

  const count = (state) => monitors.filter((monitor) => monitor.state === state).length;
  const down = count('down');
  const degraded = count('degraded');
  const uptimes = monitors.map((monitor) => monitor.uptime).filter(Number.isFinite);
  const components = [
    {
      type: 'value',
      value: down,
      label: pick(TEXT.down, language),
      icon: 'x-circle',
      color: down > 0 ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: degraded,
      label: pick(TEXT.degraded, language),
      icon: 'alert-circle',
      color: degraded > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
    {
      type: 'value',
      value: incidents.length,
      label: pick(TEXT.incidents, language),
      icon: 'alert-triangle',
      color: incidents.length > 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    },
  ];
  if (uptimes.length > 0) {
    const average = uptimes.reduce((sum, value) => sum + value, 0) / uptimes.length;
    components.push({
      type: 'value',
      value: Math.round(average * 100) / 100,
      unit: '%',
      label: pick(TEXT.uptime, language),
      icon: 'activity',
      color: average < 99 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
    });
  }

  if (hub.error) {
    components.push({
      type: 'text',
      variant: 'body',
      text: pick(ERROR_TEXT[hub.error.kind], language),
    });
  }

  const incidentRows = enabled(settings?.show_incidents)
    ? incidents.map((incident) => incidentRow(incident, language))
    : [];
  const monitorRows =
    monitors.length <= MAX_ROWS
      ? monitors.map((monitor) => monitorRow(monitor, language))
      : categoryRows(monitors, language);
  let rows = [...incidentRows, ...monitorRows];
  if (rows.length > MAX_ROWS) {
    const hidden = rows.length - (MAX_ROWS - 1);
    rows = [
      ...rows.slice(0, MAX_ROWS - 1),
      {
        label: pick(TEXT.more, language),
        value: `+${hidden}`,
        icon: 'more-horizontal',
        color: WIDGET_COLORS.NEUTRAL,
      },
    ];
  }
  if (rows.length > 0) {
    components.push({ type: 'status', items: rows });
  }

  if (enabled(settings?.show_refresh)) {
    components.push({
      type: 'button',
      label: pick(TEXT.refresh, language),
      icon: 'refresh-cw',
      style: 'secondary',
      action: { key: ACTIONS.REFRESH },
    });
  }

  // A monitor down or an incident moves: refresh sooner.
  return { ttl_seconds: hub.error || down > 0 || incidents.length > 0 ? 30 : 60, components };
}

async function action(hub, { actionKey }) {
  if (actionKey !== ACTIONS.REFRESH) {
    throw new Error(`Unknown action ${actionKey}`);
  }
  await hub.pollNow();
  if (hub.error) {
    return { message: ERROR_TEXT[hub.error.kind] };
  }
  return { message: TEXT.refreshed };
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
