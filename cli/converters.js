const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Known Roblox services that map as root containers
// ---------------------------------------------------------------------------
const ROOT_SERVICES = [
    'Workspace', 'Players', 'Lighting', 'MaterialService',
    'ReplicatedFirst', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage',
    'StarterGui', 'StarterPack', 'StarterPlayer',
    'SoundService', 'Chat', 'TextChatService', 'LocalizationService', 'TestService'
];

// Sub-services that live inside StarterPlayer (Phase 1 - Bug #2)
const STARTER_PLAYER_CHILDREN = ['StarterPlayerScripts', 'StarterCharacterScripts'];

// Known file extensions (order matters — longest first so we match greedily)
const KNOWN_EXTENSIONS = [
    '.server.lua', '.server.luau',
    '.client.lua', '.client.luau',
    '.model.json', '.meta.json',
    '.remoteevent', '.remotefunction',
    '.bindableevent', '.bindablefunction',
    '.lua', '.luau',
    '.txt', '.json'
];

// Phase 2 - #5: More instance types via model.json
const VALUE_CLASSES = {
    IntValue: 'number',
    NumberValue: 'number',
    BoolValue: 'boolean',
    StringValue: 'string',
    Color3Value: 'color3',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripExtension(filename) {
    const lowerFilename = filename.toLowerCase();
    for (const ext of KNOWN_EXTENSIONS) {
        if (lowerFilename.endsWith(ext.toLowerCase())) {
            return filename.slice(0, -ext.length);
        }
    }
    const lastDot = filename.lastIndexOf('.');
    return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}

function getMetaProperties(metaFilePath) {
    if (fs.existsSync(metaFilePath)) {
        try {
            return JSON.parse(fs.readFileSync(metaFilePath, 'utf8'));
        } catch (e) {
            console.error(`[WARN] Error parsing meta file ${metaFilePath}:`, e.message);
        }
    }
    return {};
}

function determineScriptType(filename) {
    if (filename.endsWith('.server.lua') || filename.endsWith('.server.luau')) return 'Script';
    if (filename.endsWith('.client.lua') || filename.endsWith('.client.luau')) return 'LocalScript';
    if (filename.endsWith('.lua') || filename.endsWith('.luau')) return 'ModuleScript';
    return null;
}

// Class a file becomes in Studio, judged by its name alone (the file may
// already be deleted). Returns ANY_CLASS for .model.json, whose class is inside
// the file, and null for files SyncRbx does not sync (README.md, meta files...).
const ANY_CLASS = '*';

function classFromFileName(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.meta.json') || lower === 'meta.json') return null;
    if (lower.endsWith('.model.json')) return ANY_CLASS;
    if (lower.endsWith('.remoteevent')) return 'RemoteEvent';
    if (lower.endsWith('.remotefunction')) return 'RemoteFunction';
    if (lower.endsWith('.bindableevent')) return 'BindableEvent';
    if (lower.endsWith('.bindablefunction')) return 'BindableFunction';
    if (lower.endsWith('.txt')) return 'StringValue';
    if (lower.endsWith('.json')) return 'ModuleScript';
    return determineScriptType(lower);
}

function isInitFile(filename) {
    return filename.startsWith('init.') && (filename.endsWith('.lua') || filename.endsWith('.luau'));
}

// Phase 4 - #7: File checksum
function fileChecksum(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return crypto.createHash('md5').update(content).digest('hex');
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// JSON → Lua table conversion
// ---------------------------------------------------------------------------
function jsonToLuaTable(value, indent) {
    indent = indent || 0;
    const pad = '\t'.repeat(indent);
    const padInner = '\t'.repeat(indent + 1);

    if (value === null || value === undefined) return 'nil';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'string') {
        const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
        return `"${escaped}"`;
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return '{}';
        const items = value.map(v => `${padInner}${jsonToLuaTable(v, indent + 1)}`);
        return `{\n${items.join(',\n')}\n${pad}}`;
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) return '{}';
        const entries = keys.map(k => {
            const luaKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) ? k : `["${k}"]`;
            return `${padInner}${luaKey} = ${jsonToLuaTable(value[k], indent + 1)}`;
        });
        return `{\n${entries.join(',\n')}\n${pad}}`;
    }
    return 'nil';
}

