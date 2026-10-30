// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status, errors, monitor states, the "Test the connection"
// report, scene outputs and errors. Four languages, the four of the Gladys
// interface; German says "du", Spanish "usted". test/i18n.test.js checks every
// table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './kener/client.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of your Kener in the configuration.',
    fr: "Saisissez l'adresse de votre Kener dans la configuration.",
    de: 'Gib die Adresse deines Kener in der Konfiguration ein.',
    es: 'Introduzca la dirección de su Kener en la configuración.',
  },
  invalidUrl: {
    en: 'Address not understood, e.g. http://192.168.1.2:3000',
    fr: 'Adresse incomprise, ex. http://192.168.1.2:3000',
    de: 'Adresse nicht verstanden, z. B. http://192.168.1.2:3000',
    es: 'Dirección no válida, p. ej. http://192.168.1.2:3000',
  },
  noKey: {
    en: 'Enter a Kener API key in the configuration (Manage → API Keys).',
    fr: "Saisissez une clé d'API Kener dans la configuration (Manage → API Keys).",
    de: 'Gib einen Kener-API-Schlüssel in der Konfiguration ein (Manage → API Keys).',
    es: 'Introduzca una clave de API de Kener en la configuración (Manage → API Keys).',
  },
};

// One short explanation per error kind (src/kener/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'Kener does not answer',
    fr: 'Kener ne répond pas',
    de: 'Kener antwortet nicht',
    es: 'Kener no responde',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: use an http:// address or a trusted certificate',
    fr: 'certificat refusé : utilisez une adresse http:// ou un certificat reconnu',
    de: 'Zertifikat abgelehnt: Nutze eine http://-Adresse oder ein vertrauenswürdiges Zertifikat',
    es: 'certificado rechazado: use una dirección http:// o un certificado reconocido',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'API key refused: check it, or create one in Manage → API Keys',
    fr: "clé d'API refusée : vérifiez-la, ou créez-en une dans Manage → API Keys",
    de: 'API-Schlüssel abgelehnt: Prüfe ihn oder erstelle einen unter Manage → API Keys',
    es: 'clave de API rechazada: compruébela o cree una en Manage → API Keys',
  },
  [ERROR_KINDS.NOT_KENER]: {
    en: 'no Kener 4 at this address (Kener 3 is not supported)',
    fr: "aucun Kener 4 à cette adresse (Kener 3 n'est pas pris en charge)",
    de: 'kein Kener 4 unter dieser Adresse (Kener 3 wird nicht unterstützt)',
    es: 'no hay ningún Kener 4 en esta dirección (Kener 3 no es compatible)',
  },
  [ERROR_KINDS.REDIRECT]: {
    en: 'the address redirects: enter the https:// address',
    fr: "l'adresse redirige : saisissez l'adresse en https://",
    de: 'die Adresse leitet um: Gib die https://-Adresse ein',
    es: 'la dirección redirige: introduzca la dirección https://',
  },
  [ERROR_KINDS.HTTP]: {
    en: 'unexpected answer, see the logs',
    fr: 'réponse inattendue, voir les logs',
    de: 'unerwartete Antwort, sieh in den Protokollen nach',
    es: 'respuesta inesperada, consulte los registros',
  },
};

// The state of a monitor, in words (widget rows, scene outputs).
export const STATE_TEXT = {
  up: { en: 'Up', fr: 'En ligne', de: 'Online', es: 'En línea' },
  degraded: { en: 'Degraded', fr: 'Dégradé', de: 'Beeinträchtigt', es: 'Degradado' },
  down: { en: 'Down', fr: 'En panne', de: 'Ausgefallen', es: 'Caído' },
  unknown: {
    en: 'No data yet',
    fr: 'Aucune donnée',
    de: 'Noch keine Daten',
    es: 'Sin datos',
  },
};

