// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
//
// One Kener instance: its address, an API key (Manage → API Keys), how often
// it is read, whether hidden monitors are proposed, and the language of the
// names.
// -----------------------------------------------------------------------------

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

// Refresh intervals offered in the configuration, in seconds. Kener writes one
// point per minute at most: a closer reading would find nothing new.
export const POLL_INTERVALS = ['60', '120', '300'];

export const DEFAULT_CONFIG = {
  url: '',
  api_key: '',
  poll_interval: '60',
  include_hidden: false,
  language: 'fr',
};

// Pages of the Kener interface: a URL copied from the browser points at one
// of them, the API lives at the root (or at KENER_BASE_PATH).
const INTERFACE_PATH =
  /\/(manage|monitors|incidents|maintenances|account|api|badge|embed|docs)(\/.*)?$/i;

/**
 * Parse the address typed by the user into a base URL: a bare host or IP
 * (`192.0.2.10:3000`), or a URL copied from the browser
 * (`https://status.example.com/monitors/api`). HTTP by default for a bare
 * host. A path is kept (Kener behind a sub-path), the interface pages dropped.
 * @param {unknown} raw
 * @returns {string|null} `http(s)://host[:port][/path]`, null when unusable
 */
export function parseServerUrl(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const text = raw.trim();
  if (!text) {
    return null;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    return null;
  }
  // Credentials in the address would end up in the logs.
  if (url.username || url.password) {
    return null;
  }
  const path = url.pathname.replace(INTERFACE_PATH, '').replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/** Host part shown to the user (no scheme). */
export const hostOf = (url) => url.replace(/^https?:\/\//, '');

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const choice = (key, options) =>
    options.includes(String(source[key])) ? String(source[key]) : DEFAULT_CONFIG[key];
  const typed = text('url');
  return {
    // Empty: not configured yet; null: typed but not understood.
    url: typed ? parseServerUrl(typed) : '',
    // A pasted key often carries a trailing space or new line.
    apiKey: text('api_key'),
    pollIntervalMs: Number(choice('poll_interval', POLL_INTERVALS)) * 1000,
    includeHidden: source.include_hidden === true || source.include_hidden === 'true',
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}

/**
 * Does the address point at the home network (private IP, `.local`, a bare
 * host name)? Kener there is reached locally; a public status page goes
 * through the internet (the `cloud` badge of the devices).
 */
export function isLocalAddress(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (!host.includes('.') && !host.includes(':')) {
    return true; // nas, kener, localhost
  }
  if (/\.(local|lan|home|internal|localdomain|home\.arpa)$/.test(host)) {
    return true;
  }
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT, Tailscale
    );
  }
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
}
