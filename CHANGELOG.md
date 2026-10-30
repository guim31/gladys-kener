# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [1.0.0] - 2026-10-30

### Added

- One device per Kener monitor: online, degraded, response time, uptime over
  24 hours (with the uptime formula of the monitor); one device for the
  instance: monitors down, degraded, incidents in progress.
- Scene triggers "A monitor goes down", "A monitor is back online" (with the
  outage length) and "A new incident is opened" (title, monitors affected,
  incident page), for any monitor.
- Scene actions "State of a monitor" and "Status page summary" (everywhere or
  in a category), each with a ready-made sentence.
- Dashboard widget: incidents in progress, then monitors down first, folded by
  category beyond ten; settings to hide the incidents and the Refresh button.
- Kener 4 API key, refresh interval from 1 to 5 minutes, hidden monitors on
  demand, local or cloud badge by the address, "Test the connection" action.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-kener/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/guim31/gladys-kener/releases/tag/v1.0.0
