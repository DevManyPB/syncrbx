/**
 * build.js — Compiles the modular plugin (plugin/src) into a single script.
 *
 * Usage: node plugin/build.js
 * Output: plugin/dist/SyncPlugin.lua (ready to paste into Studio)
 *         plugin/dist/SyncRbx.rbxmx  (drop it into your Studio Plugins folder)
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
fs.mkdirSync(DIST, { recursive: true });
const OUT = path.join(DIST, 'SyncPlugin.lua');
const OUT_RBXMX = path.join(DIST, 'SyncRbx.rbxmx');

// Read all module files in dependency order
const modules = {
    'Utils.Constants': fs.readFileSync(path.join(SRC, 'Utils', 'Constants.lua'), 'utf8'),
    'Utils.Logger': fs.readFileSync(path.join(SRC, 'Utils', 'Logger.lua'), 'utf8'),
    'Core.Net': fs.readFileSync(path.join(SRC, 'Core', 'Net.lua'), 'utf8'),
    'Core.InstanceTracker': fs.readFileSync(path.join(SRC, 'Core', 'InstanceTracker.lua'), 'utf8'),
    'Core.SyncEngine': fs.readFileSync(path.join(SRC, 'Core', 'SyncEngine.lua'), 'utf8'),
    'UI.SyncRbxWidget': fs.readFileSync(path.join(SRC, 'UI', 'SyncRbxWidget.lua'), 'utf8'),
};

const mainSource = fs.readFileSync(path.join(SRC, 'Main.server.lua'), 'utf8');

// Build the bundled output
let output = `--[[\n    SyncRbx Plugin — Auto-generated bundle\n    DO NOT EDIT — Edit the source files in plugin/src/ instead.\n    Built: ${new Date().toISOString()}\n--]]\n\n`;

// Create a module loader
output += `local _modules = {}\nlocal _loaded = {}\n\n`;
output += `local function _require(name)\n    if _loaded[name] then return _loaded[name] end\n    local loader = _modules[name]\n    if not loader then error("Module not found: " .. name) end\n    _loaded[name] = loader()\n    return _loaded[name]\nend\n\n`;

// Register each module
for (const [name, source] of Object.entries(modules)) {
    // Replace require() calls with our bundled _require()
    let processed = source;
    
    // Replace patterns like: require(script.Parent.Parent.Utils.Constants)
    // with: _require("Utils.Constants")
    processed = processed.replace(
        /require\(script\.Parent\.Parent\.([A-Za-z.]+)\)/g,
        (match, modPath) => `_require("${modPath}")`
    );
    processed = processed.replace(
        /require\(script\.Parent\.([A-Za-z.]+)\)/g,
        (match, modPath) => {
            // Determine the parent module's package
            const parentPkg = name.split('.')[0];
            return `_require("${parentPkg}.${modPath}")`;
        }
    );

    output += `_modules["${name}"] = function()\n`;
    // Indent the module source
    const lines = processed.split('\n');
    for (const line of lines) {
        // Skip "return X" at the end - we'll handle it
        output += `    ${line}\n`;
    }
    output += `end\n\n`;
}

// Process Main entry point
let mainProcessed = mainSource;
mainProcessed = mainProcessed.replace(
    /require\(script\.Parent\.([A-Za-z.]+)\)/g,
    (match, modPath) => `_require("${modPath}")`
);

output += `-- Main Entry Point\n`;
output += mainProcessed;
output += '\n';

fs.writeFileSync(OUT, output, 'utf8');

// "]]>" inside the source would close the CDATA section early.
const cdataSource = output.replace(/\]\]>/g, ']]]]><![CDATA[>');
const rbxmx = `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">
	<Meta name="ExplicitAutoJoints">true</Meta>
	<External>null</External>
	<External>nil</External>
	<Item class="Script" referent="RBX1">
		<Properties>
			<BinaryString name="AttributesSerialize"></BinaryString>
			<bool name="Disabled">false</bool>
			<Content name="LinkedSource"><null></null></Content>
			<string name="Name">SyncRbxPlugin</string>
			<string name="ScriptGuid">{11111111-1111-1111-1111-111111111111}</string>
			<ProtectedString name="Source"><![CDATA[
${cdataSource}
]]></ProtectedString>
		</Properties>
	</Item>
</roblox>`;
fs.writeFileSync(OUT_RBXMX, rbxmx, 'utf8');
console.log(`✅ Built successfully: ${OUT_RBXMX}`);
console.log(`✅ Built successfully: ${OUT}`);
console.log(`   Size: ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
console.log(`   Modules: ${Object.keys(modules).length}`);
