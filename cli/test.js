// End-to-end checks for the local sync server, simulating Roblox Studio.
// Usage: npm test. Uses its own port (34999) so a running SyncRbx server doesn't interfere.
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(os.tmpdir(), `syncrbx-test-${process.pid}`);
const CLI = path.join(__dirname, 'cli.js');
const TEST_PORT = 34999;
const URL = `http://127.0.0.1:${TEST_PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(name, ok, extra = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -> ' + extra : ''}`);
    if (!ok) failures++;
}
const studio = changes => fetch(`${URL}/studio-change`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
}).then(r => r.json());
async function changes(timeoutMs = 1500) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await (await fetch(`${URL}/changes`, { signal: ctrl.signal })).json();
    } catch { return null; } finally { clearTimeout(t); }
}
const p = (...parts) => path.join(ROOT, ...parts);
const trashFiles = () => {
    const out = [];
    const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true })
        .forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.relative(p('.syncrbx', 'trash'), path.join(d, e.name))));
    walk(p('.syncrbx', 'trash'));
    return out;
};

(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    fs.mkdirSync(ROOT);
    fs.writeFileSync(path.join(ROOT, 'syncrbx.project.json'), JSON.stringify({ port: TEST_PORT }));
    const server = spawn(process.execPath, [CLI, 'serve'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    server.stdout.on('data', d => log += d);
    server.stderr.on('data', d => log += d);
    // Wait for *this* server: an older SyncRbx bound to 0.0.0.0 can answer on the same port.
    const ROOT_NAME = path.basename(ROOT);
    for (let i = 0; i < 40; i++) {
        try {
            const pong = await (await fetch(`${URL}/ping`)).json();
            if (pong.project === ROOT_NAME) break;
        } catch { /* not up yet */ }
        await sleep(250);
    }
    await sleep(800); // let chokidar settle

    // 0. Choosing the synced services.
    const config = body => fetch(`${URL}/config`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    let ping = await (await fetch(`${URL}/ping`)).json();
    check('new project is not configured', ping.configured === false, JSON.stringify(ping));
    check('no service folders created before choosing', !fs.existsSync(p('Workspace')) && !fs.existsSync(p('StarterGui')));
    check('unknown service rejected', (await config({ services: ['Workspace', 'NotAService'] })).status === 400);
    check('empty selection rejected', (await config({ services: [] })).status === 400);
    const SERVICES = ['Workspace', 'ReplicatedStorage', 'ServerScriptService', 'ServerStorage'];
    check('valid selection saved', (await config({ services: SERVICES })).status === 200);
    const saved = JSON.parse(fs.readFileSync(p('syncrbx.project.json'), 'utf8'));
    check('selection written to syncrbx.project.json', JSON.stringify(saved.services) === JSON.stringify(SERVICES), JSON.stringify(saved));
    check('only chosen folders created', fs.existsSync(p('Workspace')) && !fs.existsSync(p('StarterGui')));
    ping = await (await fetch(`${URL}/ping`)).json();
    check('ping reports the services', ping.configured === true && ping.services.length === 4);
    await sleep(600); await changes(800);

    // 0b. Nothing outside the chosen services is touched.
    await studio([{ type: 'Added', path: 'StarterGui/Menu', className: 'LocalScript', name: 'Menu', source: 'print(2)' }]);
    check('Studio change in unsynced service ignored', !fs.existsSync(p('StarterGui')));
    fs.mkdirSync(p('StarterGui'));
    fs.writeFileSync(p('StarterGui', 'Hud.lua'), 'return 1');
    await sleep(900);
    let ch0 = await changes(1000);
    check('disk change in unsynced service ignored', ch0 === null || ch0.length === 0, JSON.stringify(ch0));

    // 1. Script added inside a Model: the folder the server creates must NOT
    //    come back to Studio as a new Folder instance.
    await studio([{ type: 'Added', path: 'Workspace/Puerta/Abrir', className: 'Script', name: 'Abrir', source: 'print(1)' }]);
    check('script inside Model written', fs.existsSync(p('Workspace', 'Puerta', 'Abrir.server.lua')));
    let ch = await changes(1500);
    check('no echo of created folder to Studio', ch === null || ch.length === 0, JSON.stringify(ch));

    // 2. Removing a Folder must not delete a ModuleScript with the same name.
    fs.writeFileSync(p('ReplicatedStorage', 'Utils.lua'), 'return {}');
    await sleep(600); await changes(800);
    await studio([{ type: 'Removed', path: 'ReplicatedStorage/Utils', className: 'Folder', name: 'Utils' }]);
    check('Folder removal keeps same-named ModuleScript', fs.existsSync(p('ReplicatedStorage', 'Utils.lua')));

    // 3. Real removal goes to the trash.
    await studio([{ type: 'Removed', path: 'ReplicatedStorage/Utils', className: 'ModuleScript', name: 'Utils' }]);
    check('ModuleScript removal deletes file', !fs.existsSync(p('ReplicatedStorage', 'Utils.lua')));
    check('removed file is in trash', trashFiles().some(f => f.endsWith(path.join('ReplicatedStorage', 'Utils.lua'))), trashFiles().join(','));

    // 4. "Added" over an existing file with other content keeps the old version.
    fs.writeFileSync(p('ServerScriptService', 'Main.server.lua'), 'print("disk version")');
    await sleep(600); await changes(800);
    await studio([{ type: 'Added', path: 'ServerScriptService/Main', className: 'Script', name: 'Main', source: 'print("studio version")' }]);
    check('overwrite writes new content', fs.readFileSync(p('ServerScriptService', 'Main.server.lua'), 'utf8').includes('studio version'));
    check('overwritten version kept in trash', trashFiles().some(f => f.endsWith('Main.server.lua')));

    // 5. false / 0 values survive.
    await studio([
        { type: 'Added', path: 'ReplicatedStorage/Flag', className: 'BoolValue', name: 'Flag', value: false },
        { type: 'Added', path: 'ReplicatedStorage/Count', className: 'IntValue', name: 'Count', value: 0 },
    ]);
    const flag = JSON.parse(fs.readFileSync(p('ReplicatedStorage', 'Flag.model.json'), 'utf8'));
    const count = JSON.parse(fs.readFileSync(p('ReplicatedStorage', 'Count.model.json'), 'utf8'));
    check('BoolValue false preserved', flag.Properties.Value === false, JSON.stringify(flag.Properties));
    check('IntValue 0 preserved', count.Properties.Value === 0, JSON.stringify(count.Properties));

    // 6. Disk files that are not synced never reach Studio.
    await sleep(600); await changes(800);
    fs.writeFileSync(p('Workspace', 'README.md'), '# hi');
    fs.writeFileSync(p('Workspace', 'Thing.meta.json'), '{}');
    await sleep(900);
    ch = await changes(1000);
    check('README/meta files ignored', ch === null || ch.length === 0, JSON.stringify(ch));
    fs.unlinkSync(p('Workspace', 'README.md'));
    await sleep(900);
    ch = await changes(1000);
    check('deleting README does not send a removal', ch === null || ch.length === 0, JSON.stringify(ch));

    // 7. init.server.lua added: folder becomes a Script (Changed), not a Script named "init".
    fs.mkdirSync(p('ServerScriptService', 'Tool'));
    await sleep(900); await changes(1000);
    fs.writeFileSync(p('ServerScriptService', 'Tool', 'init.server.lua'), 'print("tool")');
    await sleep(900);
    ch = await changes(1500) || [];
    const init = ch.find(c => c.instancePath === 'ServerScriptService/Tool');
    check('init file sends Changed for its folder', init && init.type === 'Changed' && init.data.ClassName === 'Script', JSON.stringify(ch));
    check('no instance named "init"', !ch.some(c => /\/init$/.test(c.instancePath)));

    // 8. Removals carry the class so Studio can check it.
    fs.unlinkSync(p('Workspace', 'Puerta', 'Abrir.server.lua'));
    await sleep(900);
    ch = await changes(1500) || [];
    const rem = ch.find(c => c.type === 'Removed');
    check('file removal includes className', rem && rem.className === 'Script', JSON.stringify(ch));

    // 9. Bulk delete arrives as a single batch (mass-delete protection needs it).
    fs.mkdirSync(p('ServerStorage', 'Bulk'));
    for (let i = 0; i < 30; i++) fs.writeFileSync(p('ServerStorage', 'Bulk', `M${i}.lua`), 'return 1');
    await sleep(1500);
    while ((await changes(800))?.length) { /* drain */ }
    for (let i = 0; i < 30; i++) fs.unlinkSync(p('ServerStorage', 'Bulk', `M${i}.lua`));
    await sleep(1500);
    ch = await changes(1500) || [];
    check('30 deletions in one batch', ch.filter(c => c.type === 'Removed').length === 30, `got ${ch.length}`);

    // 10. Case-only rename on Windows keeps the file.
    await studio([{ type: 'Added', path: 'ServerScriptService/lower', className: 'ModuleScript', name: 'lower', source: 'return 2' }]);
    await studio([{ type: 'Renamed', path: 'ServerScriptService/Lower', oldPath: 'ServerScriptService/lower', className: 'ModuleScript', name: 'Lower' }]);
    const names = fs.readdirSync(p('ServerScriptService'));
    check('case-only rename keeps file', names.includes('Lower.lua'), names.join(','));

    // 11. Renaming a Model container renames its folder.
    await studio([{ type: 'Added', path: 'Workspace/Npc/Brain', className: 'Script', name: 'Brain', source: '' }]);
    await studio([{ type: 'Renamed', path: 'Workspace/Npc2', oldPath: 'Workspace/Npc', className: 'Folder', name: 'Npc2' }]);
    check('container rename moves folder', fs.existsSync(p('Workspace', 'Npc2', 'Brain.server.lua')) && !fs.existsSync(p('Workspace', 'Npc')));

    // 12. /tree only contains services.
    fs.mkdirSync(p('node_modules', 'x'), { recursive: true });
    const tree = await (await fetch(`${URL}/tree`)).json();
    check('/tree only has the chosen services', tree.map(n => n.Name).sort().join(',') === [...SERVICES].sort().join(','), tree.map(n => n.Name).join(','));

    await fetch(`${URL}/shutdown`, { method: 'POST' });
    await sleep(500);
    server.kill();
    fs.rmSync(ROOT, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
    if (failures) console.log(log.replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(-40).join('\n'));
    process.exit(failures ? 1 : 0);
})();
