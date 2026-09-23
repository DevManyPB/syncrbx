# Contributing to SyncRbx

Thanks for helping! SyncRbx edits people's games and project folders, so the bar for changes that touch sync behaviour is high. These guidelines keep it safe.

## Before you start

- **Small fixes** (typos, docs, obvious bugs): open a pull request directly.
- **Anything larger** (new features, changes to how files map to instances, UI redesigns): open an issue first so we can agree on the approach.
- Check the [open issues](https://github.com/DevManyPB/syncrbx/issues) to avoid duplicate work.

## Setup

See the *Development* section of the [README](README.md) for installing and testing each part.

## Safety rules

These exist because earlier versions lost users' work. Pull requests that break them won't be merged.

1. **Never destroy what SyncRbx doesn't manage.** Models, Parts, Tools and other non-script instances are containers; sync only the scripts inside them. See `SyncEngine:_findChild` in `plugin/src/Core/SyncEngine.lua`.
2. **Deleting is always recoverable.** On disk, removed or overwritten files go to `.syncrbx/trash` (`moveToTrash` / `copyToTrash` in `cli/local-sync.js`). In Studio, changes are wrapped in ChangeHistoryService waypoints so Ctrl+Z works.
3. **Stay inside the project and the chosen services.** Every path is checked with `resolveInsideProject`, and every change with the synced-services list, in both the server and the plugin.
4. **Don't echo your own writes.** Changes the plugin or server makes must not come back as new changes (`markIgnored`, `_applyDepth`).

## Tests

- **CLI:** `cd cli && npm test` runs end-to-end tests against a real server on port 34999. If you change sync behaviour, add a case to `cli/test.js`.
- **Extension:** `cd extension && npm test`.
- **Plugin:** there is no automated test runner for Luau yet. Describe in your pull request how you tested it in Studio (what you did and what you saw).

## Pull requests

- Keep each pull request focused on one change.
- Write the code and comments in English, matching the style of the surrounding code.
- Fill in the pull request template, including how you tested it.
- CI must pass.

## Reporting security issues

If you find a way to make SyncRbx read, write or delete files outside a project, or to control it from a web page, please don't open a public issue. Contact us privately on [Discord](https://discord.gg/kH9qfAUwXe) instead.
