import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { SyncRbxSidebarProvider } from './SyncRbxSidebarProvider';
import { spawnSyncRbx } from './cliProcess';

let serverProcess: child_process.ChildProcess | null = null;
let isExternallyRunning = false;
let statusBarItem: vscode.StatusBarItem;
const SERVER_PORT = 34872;

function checkServerRunning(): Promise<boolean> {
    return new Promise(resolve => {
        const request = http.get(`http://127.0.0.1:${SERVER_PORT}/ping`, response => {
            response.resume();
            resolve(response.statusCode === 200);
        });
        request.on('error', () => resolve(false));
        request.setTimeout(1000, () => {
            request.destroy();
            resolve(false);
        });
    });
}

async function waitForServer(timeoutMs = 10000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await checkServerRunning()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return false;
}

function requestServerShutdown(): Promise<boolean> {
    return new Promise(resolve => {
        const request = http.request(
            `http://127.0.0.1:${SERVER_PORT}/shutdown`,
            { method: 'POST' },
            response => {
                response.resume();
                resolve(response.statusCode !== undefined && response.statusCode < 400);
            },
        );
        request.on('error', () => resolve(false));
        request.setTimeout(1000, () => {
            request.destroy();
            resolve(false);
        });
        request.end();
    });
}

export function activate(context: vscode.ExtensionContext) {
    // Register Sidebar Provider
    const sidebarProvider = new SyncRbxSidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SyncRbxSidebarProvider.viewType,
            sidebarProvider
        )
    );

    // Create Status Bar Item
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'syncrbx.start';
    updateStatusBar(false);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    void checkServerRunning().then(isRunning => {
        isExternallyRunning = isRunning;
        updateStatusBar(isRunning, isRunning ? 'Attached' : '');
    });

    // Register Commands
    const startCmd = vscode.commands.registerCommand('syncrbx.start', async () => {
        if (serverProcess || await checkServerRunning()) {
            isExternallyRunning = !serverProcess;
            updateStatusBar(true, isExternallyRunning ? 'Attached' : 'Active');
            vscode.window.showInformationMessage(`SyncRbx server is already running on port ${SERVER_PORT}.`);
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            vscode.window.showErrorMessage('SyncRbx requires an open workspace folder to sync.');
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;
        startServer(rootPath);
    });

    const stopCmd = vscode.commands.registerCommand('syncrbx.stop', async () => {
        if (!serverProcess && !isExternallyRunning && !await checkServerRunning()) {
            vscode.window.showInformationMessage('SyncRbx server is not running.');
            return;
        }
        const stopped = await stopServer();
        if (stopped) {
            vscode.window.showInformationMessage('SyncRbx server stopped.');
        } else {
            vscode.window.showErrorMessage('SyncRbx server could not be stopped cleanly.');
        }
    });

    const cleanCmd = vscode.commands.registerCommand('syncrbx.clean', async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) { return; }
        const rootPath = workspaceFolders[0].uri.fsPath;
        // Only the trash is removed; .syncrbx/config.json links the project to the cloud.
        const trashPath = path.join(rootPath, '.syncrbx', 'trash');

        if (!fs.existsSync(trashPath)) {
            vscode.window.showInformationMessage('SyncRbx trash is already empty.');
            return;
        }
        const choice = await vscode.window.showWarningMessage(
            'Permanently delete the files SyncRbx moved to .syncrbx/trash?',
            { modal: true },
            'Empty Trash',
        );
        if (choice !== 'Empty Trash') {
            return;
        }
        fs.rmSync(trashPath, { recursive: true, force: true });
        vscode.window.showInformationMessage('SyncRbx trash emptied.');
    });

    context.subscriptions.push(startCmd, stopCmd, cleanCmd);
}

function startServer(workspaceRoot: string) {
    updateStatusBar(true, 'Starting...');

    try {
        const process = spawnSyncRbx(['serve'], workspaceRoot);
        serverProcess = process;

        process.stdout.on('data', (data) => {
            const msg = data.toString();
            console.log(`[SyncRbx Server] ${msg}`);
            if (msg.includes('[Studio]') && msg.includes('connected')) {
                vscode.window.showInformationMessage('SyncRbx: Roblox Studio connected successfully!');
            }
        });

        process.stderr.on('data', (data) => {
            console.error(`[SyncRbx Server Error] ${data.toString()}`);
        });

        process.on('error', error => {
            if (serverProcess !== process) {
                return;
            }
            serverProcess = null;
            updateStatusBar(false);
            vscode.window.showErrorMessage(`Failed to start SyncRbx server: ${error.message}`);
        });

        process.on('exit', (code) => {
            if (serverProcess !== process) {
                return;
            }
            serverProcess = null;
            updateStatusBar(false);
            if (code !== 0 && code !== null) {
                vscode.window.showErrorMessage(`SyncRbx server exited unexpectedly with code ${code}`);
            }
        });

        void waitForServer().then(isRunning => {
            if (serverProcess !== process) {
                return;
            }
            if (!isRunning) {
                process.kill();
                serverProcess = null;
                updateStatusBar(false);
                vscode.window.showErrorMessage(`SyncRbx server did not become ready on port ${SERVER_PORT}.`);
                return;
            }
            updateStatusBar(true, 'Active');
            vscode.window.showInformationMessage('SyncRbx server started! Ready to sync.');
        });

    } catch (error: any) {
        serverProcess = null;
        vscode.window.showErrorMessage(`Failed to start SyncRbx server: ${error.message}`);
        updateStatusBar(false);
    }
}

async function stopServer(): Promise<boolean> {
    const process = serverProcess;
    const shutdownRequested = await requestServerShutdown();

    if (!shutdownRequested && process) {
        process.kill();
    }

    serverProcess = null;
    isExternallyRunning = false;
    updateStatusBar(false);
    return shutdownRequested || Boolean(process);
}

function updateStatusBar(isRunning: boolean, state: string = '') {
    if (isRunning) {
        if (state === 'Starting...') {
            statusBarItem.text = `$(sync~spin) SyncRbx: Starting...`;
            statusBarItem.tooltip = "SyncRbx Server is starting...";
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        } else {
            const attachedText = state === 'Attached' ? ' (Attached)' : '';
            statusBarItem.text = `$(pass) SyncRbx: Active${attachedText} (Port ${SERVER_PORT})`;
            statusBarItem.tooltip = "Click to stop SyncRbx Server";
            statusBarItem.command = 'syncrbx.stop';
            statusBarItem.backgroundColor = undefined;
        }
    } else {
        statusBarItem.text = `$(circle-outline) SyncRbx: Off`;
        statusBarItem.tooltip = "Click to start SyncRbx Server";
        statusBarItem.command = 'syncrbx.start';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
}

export function deactivate() {
    void stopServer();
}
