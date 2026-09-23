const express = require('express');
const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const {
    processDirectory, convertFile, instanceToFile,
    filePathToInstancePath, stripExtension, ROOT_SERVICES,
    buildChecksums, loadProjectConfig, classFromFileName, isInitFile, ANY_CLASS,
    saveProjectServices, sanitizeServices, STARTER_PLAYER_CHILDREN,
} = require('./converters');

const app = express();

// ---------------------------------------------------------------------------
// Project root & config 
// ---------------------------------------------------------------------------
const PROJECT_ROOT = process.cwd();

const projectConfig = loadProjectConfig(PROJECT_ROOT);
const PORT = projectConfig.port || 34872;

// ---------------------------------------------------------------------------
// Synced services — the user picks them in the Studio plugin the first time a
// project connects; they are saved in syncrbx.project.json. Nothing outside
// them is read, written or deleted, in either direction.
// ---------------------------------------------------------------------------
function isServiceSynced(serviceName) {
    // Projects that have not chosen yet keep the previous behaviour (every
    // known service), so older plugins still work.
    const services = projectConfig.services || ROOT_SERVICES;
    return services.includes(serviceName);
}

// "Workspace/Map/Door" → is Workspace synced?
function isInstancePathSynced(instancePath) {
    return isServiceSynced(String(instancePath || '').split('/')[0]);
}

