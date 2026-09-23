const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { buildSyncRbxInvocation, spawnSyncRbx } = require('../out/cliProcess');

test('uses the CLI directly on non-Windows platforms', () => {
    const invocation = buildSyncRbxInvocation(['push', 'release notes'], 'linux', {});

    assert.equal(invocation.command, 'syncrbx');
    assert.deepEqual(invocation.args, ['push', 'release notes']);
});

test('resolves the npm CLI entry point directly on Windows', () => {
    const cliArgs = ['push', 'quotes " & | $() %PATH%'];
    const fixtureDirectory = path.join(__dirname, 'fixtures', 'windows-bin');
    const invocation = buildSyncRbxInvocation(
        cliArgs,
        'win32',
        { PATH: fixtureDirectory },
        process.execPath,
    );

    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.args[0].endsWith(path.join('syncrbx', 'cli.js')), true);
    assert.deepEqual(invocation.args.slice(1), cliArgs);
});

test('launches the resolved npm CLI with Windows arguments intact', { skip: process.platform !== 'win32' }, async () => {
    const fixtureDirectory = path.join(__dirname, 'fixtures', 'windows-bin');
    const originalPath = process.env.PATH;
    process.env.PATH = `${fixtureDirectory};${originalPath || ''}`;

    try {
        const cliArgs = ['push', 'quotes " & | $() %PATH%'];
        const process = spawnSyncRbx(cliArgs, __dirname);
        let stdout = '';
        let stderr = '';

        process.stdout.on('data', data => {
            stdout += data.toString();
        });
        process.stderr.on('data', data => {
            stderr += data.toString();
        });

        const code = await new Promise((resolve, reject) => {
            process.on('error', reject);
            process.on('close', resolve);
        });

        assert.equal(code, 0, stderr);
        assert.deepEqual(
            stdout.trim().split(/\r?\n/).map(value => Buffer.from(value, 'base64').toString('utf8')),
            cliArgs,
        );
    } finally {
        process.env.PATH = originalPath;
    }
});
