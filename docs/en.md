# Kener

[Kener](https://kener.ing) is a self-hosted status page: it checks your
services (websites, APIs, ports, DNS…) every minute and publishes their state
and incidents. This integration brings it into Gladys: each monitor becomes a
device with its state, response time and uptime, scenes react when one goes
down, comes back or when an incident is opened, and a dashboard widget shows
the incidents and the monitors at a glance.

Gladys reads Kener: it does not check your services itself.

Tested against a real Kener in Docker (Kener 4.1.10): monitors up, down and
degraded, a monitor without data, incidents open and ended, a wrong API key.
Feedback welcome on [the issues](https://github.com/guim31/gladys-kener/issues).

## What you need

- Gladys Assistant 5.1.0 or later.
- Kener **4** (the API v4), reachable from Gladys: on your network (port 3000
  by default) or on the internet. Kener 3 is not supported.
- A Kener API key.

## Getting started

### 1. Create an API key in Kener

In Kener, open **Manage → API Keys**, create a key (for example "Gladys") and
copy it: Kener shows it only once. A Kener API key can also write (create
incidents, monitors): this integration only reads, but keep the key private.

### 2. Configure the integration

In Gladys, **Integrations → Kener → Configuration**:

- **Kener address**: the address of your status page, for example
  `http://192.168.1.2:3000` or `https://status.example.com`. A URL copied from
  the browser (`…/monitors/my-api`) works too. If Kener runs under a sub-path
  (`KENER_BASE_PATH`), include it.
- **API key**: the key of step 1.
- **Refresh interval**: 1, 2 or 5 minutes. Kener writes one point per minute.
- **Include hidden monitors**: off by default, the monitors hidden from the
  status page are left out.
- **Language of the names**: the language of the feature names and of the
  scene results.

**Test the connection** reads Kener at once and tells how many monitors it
found, how many are down, and the incidents in progress.

### 3. Add the monitors

In the **Discover** tab, add the monitors you want to follow, and the "Kener"
device for the whole instance. Paused monitors are not proposed. A monitor is
identified by its tag: renaming it in Kener keeps the device, changing its tag
makes a new one.

## The devices

Each monitor:

| Feature       | Value                                                    |
| ------------- | -------------------------------------------------------- |
| Online        | Yes when up or degraded, No when down                    |
| Degraded      | Yes when Kener shows it degraded                         |
| Response time | Latency of the last check that was not down, in ms       |
| Uptime 24 h   | Over the last 24 hours, with the uptime formula of Kener |

The "Kener" device: **Monitors down**, **Monitors degraded**, **Incidents in
progress**.

The response time and the uptime are sent at most every 5 minutes (at once
when the state changes), so that a large status page stays light for Gladys.
The devices show the cloud badge when Kener is on the internet, the local one
when it is on your network.

## Dashboard

The **Kener** widget shows four tiles (monitors down, degraded, incidents in
progress, average uptime), then the incidents in progress with their state,
then the monitors, the ones down first, with their response time and uptime.
Beyond ten monitors, they are folded by Kener category ("Down: 1 / 7").

Settings: one **category**, or chosen **monitors** (only the devices added to
Gladys); **Show the incidents in progress**; **Show the Refresh button**. The
**Refresh** button reads Kener at once. With a category or chosen monitors,
only their incidents are counted.

## Scenes

### Triggers

- **A monitor goes down**: Kener records a monitor down. It already confirms a
  state before writing it (its "confirmation threshold"). Filter: the monitors
  (empty: any, added to Gladys or not). Variables: monitor name, category.
- **A monitor is back online**: a monitor that was down is up or degraded
  again. Variables: monitor name, category, outage length in minutes (from its
  first point down).
- **A new incident is opened**: an incident in progress appears on the status
  page, created by hand, by the API or by a Kener alert. Variables: title,
  monitors affected, incident page.

A change that happened while Gladys or the integration was stopped is still
announced, once, at the next reading.

### Actions

- **State of a monitor**: online, degraded, state in words, name, category,
  response time, uptime 24 h, and a sentence such as "NAS: Down, 97.5 % over
  24 h."
- **Status page summary**: monitors down, degraded and in total, names of the
  monitors down, incidents in progress and their titles, and a sentence such
  as "Down: NAS. Incidents in progress: Backup server unreachable." Optional
  field: a category.

Both read Kener again when the last reading is older than 15 seconds.

### Scene ideas

- **A monitor goes down** → send a message with the monitor name.
- Every morning, **Status page summary** → read the sentence on the speaker
  only when a monitor is down.
- **A new incident is opened** → notify with the title and the page link.

## Troubleshooting

- **"Kener does not answer"**: check the address and the port from the
  machine of Gladys, and that a firewall does not block it.
- **"API key refused"**: create a new key in Manage → API Keys; a disabled key
  is refused too.
- **"No Kener 4 at this address"**: the address is not a Kener, or a Kener 3
  (no API v4). Check the sub-path if Kener runs under one.
- **"The address redirects"**: enter the `https://` address directly.
- **"Certificate refused"**: a self-signed certificate is not accepted; use
  the `http://` address on your network.
- **A monitor stays without value**: Kener has no data point for it yet.

## Limits

- Gladys reads Kener at the chosen interval: an outage shorter than it may be
  missed by the triggers (the uptime still counts it).
- The uptime is computed from the data points of the last 24 hours, with the
  formula of the monitor when it is a plain sum (the default otherwise).
  Maintenance windows are not read.
- Maintenances, comments of incidents and pages are not read.
- The integration only reads: it does not create incidents in Kener.
- Not affiliated with Kener or its author.
