# Kener for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com)
that brings a [Kener](https://kener.ing) status page into Gladys: the
monitors it checks every minute, and its incidents.

- **One device per monitor**: online (green/red badge), degraded, response
  time of the last check, uptime over 24 hours.
- **One instance device**: monitors down, degraded, incidents in progress.
- **Scene triggers**: a monitor goes down, is back online (with the outage
  length), a new incident is opened (title, monitors, link) — for any monitor,
  added to Gladys or not.
- **Scene actions**: state of a monitor, summary of the status page (in a
  category or everywhere), both with a ready-made sentence.
- **Dashboard widget**: incidents in progress, then monitors down first,
  folded by category beyond ten.
- Texts in English, French, German and Spanish.

Tested against a real Kener in Docker (Kener 4.1.10): monitors up, down and
degraded, a monitor without data, incidents open and ended, a wrong API key.
Feedback welcome on [the issues](https://github.com/guim31/gladys-kener/issues).

## Requirements

- Gladys Assistant 5.1.0 or later.
- Kener 4 (API v4) reachable from Gladys, on the local network or on the
  internet. Kener 3 is not supported.
- A Kener API key (Manage → API Keys).

## Installation

In Gladys, open **Integrations → Install from GitHub** and enter
`https://github.com/guim31/gladys-kener`. Then open its configuration, enter
the address of Kener and the API key, and add the monitors from the Discover
tab.

The full guide: [docs/en.md](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)).

## How it works

At the chosen interval (1 minute by default), the container reads
`GET /api/v4/monitors`, then the new data points of each active monitor
(`/api/v4/monitors/{tag}/data`: the last 24 hours at start, then only the last
minutes) and `GET /api/v4/incidents`. The state of a monitor is its newest
point (Kener confirms it before writing it); the uptime is computed from the
points of the last 24 hours with the formula of the monitor. The states of the
devices added to Gladys are published when they change, and the scene events
fire on the transitions of every monitor and on every new incident. The last
state of each monitor and the newest incident seen are kept in `/data`, so
what happened during a restart is announced once. Redirects are not followed,
so the API key never reaches another host.

## Limits

- One Kener instance per configuration; Kener 4 only.
- Read only: no incident is created in Kener from Gladys.
- An outage shorter than the refresh interval may not fire the triggers.
- Maintenances and incident comments are not read.
- A self-signed HTTPS certificate is not accepted (use `http://` on the local
  network).

## Development

```bash
npm ci
npm run format:check && npm run lint && npm test
npx -y github:GladysAssistant/integration-store --skip-image-check .
```

See [CLAUDE.md](CLAUDE.md) for the project rules and the notes on the Kener
API.

## Credits

- [Kener](https://github.com/rajnandan1/kener) by Raj Nandan Sharma and
  contributors (MIT): the API answers in `test/fixtures/kener` come from its
  Docker image, the uptime formula and the "in progress" rule of incidents
  from its code. The cover shows the Kener logo, from its repository.
- Built from the official
  [Gladys integration template](https://github.com/GladysAssistant/integration-template-js)
  and on the architecture of
  [gladys-gatus](https://github.com/guim31/gladys-gatus).

Not affiliated with Kener or its author.

## License

Apache-2.0, see [LICENSE](LICENSE).
