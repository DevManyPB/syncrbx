#!/usr/bin/env node

const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const http = require('http');
const { spawn } = require('child_process');

const program = new Command();

const API_BASE_URL = process.env.SYNCRBX_API_URL || 'https://syncrbxbot.onrender.com/api/cli';
const WEB_BASE_URL = process.env.SYNCRBX_WEB_URL || 'https://www.syncrbx.xyz';

const CONFIG_PATH = path.join(process.env.HOME || process.env.USERPROFILE, '.syncrbxconfig.json');

// Refresh the access token when it expires in less than this many seconds.
const TOKEN_REFRESH_MARGIN_S = 60;

// --- Helper Functions ---

function forceExit(code) {
    setTimeout(() => {
        process.exit(code);
    }, 50);
}

function readCredentials() {
    if (!fs.existsSync(CONFIG_PATH)) return null;
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
        return null;
    }
}

function saveCredentials({ access_token, refresh_token }) {
    const data = { access_token };
    if (refresh_token) data.refresh_token = refresh_token;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function getTokenExpiry(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' ? payload.exp : null;
    } catch (e) {
        return null;
    }
}

// Returns a usable access token, refreshing it through the API when it is
// about to expire. Returns null when the user has to log in again.
async function getToken() {
    const credentials = readCredentials();
    if (!credentials || !credentials.access_token) return null;

    const exp = getTokenExpiry(credentials.access_token);
    const expiresSoon = exp !== null && exp - Date.now() / 1000 < TOKEN_REFRESH_MARGIN_S;
    if (!expiresSoon) return credentials.access_token;

    if (!credentials.refresh_token) {
        console.error('❌ Your session has expired. Run "syncrbx login" again.');
        return null;
    }

    try {
        const res = await fetch(`${API_BASE_URL}/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: credentials.refresh_token }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.access_token) {
            console.error('❌ Your session has expired. Run "syncrbx login" again.');
            return null;
        }
        saveCredentials(data);
        return data.access_token;
    } catch (err) {
        console.error(`❌ Could not refresh your session: ${err.message}`);
        return null;
    }
}

// Trades the browser's access token for a session that belongs to the CLI, so
// both can refresh independently. Returns null if the API does not support it.
async function createCliSession(webAccessToken) {
    try {
        const res = await fetch(`${API_BASE_URL}/session`, {
            method: 'POST',
            headers: { 'Authorization': webAccessToken },
        });
        const data = await res.json().catch(() => ({}));
        return res.ok && data.access_token ? data : null;
    } catch (err) {
        return null;
    }
}

function getProjectConfig() {
    const localSyncRbx = path.join(process.cwd(), '.syncrbx', 'config.json');
    if (fs.existsSync(localSyncRbx)) {
        return JSON.parse(fs.readFileSync(localSyncRbx, 'utf8'));
    }
    return null;
}

function openBrowser(url) {
    // Spawn without a shell so the "&" in the query string is not treated as a
    // command separator.
    const [command, args] = process.platform === 'darwin' ? ['open', [url]]
        : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
    try {
        const child = spawn(command, args, { stdio: 'ignore', detached: true });
        child.on('error', () => { /* the URL is also printed to the terminal */ });
        child.unref();
    } catch (e) {
        // the URL is also printed to the terminal
    }
}

function getAllowedWebOrigins() {
    const origin = new URL(WEB_BASE_URL).origin;
    const origins = new Set([origin]);
    const url = new URL(origin);
    url.hostname = url.hostname.startsWith('www.') ? url.hostname.slice(4) : `www.${url.hostname}`;
    origins.add(url.origin);
    return origins;
}

// --- Commands ---

program
  .name('syncrbx')
  .description('SyncRbx - A free tool to sync VS Code with Roblox Studio.')
  .version(require('./package.json').version);

// Command: Login
program
  .command('login')
  .description('Authenticate with your SyncRbx account')
  .option('-t, --token <token>', 'Provide the token directly')
  .action((options) => {
    if (options.token) {
        saveCredentials({ access_token: options.token });
        console.log('✅ Successfully logged in to SyncRbx.');
        return;
    }

    const PORT = 14872;
    // Random value that the web page must echo back, so other pages cannot
    // push their own token into the CLI while it is waiting.
    const state = crypto.randomBytes(24).toString('hex');
    const loginUrl = `${WEB_BASE_URL}/cli-login?port=${PORT}&state=${state}`;
    const allowedOrigins = getAllowedWebOrigins();

    console.log(`🔗 Opening the browser to authenticate...`);
    console.log(`If the browser does not open automatically, click here: ${loginUrl}`);

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${PORT}`);
        const headers = { 'Content-Type': 'application/json' };
        if (req.headers.origin && allowedOrigins.has(req.headers.origin)) {
            headers['Access-Control-Allow-Origin'] = req.headers.origin;
            headers['Vary'] = 'Origin';
        }

        if (url.pathname !== '/callback') {
            res.writeHead(404);
            res.end();
            return;
        }

        const receivedState = url.searchParams.get('state') || '';
        const stateMatches = receivedState.length === state.length
            && crypto.timingSafeEqual(Buffer.from(receivedState), Buffer.from(state));
        if (!stateMatches) {
            res.writeHead(403, headers);
            res.end(JSON.stringify({ error: 'Invalid state' }));
            return;
        }

        const token = url.searchParams.get('token');
        if (!token) {
            res.writeHead(400, headers);
            res.end(JSON.stringify({ error: 'Token missing' }));
            console.error('❌ Error: No token received.');
            server.close(() => forceExit(1));
            return;
        }

        res.writeHead(200, headers);
        res.end(JSON.stringify({ success: true }));
        server.close();

        createCliSession(token).then(session => {
            saveCredentials(session || { access_token: token });
            if (!session) {
                console.log('⚠️  This login will expire in about an hour. Run "syncrbx login" again when it does.');
            }
            console.log('✅ Successfully logged in. You can now return to the terminal.');
            forceExit(0);
        });
    });

    server.listen(PORT, '127.0.0.1', () => {
        openBrowser(loginUrl);
    });
  });

