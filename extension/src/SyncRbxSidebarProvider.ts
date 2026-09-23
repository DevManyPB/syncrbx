import * as vscode from 'vscode';
import { spawnSyncRbx } from './cliProcess';

export class SyncRbxSidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'syncrbx-sidebar-view';
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    // Read on every use so a folder opened after activation is picked up.
    private get _workspaceRoot(): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        return workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            if (!this._workspaceRoot) {
                vscode.window.showErrorMessage('A workspace folder needs to be open to use SyncRbx.');
                return;
            }

            switch (data.type) {
                case 'login': {
                    const terminal = vscode.window.createTerminal('SyncRbx Login');
                    terminal.show();
                    terminal.sendText('syncrbx login');
                    break;
                }
                case 'init': {
                    const flag = data.isPrivate ? '--private' : '--public';
                    this.runSyncRbx(['init', flag]);
                    break;
                }
                case 'push': {
                    if (!data.message) {
                        vscode.window.showErrorMessage('Commit requires a message.');
                        return;
                    }
                    this.runSyncRbx(['push', data.message]);
                    break;
                }
                case 'pull': {
                    if (!data.projectId) {
                        vscode.window.showErrorMessage('A project ID is required to pull.');
                        return;
                    }
                    const choice = await vscode.window.showWarningMessage(
                        'Pulling will overwrite local files that differ from the cloud version. Continue?',
                        { modal: true },
                        'Pull and Overwrite',
                    );
                    if (choice !== 'Pull and Overwrite') {
                        return;
                    }
                    this.runSyncRbx(['pull', data.projectId, '--force']);
                    break;
                }
                case 'serve': {
                    vscode.commands.executeCommand('syncrbx.start');
                    break;
                }
                case 'stopServe': {
                    vscode.commands.executeCommand('syncrbx.stop');
                    break;
                }
            }
        });
    }

    private runSyncRbx(args: string[]) {
        this._view?.webview.postMessage({ type: 'status', message: `Executing: syncrbx ${args.join(' ')}...` });

        let process;
        try {
            process = spawnSyncRbx(args, this._workspaceRoot);
        } catch (error: any) {
            const message = `Failed to launch SyncRbx CLI: ${error.message}`;
            vscode.window.showErrorMessage(message);
            this._view?.webview.postMessage({ type: 'status', message });
            return;
        }

        let stdout = '';
        let stderr = '';
        let launchError: Error | undefined;

        process.stdout.on('data', data => {
            stdout += data.toString();
        });
        process.stderr.on('data', data => {
            stderr += data.toString();
        });
        process.on('error', error => {
            launchError = error;
            const message = `Failed to launch SyncRbx CLI: ${error.message}`;
            vscode.window.showErrorMessage(message);
            this._view?.webview.postMessage({ type: 'status', message });
        });
        process.on('close', code => {
            if (launchError) {
                return;
            }

            const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
            if (code !== 0) {
                const message = output || `SyncRbx CLI exited with code ${code}.`;
                vscode.window.showErrorMessage(message);
                this._view?.webview.postMessage({ type: 'status', message });
                return;
            }

            if (stderr && !stderr.toLowerCase().includes('warn')) {
                console.warn(`SyncRbx CLI Stderr: ${stderr}`);
            }
            vscode.window.showInformationMessage('SyncRbx: Command executed successfully.');
            this._view?.webview.postMessage({ type: 'status', message: output || 'Command completed.' });
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const nonce = getNonce();
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <!-- Content Security Policy to prevent XSS. Highly recommended by VS Code and prevents Marketplace flags -->
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SyncRbx Cloud</title>
    <style>
        :root {
            --syncrbx-main: #06b6d4;
            --syncrbx-hover: #0891b2;
            --syncrbx-light: #2ee8ff;
            --bg-panel: rgba(15, 23, 42, 0.4);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-main: #f8fafc;
            --text-muted: #94a3b8;
            --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            --vscode-bg: var(--vscode-editor-background, #0d1117);
        }
        
        body {
            font-family: var(--font-family);
            padding: 16px;
            color: var(--text-main);
            background-color: transparent;
            margin: 0;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        /* Typography */
        h2 {
            margin: 0 0 4px 0;
            font-size: 16px;
            font-weight: 600;
            color: var(--text-main);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        p {
            font-size: 13px;
            line-height: 1.4;
            color: var(--text-muted);
            margin: 0 0 12px 0;
        }

        /* Sections (Cards) */
        .section {
            background: var(--bg-panel);
            border: 1px solid var(--border-color);
            padding: 16px;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            transition: transform 0.2s ease, border-color 0.2s ease;
        }
        
        .section:hover {
            border-color: rgba(6, 182, 212, 0.3);
        }

        .section-header {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 8px;
        }

        .badge {
            background: rgba(6, 182, 212, 0.15);
            color: var(--syncrbx-light);
            width: 24px;
            height: 24px;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            font-weight: 700;
        }

        .section h3 {
            margin: 0;
            font-size: 14px;
            font-weight: 600;
            color: var(--text-main);
            letter-spacing: 0.3px;
        }

        /* Inputs */
        input[type="text"], input[type="password"] {
            width: 100%;
            box-sizing: border-box;
            padding: 10px 12px;
            background: rgba(0, 0, 0, 0.25);
            border: 1px solid var(--border-color);
            color: var(--text-main);
            border-radius: 6px;
            font-size: 13px;
            margin-bottom: 12px;
            transition: all 0.2s ease;
            outline: none;
            font-family: var(--font-family);
        }

        input[type="text"]:focus, input[type="password"]:focus {
            border-color: var(--syncrbx-main);
            box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.2);
            background: rgba(0, 0, 0, 0.4);
        }

        input::placeholder {
            color: #64748b;
        }

        /* Buttons */
        .btn-group {
            display: flex;
            gap: 8px;
            margin-bottom: 12px;
        }
        .btn-group button {
            margin-bottom: 0;
            flex: 1;
        }

        button {
            background: linear-gradient(135deg, var(--syncrbx-main) 0%, var(--syncrbx-hover) 100%);
            color: #ffffff;
            border: none;
            padding: 10px 14px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
            font-size: 13px;
            width: 100%;
            margin-bottom: 10px;
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        button:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 8px rgba(6, 182, 212, 0.3);
            filter: brightness(1.1);
        }

        button:active {
            transform: translateY(0);
        }

        button.secondary {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            color: var(--text-main);
            box-shadow: none;
        }

        button.secondary:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.2);
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        }
        
        button.danger {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.2);
            color: #fca5a5;
        }
        
        button.danger:hover {
            background: rgba(239, 68, 68, 0.2);
            border-color: rgba(239, 68, 68, 0.4);
        }

        /* Console Output */
        .console-container {
            margin-top: 8px;
        }
        
        .output-box {
            font-family: "JetBrains Mono", "Fira Code", Consolas, monospace;
            font-size: 11px;
            background: #0f111a;
            padding: 12px;
            border-radius: 8px;
            border: 1px solid var(--border-color);
            min-height: 80px;
            max-height: 200px;
            overflow-y: auto;
            white-space: pre-wrap;
            color: #a5b4fc;
            line-height: 1.5;
            box-shadow: inset 0 2px 4px rgba(0,0,0,0.5);
        }
        
        .output-box::-webkit-scrollbar {
            width: 8px;
        }
        .output-box::-webkit-scrollbar-track {
            background: transparent;
        }
        .output-box::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,0.1);
            border-radius: 4px;
        }
        .output-box::-webkit-scrollbar-thumb:hover {
            background: rgba(255,255,255,0.2);
        }
        
        /* Icons */
        .icon {
            width: 14px;
            height: 14px;
            fill: currentColor;
        }
    </style>