function isDiskPathSynced(filePath) {
    const relative = path.relative(PROJECT_ROOT, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    return isServiceSynced(relative.split(path.sep)[0]);
}

// Creates the folder of each synced service that does not exist yet.
function createServiceFolders(services) {
    const folders = [...services];
    if (services.includes('StarterPlayer')) {
        folders.push(...STARTER_PLAYER_CHILDREN.map(child => `StarterPlayer/${child}`));
    }
    for (const folder of folders) {
        const folderPath = path.join(PROJECT_ROOT, folder);
        if (!fs.existsSync(folderPath)) {
            markIgnored(folderPath);
            fs.mkdirSync(folderPath, { recursive: true });
            logDisk(`Folder created: ${folder}`);
        }
    }
}
const HOST = '127.0.0.1';
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

// Only Roblox Studio and the VS Code extension talk to this server. Neither
// sends an Origin header, so a request that carries one comes from a web page
// and is rejected. The Host check blocks DNS-rebinding attacks.
app.use((req, res, next) => {
    if (req.headers.origin || !ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    next();
});

app.use(express.json({ limit: '50mb' }));

// ---------------------------------------------------------------------------
// ANSI color helpers
// ---------------------------------------------------------------------------
const c = {
    green:   (t) => `\x1b[32m${t}\x1b[0m`,
    red:     (t) => `\x1b[31m${t}\x1b[0m`,
    yellow:  (t) => `\x1b[33m${t}\x1b[0m`,
    cyan:    (t) => `\x1b[36m${t}\x1b[0m`,
    magenta: (t) => `\x1b[35m${t}\x1b[0m`,
    dim:     (t) => `\x1b[2m${t}\x1b[0m`,
    bold:    (t) => `\x1b[1m${t}\x1b[0m`,
};

function logDisk(msg)    { console.log(`${c.cyan('[Disk]')}   ${msg}`); }
function logStudio(msg)  { console.log(`${c.magenta('[Studio]')}  ${msg}`); }
function logServer(msg)  { console.log(`${c.green('[SyncRbx]')}   ${msg}`); }
function logWarn(msg)    { console.log(`${c.yellow('[WARN]')}    ${msg}`); }
function logError(msg)   { console.log(`${c.red('[ERROR]')}   ${msg}`); }
function logConflict(msg){ console.log(`${c.red(c.bold('[CONFLICT]'))} ${msg}`); }

// ---------------------------------------------------------------------------
// Echo-Loop Prevention
// ---------------------------------------------------------------------------
const ignoreSet = new Set();
const IGNORE_TTL_MS = 3000;

function markIgnored(filePath) {
    const normalized = path.resolve(filePath);
    ignoreSet.add(normalized);
    setTimeout(() => ignoreSet.delete(normalized), IGNORE_TTL_MS);
}

// A path is ignored when it, or a folder above it, was written by SyncRbx.
function isIgnored(filePath) {
    let current = path.resolve(filePath);
    while (current.startsWith(PROJECT_ROOT)) {
        if (ignoreSet.has(current)) return true;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------
const lastWriteTimestamps = new Map();

function getTimestamps(filePath) {
    const key = path.resolve(filePath);
    if (!lastWriteTimestamps.has(key)) {
        lastWriteTimestamps.set(key, { disk: 0, studio: 0 });
    }
    return lastWriteTimestamps.get(key);
}

function createConflictBackup(filePath) {
    if (!fs.existsSync(filePath)) return;
    const backupPath = filePath + '.conflict.bak';
    try {
        fs.copyFileSync(filePath, backupPath);
        logConflict(`Backup saved: ${path.basename(backupPath)}`);
    } catch (e) {
        logError(`Could not create conflict backup: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// Trash — nothing SyncRbx deletes or overwrites is lost for good
// ---------------------------------------------------------------------------
const TRASH_ROOT = path.join(PROJECT_ROOT, '.syncrbx', 'trash');

function trashDestination(filePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const relative = path.relative(PROJECT_ROOT, filePath);
    let dest = path.join(TRASH_ROOT, stamp, relative);
    for (let i = 1; fs.existsSync(dest); i++) {
        dest = path.join(TRASH_ROOT, `${stamp}-${i}`, relative);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return dest;
}

// Moves a file or folder into .syncrbx/trash instead of deleting it.
function moveToTrash(filePath) {
    const dest = trashDestination(filePath);
    markIgnored(filePath);
    try {
        fs.renameSync(filePath, dest);
    } catch (e) {
        fs.cpSync(filePath, dest, { recursive: true });
        fs.rmSync(filePath, { recursive: true, force: true });
    }
    logDisk(`Moved to trash: ${path.relative(PROJECT_ROOT, filePath)}`);
}

// Keeps a copy of a file in the trash before it is overwritten.
function copyToTrash(filePath) {
    fs.copyFileSync(filePath, trashDestination(filePath));
    logDisk(`Previous version saved to trash: ${path.relative(PROJECT_ROOT, filePath)}`);
}

// Whether a directory entry is what Studio would save for className.
function entryMatchesClass(entryPath, className) {
    let stat;
    try {
        stat = fs.statSync(entryPath);
    } catch {
        return false;
    }
    if (className === 'Folder') return stat.isDirectory();
    if (!stat.isFile()) return false;
    const fileClass = classFromFileName(path.basename(entryPath));
    return fileClass === className || fileClass === ANY_CLASS;
}

// ---------------------------------------------------------------------------
// Long-polling state
// ---------------------------------------------------------------------------
let pendingChanges = [];
let waitingClients = [];
let flushTimer = null;
// Changes are grouped for a short moment so bulk operations (git checkout,
// pull) reach Studio as one batch, where mass-delete protection can see them.
const FLUSH_DELAY_MS = 150;

function flushChanges() {
    flushTimer = null;
    if (pendingChanges.length === 0 || waitingClients.length === 0) return;
    const batch = pendingChanges;
    pendingChanges = [];
    while (waitingClients.length > 0) {
        const clientRes = waitingClients.shift();
        try {
            clientRes.json(batch);
        } catch { /* client may have disconnected */ }
    }
}

function pushChange(change) {
    if (!change) return;
    change.timestamp = Date.now();
    pendingChanges.push(change);
    if (!flushTimer) {
        flushTimer = setTimeout(flushChanges, FLUSH_DELAY_MS);
    }
}

// ---------------------------------------------------------------------------
// Incremental sync — enrich disk changes with instance data
// ---------------------------------------------------------------------------
function readInstanceData(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            return processDirectory(filePath, ROOT_SERVICES.includes(path.basename(filePath)));
        }
        return convertFile(filePath);
    } catch (e) {
        logWarn(`Could not read ${filePath}: ${e.message}`);
        return null;
    }
}

// Returns the change to send to Studio, or null when the file is not synced.
function buildChangePayload(type, filePath, isDirectory = false) {
    const fileName = path.basename(filePath);

    if (!isDirectory && isInitFile(fileName)) {
        // init.lua turns its folder into a script. Adding, editing or removing
        // it changes the folder's instance, never deletes it.
        const dirPath = path.dirname(filePath);
        if (!fs.existsSync(dirPath)) return null;
        return {
            type: 'Changed',
            instancePath: filePathToInstancePath(dirPath, PROJECT_ROOT),
            data: readInstanceData(dirPath),
        };
    }

    const className = isDirectory ? 'Folder' : classFromFileName(fileName);
    if (className === null) return null;

    const instancePath = filePathToInstancePath(filePath, PROJECT_ROOT);
    if (type === 'Removed') {
        const change = { type: 'Removed', instancePath };
        if (className !== ANY_CLASS) change.className = className;
        return change;
    }

    return { type, instancePath, data: readInstanceData(filePath) };
}

// ---------------------------------------------------------------------------
// Chokidar file watcher (Phase 2 - #4: uses project config ignore patterns)
// ---------------------------------------------------------------------------
const ignorePatterns = [
    /(^|[\/\\])\../,           // dotfiles
    /\.conflict\.bak$/,         // conflict backups
    /node_modules/,
];

// Add user-defined ignore patterns from config
if (projectConfig.ignore) {
    for (const pattern of projectConfig.ignore) {
        if (pattern.startsWith('*.')) {
            const ext = pattern.slice(1).replace('.', '\\.');
            ignorePatterns.push(new RegExp(`${ext}$`));
        }
    }
}

const watcher = chokidar.watch(PROJECT_ROOT, {
    ignored: ignorePatterns,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
    },
});

watcher
    .on('add', filePath => {
        if (isIgnored(filePath) || !isDiskPathSynced(filePath)) return;
        logDisk(`File created: ${path.relative(PROJECT_ROOT, filePath)}`);
        getTimestamps(filePath).disk = Date.now();
        pushChange(buildChangePayload('Added', filePath));
    })
    .on('change', filePath => {
        if (isIgnored(filePath) || !isDiskPathSynced(filePath)) return;
        logDisk(`File modified: ${path.relative(PROJECT_ROOT, filePath)}`);
        getTimestamps(filePath).disk = Date.now();
        pushChange(buildChangePayload('Changed', filePath));
    })
    .on('unlink', filePath => {
        if (isIgnored(filePath) || !isDiskPathSynced(filePath)) return;
        logDisk(`File deleted: ${path.relative(PROJECT_ROOT, filePath)}`);
        pushChange(buildChangePayload('Removed', filePath));
        lastWriteTimestamps.delete(path.resolve(filePath));
    })
    .on('addDir', dirPath => {
        if (isIgnored(dirPath) || !isDiskPathSynced(dirPath)) return;
        logDisk(`Folder created: ${path.relative(PROJECT_ROOT, dirPath)}`);
        pushChange(buildChangePayload('Added', dirPath, true));
    })
    .on('unlinkDir', dirPath => {
        if (isIgnored(dirPath) || !isDiskPathSynced(dirPath)) return;
        logDisk(`Folder deleted: ${path.relative(PROJECT_ROOT, dirPath)}`);
        pushChange(buildChangePayload('Removed', dirPath, true));
    });

// ---------------------------------------------------------------------------
// API Endpoints
// ---------------------------------------------------------------------------

app.get('/ping', (req, res) => {
    res.json({
        status: 'ok',
        project: projectConfig.name || path.basename(PROJECT_ROOT),
        version: require('./package.json').version,
        // false until the user picks the services to sync in the plugin
        configured: Array.isArray(projectConfig.services),
        services: projectConfig.services,
        availableServices: ROOT_SERVICES,
    });
});

// POST /config — saves the services chosen in the plugin
app.post('/config', (req, res) => {
    const requested = req.body && req.body.services;
    const services = sanitizeServices(requested);
    if (!services || services.length === 0 || services.length !== requested.length) {
        return res.status(400).json({ error: 'services must be a non-empty list of Roblox services' });
    }
    try {
        saveProjectServices(PROJECT_ROOT, services);
        projectConfig.services = services;
        createServiceFolders(services);
        logServer(`Synced services: ${services.join(', ')}`);
        res.json({ success: true, services });
    } catch (e) {
        logError(`Could not save the project config: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

app.post('/shutdown', (req, res) => {
    res.json({ success: true });
    logServer('Shutdown requested by VS Code extension.');
    setTimeout(() => shutdown('SIGTERM'), 100);
});

app.get('/tree', (req, res) => {
    try {
        const tree = [];
        if (fs.existsSync(PROJECT_ROOT)) {
            const rootFolders = fs.readdirSync(PROJECT_ROOT, { withFileTypes: true });
            for (const folder of rootFolders) {
                // Only service folders are synced; skips node_modules, .git...
                if (folder.isDirectory() && ROOT_SERVICES.includes(folder.name) && isServiceSynced(folder.name)) {
                    const subTree = processDirectory(path.join(PROJECT_ROOT, folder.name), true);
                    tree.push(subTree);
                }
            }
        }
        logStudio('Roblox Studio connected');
        logServer(`Tree sent (${tree.length} services)`);
        res.json(tree);
    } catch (err) {
        logError(`Failed to generate tree: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/changes', (req, res) => {
    // While a flush is scheduled more changes may still join the batch, so the
    // client waits for it instead of taking a partial batch.
    if (pendingChanges.length > 0 && !flushTimer) {
        const changesToSend = [...pendingChanges];
        pendingChanges = [];
        return res.json(changesToSend);
    }

    waitingClients.push(res);

    const timeout = setTimeout(() => {
        const index = waitingClients.indexOf(res);
        if (index !== -1) {
            waitingClients.splice(index, 1);
            res.json([]);
        }
    }, 30000);

    res.on('close', () => {
        clearTimeout(timeout);
        const index = waitingClients.indexOf(res);
        if (index !== -1) {
            waitingClients.splice(index, 1);
        }
    });
});

// Phase 4 - #7: Checksums endpoint for incremental diff
app.get('/checksums', (req, res) => {
    try {
        const checksums = buildChecksums(PROJECT_ROOT);
        res.json(checksums);
    } catch (err) {
        logError(`Failed to build checksums: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ---------------------------------------------------------------------------
// Sanitize filename helper
// ---------------------------------------------------------------------------
function sanitizeFileName(name) {
    const sanitized = String(name).replace(/[<>:"\/\\|?*\x00-\x1f]+/g, '_');
    // "." and ".." would escape the project folder once joined into a path.
    return /^\.+$/.test(sanitized) ? sanitized.replace(/\./g, '_') : sanitized;
}

// Resolves a path and guarantees it stays inside PROJECT_ROOT.
function resolveInsideProject(...parts) {
    const resolved = path.resolve(PROJECT_ROOT, ...parts);
    if (resolved !== PROJECT_ROOT && !resolved.startsWith(PROJECT_ROOT + path.sep)) {
        throw new Error(`Path escapes the project folder: ${parts.join('/')}`);
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// POST /studio-change — Studio reports changes to write to disk
// ---------------------------------------------------------------------------
app.post('/studio-change', (req, res) => {
    const changes = req.body;

    try {
        if (!Array.isArray(changes)) {
            return res.status(400).json({ error: 'Expected an array of changes' });
        }

        for (const change of changes) {
            const pathParts = (change.path || '').split('/').filter(Boolean);
            if (pathParts.length < 1) {
                logWarn('Received change with empty path, skipping.');
                continue;
            }

            // Changes outside the synced services never touch the disk
            if (!isInstancePathSynced(change.path) || (change.oldPath && !isInstancePathSynced(change.oldPath))) {
                continue;
            }

            logStudio(`${change.type} → ${change.path} (${change.className || '?'})`);

            const fileInfo = instanceToFile(change);
            const sanitizedParts = pathParts.map(sanitizeFileName);
            const ancestorParts = sanitizedParts.slice(0, -1);
            const parentDir = resolveInsideProject(...ancestorParts);
            const targetPath = resolveInsideProject(...ancestorParts, sanitizeFileName(fileInfo.fileName));

            // Conflict detection
            if ((change.type === 'Added' || change.type === 'Changed') && !fileInfo.isDirectory) {
                const timestamps = getTimestamps(targetPath);
                const now = Date.now();
                if (timestamps.disk > 0 && (now - timestamps.disk) < 5000 && fs.existsSync(targetPath)) {
                    logConflict(`${path.basename(targetPath)} was edited on both sides.`);
                    createConflictBackup(targetPath);
                }
                timestamps.studio = now;
            }

            // Execute the write
            if (change.type === 'Added' || change.type === 'Changed') {
                // Folders created here must not bounce back to Studio as new
                // instances, so every missing level is marked as our own write.
                const missingDirs = [];
                for (let dir = parentDir; !fs.existsSync(dir) && dir !== PROJECT_ROOT; dir = path.dirname(dir)) {
                    missingDirs.push(dir);
                }
                missingDirs.forEach(markIgnored);
                if (missingDirs.length > 0) {
                    fs.mkdirSync(parentDir, { recursive: true });
                }

                if (fileInfo.isDirectory) {
                    if (!fs.existsSync(targetPath)) {
                        markIgnored(targetPath);
                        fs.mkdirSync(targetPath, { recursive: true });
                        logDisk(`Folder created: ${path.relative(PROJECT_ROOT, targetPath)}`);
                    }
                } else {
                    const content = fileInfo.content || '';
                    const exists = fs.existsSync(targetPath);
                    if (exists && fs.readFileSync(targetPath, 'utf8') === content) {
                        continue;
                    }
                    // "Added" over an existing file with other content (Export,
                    // a pasted script with the same name) keeps the old version.
                    if (exists && change.type === 'Added') {
                        copyToTrash(targetPath);
                    }
                    markIgnored(targetPath);
                    fs.writeFileSync(targetPath, content, 'utf8');
                    logDisk(`Written: ${path.relative(PROJECT_ROOT, targetPath)}`);
                }
            } else if (change.type === 'Removed') {
                const className = change.className || 'Folder';
                let victim = entryMatchesClass(targetPath, className) ? targetPath : null;
                if (!victim && fs.existsSync(parentDir)) {
                    // Same instance saved with another extension (.luau, .model.json)
                    const baseName = sanitizeFileName(change.name || pathParts[pathParts.length - 1]);
                    const sibling = fs.readdirSync(parentDir).find(entry =>
                        stripExtension(entry) === baseName &&
                        entryMatchesClass(resolveInsideProject(...ancestorParts, entry), className));
                    if (sibling) victim = resolveInsideProject(...ancestorParts, sibling);
                }
                if (victim) {
                    moveToTrash(victim);
                }
            } else if (change.type === 'Renamed') {
                const oldParts = (change.oldPath || '').split('/').filter(Boolean).map(sanitizeFileName);
                if (oldParts.length > 0) {
                    const oldAncestors = oldParts.slice(0, -1);
                    const oldDir = resolveInsideProject(...oldAncestors);
                    const oldName = oldParts[oldParts.length - 1];
                    const className = change.className || 'Folder';
                    const sibling = fs.existsSync(oldDir) && fs.readdirSync(oldDir).find(entry =>
                        stripExtension(entry) === oldName &&
                        entryMatchesClass(resolveInsideProject(...oldAncestors, entry), className));
                    if (sibling) {
                        const oldPath = resolveInsideProject(...oldAncestors, sibling);
                        // On Windows "script" → "Script" is the same file; don't trash it.
                        const sameFile = oldPath.toLowerCase() === targetPath.toLowerCase();
                        try {
                            if (!sameFile && fs.existsSync(targetPath)) {
                                moveToTrash(targetPath);
                            }
                            if (!fs.existsSync(parentDir)) {
                                markIgnored(parentDir);
                                fs.mkdirSync(parentDir, { recursive: true });
                            }
                            markIgnored(oldPath);
                            markIgnored(targetPath);
                            fs.renameSync(oldPath, targetPath);
                            logDisk(`Renamed: ${sibling} → ${fileInfo.fileName}`);
                        } catch (e) {
                            logError(`Rename failed: ${e.message}`);
                        }
                    }
                }
            }
        }

        res.json({ success: true });
    } catch (e) {
        logError(`Processing studio changes: ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
    logServer(`${signal} received. Closing SyncRbx...`);
    watcher.close().then(() => {
        logServer('File watcher closed.');
        process.exit(0);
    });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
function startServer() {
    if (projectConfig.services) {
        createServiceFolders(projectConfig.services);
    }

    const server = app.listen(PORT, HOST, () => {
        console.log('');
        console.log(c.bold(c.green('  ╔══════════════════════════════════════════╗')));
        console.log(c.bold(c.green('  ║          🌿  SYNCRBX v' + require('./package.json').version + '  🌿          ║')));
        console.log(c.bold(c.green('  ╚══════════════════════════════════════════╝')));
        console.log('');
        logServer(`Server at ${c.bold(`${HOST}:${PORT}`)}`);
        logServer(`Project: ${c.cyan(projectConfig.name)}`);
        logServer(`Monitoring: ${c.cyan(PROJECT_ROOT)}`);
        if (projectConfig.services) {
            logServer(`Syncing: ${c.cyan(projectConfig.services.join(', '))}`);
        } else {
            logServer(`No services chosen yet: pick them in the Studio plugin when you connect.`);
        }
        logServer(`Waiting for connection from Roblox Studio...`);
        console.log('');
    });

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            logError(`Port ${PORT} is already in use. Is another SyncRbx server running?`);
            logError(`Close the other server or change the port in config.json`);
            process.exit(1);
        } else {
            logError(`Fatal error: ${e.message}`);
            process.exit(1);
        }
    });
}

module.exports = { startServer };