// ---------------------------------------------------------------------------
// File → Instance conversion
// ---------------------------------------------------------------------------
function convertFile(filePath) {
    const filename = path.basename(filePath);
    let content;
    try {
        content = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
        console.error(`[WARN] Could not read file ${filePath}:`, e.message);
        return null;
    }

    const name = stripExtension(filename);

    let instance = {
        Name: name,
        ClassName: 'Unknown',
        Properties: {},
        Children: []
    };

    if (filename.endsWith('.model.json')) {
        try {
            const parsed = JSON.parse(content);
            instance.ClassName = parsed.ClassName || 'Folder';
            instance.Properties = parsed.Properties || {};
            if (parsed.Name) instance.Name = parsed.Name;
            if (parsed.Children && Array.isArray(parsed.Children)) {
                instance.Children = parsed.Children;
            }
        } catch (e) {
            console.error(`[WARN] Error parsing model file ${filePath}:`, e.message);
        }
    } else if (filename.toLowerCase().endsWith('.remoteevent')) {
        instance.ClassName = 'RemoteEvent';
    } else if (filename.toLowerCase().endsWith('.remotefunction')) {
        instance.ClassName = 'RemoteFunction';
    } else if (filename.toLowerCase().endsWith('.bindableevent')) {
        instance.ClassName = 'BindableEvent';
    } else if (filename.toLowerCase().endsWith('.bindablefunction')) {
        instance.ClassName = 'BindableFunction';
    } else if (filename.endsWith('.txt')) {
        instance.ClassName = 'StringValue';
        instance.Properties.Value = content;
    } else if (filename.endsWith('.json') && !filename.endsWith('.meta.json')) {
        try {
            const parsed = JSON.parse(content);
            instance.ClassName = 'ModuleScript';
            instance.Properties.Source = `return ${jsonToLuaTable(parsed)}`;
        } catch (e) {
            console.error(`[WARN] Error parsing JSON data file ${filePath}:`, e.message);
            instance.ClassName = 'ModuleScript';
            instance.Properties.Source = `-- ERROR: Could not parse JSON\nreturn nil`;
        }
    } else {
        const scriptType = determineScriptType(filename);
        if (scriptType) {
            instance.ClassName = scriptType;
            instance.Properties.Source = content;
        }
    }

    return instance;
}

// ---------------------------------------------------------------------------
// Directory → Instance tree (recursive)
// ---------------------------------------------------------------------------
function processDirectory(dirPath, isRoot = false) {
    const dirName = path.basename(dirPath);

    let className = 'Folder';
    if (isRoot && ROOT_SERVICES.includes(dirName)) {
        className = dirName;
    } else if (STARTER_PLAYER_CHILDREN.includes(dirName)) {
        // Phase 1 - Bug #2: Identify these as their proper class
        className = dirName;
    }

    let instance = {
        Name: dirName,
        ClassName: className,
        Properties: {},
        Children: []
    };

    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (e) {
        console.error(`[WARN] Could not read directory ${dirPath}:`, e.message);
        return instance;
    }

    // Handle init.lua / init.server.lua / init.client.lua
    const initFile = entries.find(e =>
        e.isFile() && e.name.startsWith('init.') &&
        (e.name.endsWith('.lua') || e.name.endsWith('.luau'))
    );
    if (initFile) {
        const scriptType = determineScriptType(initFile.name);
        if (scriptType && instance.ClassName === 'Folder') {
            instance.ClassName = scriptType;
            try {
                instance.Properties.Source = fs.readFileSync(path.join(dirPath, initFile.name), 'utf8');
            } catch (e) {
                console.error(`[WARN] Could not read init file:`, e.message);
            }
        }
    }

    // Handle meta.json inside the folder
    const metaInside = entries.find(e => e.isFile() && e.name === 'meta.json');
    if (metaInside) {
        const metaProps = getMetaProperties(path.join(dirPath, 'meta.json'));
        instance.Properties = { ...instance.Properties, ...metaProps };
    }

    // Process children
    for (const entry of entries) {
        if (entry.name === 'meta.json' || entry.name.endsWith('.meta.json') || entry.name.startsWith('init.')) {
            continue;
        }

        const entryPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            const childInstance = processDirectory(entryPath, false);
            const metaFileOutside = entries.find(e => e.isFile() && e.name === `${entry.name}.meta.json`);
            if (metaFileOutside) {
                const metaProps = getMetaProperties(path.join(dirPath, metaFileOutside.name));
                childInstance.Properties = { ...childInstance.Properties, ...metaProps };
            }
            instance.Children.push(childInstance);
        } else if (entry.isFile()) {
            const childInstance = convertFile(entryPath);
            if (childInstance && childInstance.ClassName !== 'Unknown') {
                const metaFileName = `${entry.name}.meta.json`;
                const metaFile = entries.find(e => e.isFile() && e.name === metaFileName);
                if (metaFile) {
                    const metaProps = getMetaProperties(path.join(dirPath, metaFileName));
                    childInstance.Properties = { ...childInstance.Properties, ...metaProps };
                }
                instance.Children.push(childInstance);
            }
        }
    }

    return instance;
}

// ---------------------------------------------------------------------------
// Phase 4 - #7: Build checksums map for the entire project
// ---------------------------------------------------------------------------
function buildChecksums(dirPath, prefix = '') {
    const checksums = {};
    let entries;
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
        return checksums;
    }

    for (const entry of entries) {
        if (entry.name.endsWith('.conflict.bak') || entry.name.endsWith('.meta.json')) continue;
        const entryPath = path.join(dirPath, entry.name);
        const instancePath = prefix ? `${prefix}/${stripExtension(entry.name)}` : stripExtension(entry.name);

        if (entry.isDirectory()) {
            Object.assign(checksums, buildChecksums(entryPath, prefix ? `${prefix}/${entry.name}` : entry.name));
        } else if (entry.isFile()) {
            const checksum = fileChecksum(entryPath);
            if (checksum) {
                checksums[instancePath] = checksum;
            }
        }
    }
    return checksums;
}