// Command: Serve
program
  .command('serve')
  .description('Start the local SyncRbx server')
  .action(() => {
      // Loaded lazily: requiring local-sync starts the file watcher.
      require('./local-sync').startServer();
  });

// Command: Init
program
  .command('init')
  .description('Initialize a new SyncRbx repository in the cloud')
  .option('--private', 'Make the repository private')
  .option('--public', 'Make the repository public (default)')
  .action(async (options) => {
      const token = await getToken();
      if (!token) {
          console.error('❌ You are not authenticated. Use "syncrbx login" first.');
          forceExit(1);
          return;
      }

      const srcPath = path.join(process.cwd(), 'src');
      const rojoConfig = path.join(process.cwd(), 'default.project.json');

      if (!fs.existsSync(srcPath) && !fs.existsSync(rojoConfig)) {
          console.log('🚧 Roblox structure not detected. Creating scaffolding (src/ and config.json)...');
          fs.mkdirSync(srcPath, { recursive: true });

          const configJson = {
              name: path.basename(process.cwd()),
              version: "1.0.0",
              engine: "roblox",
              type: "syncrbx-project"
          };
          fs.writeFileSync(path.join(srcPath, 'config.json'), JSON.stringify(configJson, null, 2));
          console.log('✅ Base structure created.');
      }

      const isPrivate = options.private ? true : false;
      const projectName = path.basename(process.cwd());

      console.log(`🚀 Initializing project "${projectName}" as ${isPrivate ? 'private' : 'public'}...`);

      try {
          const res = await fetch(`${API_BASE_URL}/init`, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': token
              },
              body: JSON.stringify({ projectName, isPrivate })
          });

          const data = await res.json();

          if (!res.ok) {
              console.error(`❌ Error initializing: ${data.error}`);
              forceExit(1);
              return;
          }

          const syncrbxFolder = path.join(process.cwd(), '.syncrbx');
          if (!fs.existsSync(syncrbxFolder)) fs.mkdirSync(syncrbxFolder);
          fs.writeFileSync(path.join(syncrbxFolder, 'config.json'), JSON.stringify({ project_id: data.id, owner_id: data.owner_id }, null, 2));

          console.log('✅ Project initialized successfully and linked to the cloud.');
          forceExit(0);
      } catch (err) {
          console.error(`❌ API connection failed: ${err.message}`);
          forceExit(1);
      }
  });