</head>
<body>
    <div class="section">
        <div class="section-header">
            <div class="badge">1</div>
            <h3>Authentication</h3>
        </div>
        <p>Connect VS Code to SyncRbx Cloud. An interactive terminal will open.</p>
        <button id="btn-login">
            <svg class="icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
            Login
        </button>
    </div>

    <div class="section">
        <div class="section-header">
            <div class="badge">2</div>
            <h3>Initialize Project</h3>
        </div>
        <p>Upload your current project to the cloud.</p>
        <div class="btn-group">
            <button id="btn-init-pub" class="secondary">Public</button>
            <button id="btn-init-priv" class="secondary">Private</button>
        </div>
    </div>

    <div class="section">
        <div class="section-header">
            <div class="badge">3</div>
            <h3>Commit & Push</h3>
        </div>
        <p>Save a new version of your code.</p>
        <input type="text" id="commit-msg" placeholder="Commit message..." />
        <button id="btn-push">
            <svg class="icon" viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>
            Push to Cloud
        </button>
    </div>

    <div class="section">
        <div class="section-header">
            <div class="badge">4</div>
            <h3>Clone (Pull)</h3>
        </div>
        <p>Download a project using its UUID.</p>
        <input type="text" id="pull-id" placeholder="Repository ID..." />
        <button id="btn-pull" class="secondary">
            <svg class="icon" viewBox="0 0 24 24"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/></svg>
            Clone / Download
        </button>
    </div>

    <div class="section">
        <div class="section-header">
            <div class="badge">5</div>
            <h3>Local Sync</h3>
        </div>
        <p>Sync in real-time with Roblox Studio.</p>
        <button id="btn-serve">
            <svg class="icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            Start Local Server
        </button>
        <button id="btn-stop" class="secondary danger">
            <svg class="icon" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
            Stop Server
        </button>
    </div>

    <div class="console-container">
        <h2>
            <svg class="icon" style="color: var(--text-muted);" viewBox="0 0 24 24"><path d="M20 4H4c-1.11 0-2 .9-2 2v12c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.89-2-2-2zm0 14H4V8h16v10zm-2-1h-6v-2h6v2zM6 10.5l1.41-1.41 3.59 3.59-3.59 3.59L6 14.86 8.13 12.7 6 10.5z"/></svg>
            Console
        </h2>
        <div id="output" class="output-box">SyncRbx Engine Ready.
Waiting for commands...</div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        function addLog(text) {
            const output = document.getElementById('output');
            const time = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', second:'2-digit'});
            output.innerText = '[' + time + '] ' + text + '\\n' + output.innerText;
        }

        document.getElementById('btn-login').addEventListener('click', () => {
            vscode.postMessage({ type: 'login' });
            addLog('Opening login terminal...');
        });
        document.getElementById('btn-init-pub').addEventListener('click', () => {
            vscode.postMessage({ type: 'init', isPrivate: false });
        });
        document.getElementById('btn-init-priv').addEventListener('click', () => {
            vscode.postMessage({ type: 'init', isPrivate: true });
        });
        document.getElementById('btn-push').addEventListener('click', () => {
            const msg = document.getElementById('commit-msg').value;
            vscode.postMessage({ type: 'push', message: msg });
        });
        document.getElementById('btn-pull').addEventListener('click', () => {
            const pid = document.getElementById('pull-id').value;
            vscode.postMessage({ type: 'pull', projectId: pid });
        });
        document.getElementById('btn-serve').addEventListener('click', () => {
            vscode.postMessage({ type: 'serve' });
        });
        document.getElementById('btn-stop').addEventListener('click', () => {
            vscode.postMessage({ type: 'stopServe' });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'status') {
                addLog(message.message);
            }
        });
    </script>
</body>
</html>`;
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