// ---------------------------------------------------------------------------
// Instance → File (inverse conversion for Studio → Disk)
// ---------------------------------------------------------------------------
function instanceToFile(instanceData) {
    const name = instanceData.name || instanceData.Name || 'Untitled';
    const className = instanceData.className || instanceData.ClassName || 'Folder';
    const source = instanceData.source || (instanceData.Properties && instanceData.Properties.Source) || '';
    // ?? keeps false and 0, which || would turn into ''.
    const value = instanceData.value ?? (instanceData.Properties && instanceData.Properties.Value) ?? '';

    if (className === 'Folder') {
        return { fileName: name, content: null, isDirectory: true };
    }
    if (className === 'Script') {
        return { fileName: `${name}.server.lua`, content: source, isDirectory: false };
    }
    if (className === 'LocalScript') {
        return { fileName: `${name}.client.lua`, content: source, isDirectory: false };
    }
    if (className === 'ModuleScript') {
        return { fileName: `${name}.lua`, content: source, isDirectory: false };
    }
    if (className === 'StringValue') {
        return { fileName: `${name}.txt`, content: value, isDirectory: false };
    }
    if (className === 'RemoteEvent') {
        return { fileName: `${name}.remoteevent`, content: '', isDirectory: false };
    }
    if (className === 'RemoteFunction') {
        return { fileName: `${name}.remotefunction`, content: '', isDirectory: false };
    }
    if (className === 'BindableEvent') {
        return { fileName: `${name}.bindableevent`, content: '', isDirectory: false };
    }
    if (className === 'BindableFunction') {
        return { fileName: `${name}.bindablefunction`, content: '', isDirectory: false };
    }

    // Phase 2 - #5: Value types and other instances → .model.json
    if (VALUE_CLASSES[className] !== undefined) {
        const modelData = { ClassName: className, Properties: { Value: value } };
        return { fileName: `${name}.model.json`, content: JSON.stringify(modelData, null, 2), isDirectory: false };
    }

    // Generic instance → .model.json
    const modelData = { ClassName: className, Properties: {} };
    if (instanceData.Properties) {
        modelData.Properties = { ...instanceData.Properties };
    }
    return { fileName: `${name}.model.json`, content: JSON.stringify(modelData, null, 2), isDirectory: false };
}

function filePathToInstancePath(filePath, projectRoot) {
    let relative = path.relative(projectRoot, filePath).replace(/\\/g, '/');
    const parts = relative.split('/');
    if (parts.length > 0) {
        const last = parts[parts.length - 1];
        if (last.startsWith('init.') && (last.endsWith('.lua') || last.endsWith('.luau'))) {
            parts.pop();
        } else {
            parts[parts.length - 1] = stripExtension(last);
        }
    }
    return parts.join('/');
}

// ---------------------------------------------------------------------------
// Phase 2 - #4: Project config loader
// ---------------------------------------------------------------------------
const PROJECT_CONFIG_FILE = 'syncrbx.project.json';

// Keeps only known Roblox services, without duplicates. Returns null when the
// value is not a list, meaning "not chosen yet".
function sanitizeServices(services) {
    if (!Array.isArray(services)) return null;
    return [...new Set(services.filter(s => typeof s === 'string' && ROOT_SERVICES.includes(s)))];
}

function readProjectConfigFile(projectRoot) {
    const configPath = path.join(projectRoot, PROJECT_CONFIG_FILE);
    if (!fs.existsSync(configPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
        console.error(`[WARN] Error parsing ${PROJECT_CONFIG_FILE}: ${e.message}`);
        return {};
    }
}

function loadProjectConfig(projectRoot) {
    const defaults = {
        name: path.basename(projectRoot),
        port: 34872,
        ignore: ['*.conflict.bak', 'node_modules', '.git', '.vscode'],
        tree: null, // null = auto-detect from folder names
        services: null, // null = the user has not chosen which services to sync
    };
    const config = { ...defaults, ...readProjectConfigFile(projectRoot) };
    config.services = sanitizeServices(config.services);
    return config;
}

// Saves the chosen services, keeping any other settings already in the file.
function saveProjectServices(projectRoot, services) {
    const config = readProjectConfigFile(projectRoot);
    config.services = services;
    fs.writeFileSync(path.join(projectRoot, PROJECT_CONFIG_FILE), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

module.exports = {
    ROOT_SERVICES,
    STARTER_PLAYER_CHILDREN,
    KNOWN_EXTENSIONS,
    VALUE_CLASSES,
    ANY_CLASS,
    stripExtension,
    determineScriptType,
    classFromFileName,
    isInitFile,
    jsonToLuaTable,
    convertFile,
    processDirectory,
    buildChecksums,
    instanceToFile,
    filePathToInstancePath,
    getMetaProperties,
    loadProjectConfig,
    saveProjectServices,
    sanitizeServices,
    PROJECT_CONFIG_FILE,
    fileChecksum,
};