// Command: Push
program
  .command('push')
  .description('Package your code and push a commit to the cloud')
  .argument('<message>', 'Commit message')
  .action(async (message) => {
      const token = await getToken();
      if (!token) {
          console.error('❌ You are not authenticated. Use "syncrbx login" first.');
          forceExit(1);
          return;
      }

      const projectConfig = getProjectConfig();
      if (!projectConfig || !projectConfig.project_id) {
          console.error('❌ This directory is not linked to SyncRbx Cloud. Run "syncrbx init" first.');
          forceExit(1);
          return;
      }

      console.log(`📦 Packaging local code...`);
      const zipPath = path.join(process.cwd(), '.syncrbx_build.zip');
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', async () => {
          const stats = fs.statSync(zipPath);
          const fileSizeInMB = stats.size / (1024 * 1024);

          if (fileSizeInMB > 10) {
              console.error(`❌ The packaged file is too large (${fileSizeInMB.toFixed(2)} MB). 10 MB limit exceeded.`);
              fs.unlinkSync(zipPath);
              forceExit(1);
              return;
          }

          console.log(`✅ Compressed file (${stats.size} bytes).`);
          console.log(`☁️ Pushing to SyncRbx Cloud...`);

          let exitCode = 1;
          try {
              const zipBuffer = fs.readFileSync(zipPath);
              const res = await fetch(`${API_BASE_URL}/push`, {
                  method: 'POST',
                  headers: {
                      'Authorization': token,
                      'Content-Type': 'application/zip',
                      'x-project-id': projectConfig.project_id,
                      // HTTP headers only carry Latin-1, so accents and emoji
                      // are percent-encoded.
                      'x-commit-message': encodeURIComponent(message),
                      'x-commit-message-encoding': 'uri'
                  },
                  body: zipBuffer
              });

              const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
              if (!res.ok) {
                  console.error(`❌ Error pushing: ${data.error}`);
              } else {
                  console.log(`🎉 Push successfully completed.`);
                  exitCode = 0;
              }
          } catch (err) {
              console.error(`❌ API connection failed: ${err.message}`);
          }

          fs.unlinkSync(zipPath);
          process.exit(exitCode);
      });

      archive.on('error', (err) => {
          console.error(`❌ Error packaging files: ${err.message}`);
          try { fs.unlinkSync(zipPath); } catch (e) { /* already gone */ }
          forceExit(1);
      });

      archive.pipe(output);
      archive.glob('**/*.{lua,luau,json,txt,md,toml}', {
          ignore: ['node_modules/**', '.git/**', '.syncrbx/**', '.syncrbx_build.zip']
      });
      archive.finalize();
  });

// Command: Pull
program
  .command('pull')
  .description('Clone or update a repository from the cloud')
  .argument('<project_id>', 'ID of the repository to clone')
  .option('-f, --force', 'Overwrite local files that differ from the cloud version')
  .action(async (projectId, options) => {
      const token = await getToken();
      if (!token) {
          console.error('❌ You are not authenticated. Use "syncrbx login" first.');
          forceExit(1);
          return;
      }

      console.log(`🔍 Downloading repository with ID: ${projectId}...`);

      try {
          const res = await fetch(`${API_BASE_URL}/pull/${encodeURIComponent(projectId)}`, {
              method: 'GET',
              headers: {
                  'Authorization': token
              }
          });

          if (!res.ok) {
              const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
              console.error(`❌ Error: ${errorData.error}`);
              forceExit(1);
              return;
          }

          const arrayBuffer = await res.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const ownerId = res.headers.get('x-owner-id') || 'unknown';

          let zip;
          try {
              zip = new AdmZip(buffer);
          } catch (e) {
              console.error(`❌ Error reading zip file: ${e.message}`);
              forceExit(1);
              return;
          }

          if (!options.force) {
              const overwritten = zip.getEntries()
                  .filter(entry => !entry.isDirectory)
                  .filter(entry => {
                      const localPath = path.join(process.cwd(), entry.entryName);
                      if (!fs.existsSync(localPath)) return false;
                      return !fs.statSync(localPath).isFile() || !fs.readFileSync(localPath).equals(entry.getData());
                  })
                  .map(entry => entry.entryName);

              if (overwritten.length > 0) {
                  console.error(`❌ Pull would overwrite ${overwritten.length} local file(s) with different content:`);
                  for (const name of overwritten.slice(0, 10)) console.error(`   - ${name}`);
                  if (overwritten.length > 10) console.error(`   ...and ${overwritten.length - 10} more`);
                  console.error('Run "syncrbx pull <project_id> --force" to overwrite them.');
                  forceExit(1);
                  return;
              }
          }

          console.log(`📂 Extracting files...`);
          try {
              zip.extractAllTo(process.cwd(), true);
          } catch (e) {
              console.error(`❌ Error extracting zip file: ${e.message}`);
              forceExit(1);
              return;
          }

          const syncrbxFolder = path.join(process.cwd(), '.syncrbx');
          if (!fs.existsSync(syncrbxFolder)) fs.mkdirSync(syncrbxFolder);
          fs.writeFileSync(path.join(syncrbxFolder, 'config.json'), JSON.stringify({ project_id: projectId, owner_id: ownerId }, null, 2));

          console.log(`🎉 Pull completed successfully. The directory is now synchronized.`);
          forceExit(0);
      } catch (err) {
          console.error(`❌ API connection failed: ${err.message}`);
          forceExit(1);
      }
  });

program.parse(process.argv);
