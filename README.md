<p align="center">
  <img src="https://www.syncrbx.xyz/Logo.png" alt="SyncRbx" width="160" />
</p>

<h1 align="center">SyncRbx</h1>

<p align="center">
  Free, two-way sync between your code editor and Roblox Studio.<br />
  <a href="https://www.syncrbx.xyz">Website</a> ·
  <a href="https://www.syncrbx.xyz/docs">Docs</a> ·
  <a href="https://discord.gg/jgM2zNuYsN">Discord</a>
</p>

---

Edit your scripts in VS Code (or any editor) and see them in Roblox Studio instantly, and the other way around. SyncRbx maps folders to Roblox services with no config files, and it is built to never lose your work: Models stay Models, nothing outside the services you choose is touched, and everything it deletes or overwrites goes to a trash folder first.

## What's in this repository

| Folder | What it is | Published as |
|---|---|---|
| [`cli/`](cli) | The `syncrbx` command: local sync server (`syncrbx serve`) and SyncRbx Cloud commands | [`syncrbx` on npm](https://www.npmjs.com/package/syncrbx) |
| [`plugin/`](plugin) | The Roblox Studio plugin (Luau) | [Roblox Creator Store](https://create.roblox.com/store/asset/92888643849408) |
| [`extension/`](extension) | The VS Code extension: sidebar and status bar that drive the CLI | [Open VSX](https://open-vsx.org/extension/DevMany/syncrbx) |

## How it works

```
 Your editor ── files ──► syncrbx serve (cli/) ◄── HTTP long-polling ── Studio plugin (plugin/)
                          127.0.0.1:34872
```

- **`cli/local-sync.js`** watches your project folder and serves changes over HTTP, only to your own computer.
- **The plugin** polls the server for changes from disk and sends the changes you make in Studio back.
- **`cli/converters.js`** translates files to instances and back: `.server.lua` → Script, `.client.lua` → LocalScript, `.lua` → ModuleScript, `.txt` → StringValue, `.model.json` → any class, and more.
- The first time a project connects, the plugin asks **which services to sync**. The choice is saved in `syncrbx.project.json`, and nothing outside those services is read, written or deleted.

## Development

You need [Node.js](https://nodejs.org) 18 or newer and Roblox Studio.

**CLI**
```bash
cd cli
npm install
npm test          # end-to-end tests of the sync server
npm link          # use your local build as the global `syncrbx` command
```

**Plugin**
```bash
node plugin/build.js
```
This writes `plugin/dist/SyncRbx.rbxmx`. Copy it to your Studio Plugins folder (in Studio: *Plugins → Plugins Folder*) and restart Studio.

**Extension**
```bash
cd extension
npm install
npm test
```
Open the `extension` folder in VS Code and press **F5** to launch a window with the extension loaded.

## Contributing

Bug reports, ideas and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; the short version: open an issue before large changes, add a test for sync behaviour you change, and never make SyncRbx delete something it didn't create.

## License

[MIT](LICENSE) © DevManyPB