// The state of an incident, as Kener names it.
export const INCIDENT_STATE_TEXT = {
  INVESTIGATING: {
    en: 'Investigating',
    fr: 'En analyse',
    de: 'Wird untersucht',
    es: 'Investigando',
  },
  IDENTIFIED: { en: 'Identified', fr: 'Identifié', de: 'Erkannt', es: 'Identificado' },
  MONITORING: {
    en: 'Monitoring',
    fr: 'Sous surveillance',
    de: 'Wird beobachtet',
    es: 'En observación',
  },
  RESOLVED: { en: 'Resolved', fr: 'Résolu', de: 'Behoben', es: 'Resuelto' },
};

// The "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    ok: 'Connected',
    monitors: (count) => `${count} monitor(s)`,
    down: (count) => `${count} down`,
    incidents: (count) => `${count} incident(s) in progress`,
  },
  fr: {
    ok: 'Connecté',
    monitors: (count) => `${count} moniteur(s)`,
    down: (count) => `${count} en panne`,
    incidents: (count) => `${count} incident(s) en cours`,
  },
  de: {
    ok: 'Verbunden',
    monitors: (count) => `${count} Monitor(e)`,
    down: (count) => `${count} ausgefallen`,
    incidents: (count) => `laufende Vorfälle: ${count}`,
  },
  es: {
    ok: 'Conectado',
    monitors: (count) => `${count} monitor(es)`,
    down: (count) => `${count} caído(s)`,
    incidents: (count) => `${count} incidente(s) en curso`,
  },
};

// Errors of the scene actions (shown in Gladys).
export const ACTION_TEXT = {
  unknownMonitor: {
    en: 'This device is not a Kener monitor.',
    fr: "Cet appareil n'est pas un moniteur Kener.",
    de: 'Dieses Gerät ist kein Kener-Monitor.',
    es: 'Este dispositivo no es un monitor de Kener.',
  },
};

// The `sentence` outputs of the scene actions.
export const SENTENCE_TEXT = {
  en: {
    uptime: (value) => `${value} % over 24 h`,
    allUp: 'Every monitor is up.',
    down: (names) => `Down: ${names}.`,
    degraded: (names) => `Degraded: ${names}.`,
    incidents: (titles) => `Incidents in progress: ${titles}.`,
  },
  fr: {
    uptime: (value) => `${value} % sur 24 h`,
    allUp: 'Tous les moniteurs sont en ligne.',
    down: (names) => `En panne : ${names}.`,
    degraded: (names) => `Dégradés : ${names}.`,
    incidents: (titles) => `Incidents en cours : ${titles}.`,
  },
  de: {
    uptime: (value) => `${value} % in 24 h`,
    allUp: 'Alle Monitore sind online.',
    down: (names) => `Ausgefallen: ${names}.`,
    degraded: (names) => `Beeinträchtigt: ${names}.`,
    incidents: (titles) => `Laufende Vorfälle: ${titles}.`,
  },
  es: {
    uptime: (value) => `${value} % en 24 h`,
    allUp: 'Todos los monitores están en línea.',
    down: (names) => `Caídos: ${names}.`,
    degraded: (names) => `Degradados: ${names}.`,
    incidents: (titles) => `Incidentes en curso: ${titles}.`,
  },
};

// Shown when a monitor has no category.
export const NO_CATEGORY = {
  en: 'No category',
  fr: 'Sans catégorie',
  de: 'Ohne Kategorie',
  es: 'Sin categoría',
};

export const LANGUAGE_FALLBACK = 'en';

const LOCALES = { en: 'en-GB', fr: 'fr-FR', de: 'de-DE', es: 'es-ES' };

/** A number in the conventions of the language (decimal comma in fr, de, es). */
export const formatNumber = (value, language) =>
  new Intl.NumberFormat(LOCALES[language] ?? LOCALES.en, { maximumFractionDigits: 2 }).format(
    value,
  );

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, text, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${text}`;
export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];
