# Changelog

All notable changes to Claudometer are documented here.

## [1.1.0] - 2026-08-21

### Added
- Configurable auto-refresh interval (1 / 5 / 10 / 15 / 30 min) in the Settings panel, persisted to `chrome.storage.local` and applied to the polling alarm immediately — no restart needed.

### Changed
- Manual refresh (and a tab regaining focus) now resets the auto-refresh timer, so an automatic poll can no longer land moments after a manual one.
- Default HUD position moved from bottom-right to top-right, clear of the bookmarks bar. Existing dragged positions are unaffected.

## [1.0.0] - 2026-08-14

### Added
- Initial release: live 5-hour session window and 7-day weekly cap (with separate Opus pool where reported), burn rate & last-prompt impact, estimated runway.
- Dark/light glassmorphism themes, compact and detailed HUD views, drag-to-reposition.
- Desktop alerts at 60% / 85% / 95% usage.
- Optional "run on every website" mode.
- Offline/stale-data safety states.
