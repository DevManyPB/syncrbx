# Change Log
All notable changes to the "syncrbx" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [1.1.0] - 2026-09-23
- The extension now runs the installed SyncRbx CLI instead of bundling its own server.
- Commit messages and project IDs are passed to the CLI without a shell, so characters like `&`, `|` or `%` are safe.
- Pulling asks for confirmation before overwriting local files.
- "Purge Cache" is now "Empty Trash": it only clears `.syncrbx/trash` and keeps the project link in `.syncrbx/config.json`.

## [1.0.0] - Initial Release
- SyncRbx Cloud Webview Sidebar.
- Bidirectional code sync functionality via SyncRbx Node.js server.
- Interactive status bar to track server connectivity.
- Auto setup for `src` folders.
