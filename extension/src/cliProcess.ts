import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface SyncRbxInvocation {
    command: string;
    args: string[];
}

function getPathVariable(env: NodeJS.ProcessEnv): string {
    // Windows environment keys are case-insensitive ("Path" vs "PATH").
    const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
    return key ? env[key] || '' : '';
}

// Finds the JavaScript entry point behind the npm "syncrbx.cmd" shim.
function findWindowsCliScript(env: NodeJS.ProcessEnv): { binDirectory: string; script: string } | undefined {
    for (const directory of getPathVariable(env).split(path.win32.delimiter)) {
        if (!directory || !fs.existsSync(path.join(directory, 'syncrbx.cmd'))) {
            continue;
        }
        const packageDirectory = path.join(directory, 'node_modules', 'syncrbx');
        try {
            const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
            const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.syncrbx;
            if (bin) {
                return { binDirectory: directory, script: path.join(packageDirectory, bin) };
            }
        } catch {
            // Not an npm-installed CLI, keep looking.
        }
    }
    return undefined;
}

// Builds the command used to run the CLI without a shell. On Windows the npm
// shim is a .cmd file, which can only run through cmd.exe, and cmd.exe would
// interpret characters such as & | % in commit messages. Running the CLI's
// JavaScript entry point with Node avoids the shell entirely.
export function buildSyncRbxInvocation(
    args: string[],
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    nodePath?: string,
): SyncRbxInvocation {
    if (platform !== 'win32') {
        return { command: 'syncrbx', args };
    }

    const cli = findWindowsCliScript(env);
    if (!cli) {
        throw new Error('SyncRbx CLI not found. Install it with "npm install -g syncrbx".');
    }

    // Same lookup as the npm shim: a node.exe next to it, otherwise node from PATH.
    const bundledNode = path.join(cli.binDirectory, 'node.exe');
    const command = nodePath || (fs.existsSync(bundledNode) ? bundledNode : 'node');
    return { command, args: [cli.script, ...args] };
}

export function spawnSyncRbx(
    args: string[],
    cwd: string,
): childProcess.ChildProcessWithoutNullStreams {
    const invocation = buildSyncRbxInvocation(args);
    return childProcess.spawn(invocation.command, invocation.args, {
        cwd,
        env: process.env,
        windowsHide: true,
        shell: false,
        stdio: 'pipe',
    });
}
