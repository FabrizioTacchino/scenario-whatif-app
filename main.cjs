const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const log   = require('electron-log');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const https = require('https');

// Reindirizza i log di electron-updater su file (utile per debug in produzione)
// File: %AppData%\analisi-scenari-vdp\logs\main.log
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// ─── LICENZA LEMON SQUEEZY ────────────────────────────────────────────────────
//
// La gestione licenze avviene tramite le API ufficiali di Lemon Squeezy.
// Al primo avvio l'utente inserisce la chiave → l'app la attiva su LS.
// Agli avvii successivi l'app valida la chiave + instance_id salvati localmente.
// Se offline, l'app concede accesso se esiste una licenza attivata in precedenza.
//

const LS_ACTIVATE_URL   = 'https://api.lemonsqueezy.com/v1/licenses/activate';
const LS_VALIDATE_URL   = 'https://api.lemonsqueezy.com/v1/licenses/validate';
const LS_DEACTIVATE_URL = 'https://api.lemonsqueezy.com/v1/licenses/deactivate';

function getLicensePath() {
    return path.join(app.getPath('userData'), 'license.json');
}

function lsPost(url, body) {
    return new Promise((resolve, reject) => {
        const data = new URLSearchParams(body).toString();
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(data),
            },
        };
        const req = https.request(options, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(raw)); }
                catch { reject(new Error('Risposta non valida dal server.')) ; }
            });
        });
        req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout connessione.')); });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

async function activateLicenseLS(key) {
    try {
        const result = await lsPost(LS_ACTIVATE_URL, {
            license_key: key,
            instance_name: os.hostname(),
        });
        if (result.activated) {
            fs.writeFileSync(getLicensePath(), JSON.stringify({
                license_key: key,
                instance_id: result.instance.id,
                activatedAt: new Date().toISOString(),
            }));
            return { valid: true };
        }
        return { valid: false, reason: result.error || 'Chiave licenza non valida.' };
    } catch (e) {
        return { valid: false, reason: 'Errore di connessione. Verifica la tua connessione internet.' };
    }
}

async function validateStoredLicense() {
    try {
        const p = getLicensePath();
        if (!fs.existsSync(p)) return { valid: false };

        const stored = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!stored.license_key || !stored.instance_id) return { valid: false };

        const result = await lsPost(LS_VALIDATE_URL, {
            license_key: stored.license_key,
            instance_id: stored.instance_id,
        });

        if (result.valid) {
            const status = result.license_key?.status;
            if (status === 'expired') return { valid: false, expired: true, reason: 'Licenza scaduta.' };
            if (status === 'disabled') return { valid: false, reason: 'Licenza disabilitata. Contatta il supporto.' };
            // Aggiorna cache locale con la data di scadenza
            const expiresAt = result.license_key?.expires_at || null;
            try {
                const updated = { ...stored, expires_at: expiresAt };
                fs.writeFileSync(getLicensePath(), JSON.stringify(updated));
            } catch {}
            return { valid: true };
        }
        return { valid: false, reason: result.error || 'Licenza non valida o disattivata.' };
    } catch {
        // Offline: consenti accesso se esiste una licenza attivata in precedenza
        try {
            const stored = JSON.parse(fs.readFileSync(getLicensePath(), 'utf8'));
            if (stored.license_key && stored.instance_id) return { valid: true, offline: true };
        } catch {}
        return { valid: false, reason: 'Impossibile verificare la licenza. Verifica la connessione.' };
    }
}

async function deactivateLicense() {
    try {
        const p = getLicensePath();
        if (!fs.existsSync(p)) return true;
        const stored = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (stored.license_key && stored.instance_id) {
            await lsPost(LS_DEACTIVATE_URL, {
                license_key: stored.license_key,
                instance_id: stored.instance_id,
            }).catch(() => {});
        }
        fs.unlinkSync(p);
    } catch {}
    return true;
}

function getLicenseInfo() {
    try {
        const p = getLicensePath();
        if (!fs.existsSync(p)) return null;
        const stored = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!stored.license_key) return null;
        return {
            licenseKey:  stored.license_key,
            expiresAt:   stored.expires_at   || null,
            activatedAt: stored.activatedAt  || null,
        };
    } catch { return null; }
}

// IPC handlers — licenza
ipcMain.handle('license:activate',  (_, key) => activateLicenseLS(key));
ipcMain.handle('license:getStored', ()        => validateStoredLicense());
ipcMain.handle('license:clear',     ()        => deactivateLicense());
ipcMain.handle('license:getInfo',   ()        => getLicenseInfo());

// IPC handlers — utilità
ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url));
ipcMain.handle('app:getVersion',     ()        => app.getVersion());
ipcMain.handle('window:focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        win.blur();
        setTimeout(() => {
            win.focus();
            win.webContents.focus();
        }, 50);
    }
});
// isSilent: false → mostra la UI del installer NSIS (progress bar visibile all'utente)
// isForceRunAfter: true → l'app si riavvia automaticamente dopo l'installazione
function findInstallerPath() {
    // 1. Percorso salvato dall'evento update-downloaded
    if (pendingInstallerPath && fs.existsSync(pendingInstallerPath)) {
        return pendingInstallerPath;
    }
    // 2. Proprietà interna di electron-updater
    const internal = autoUpdater._downloadedUpdateHelper?.installerPath;
    if (internal && fs.existsSync(internal)) {
        return internal;
    }
    // 3. Ricerca nella cartella cache di electron-updater
    //    Percorso standard: %LOCALAPPDATA%\{appName}-updater\pending\  oppure  \{appName}-updater\
    const localAppData = process.env.LOCALAPPDATA
        || path.join(os.homedir(), 'AppData', 'Local');
    const updaterDir = path.join(localAppData, `${app.getName()}-updater`);
    for (const dir of [path.join(updaterDir, 'pending'), updaterDir]) {
        try {
            if (!fs.existsSync(dir)) continue;
            const exes = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.exe'));
            if (exes.length > 0) {
                return path.join(dir, exes[0]);
            }
        } catch { /* ignora errori di accesso */ }
    }
    return null;
}

ipcMain.handle('updater:install', () => {
    const installerPath = findInstallerPath();
    log.info('[updater:install] installerPath trovato:', installerPath);

    if (installerPath && fs.existsSync(installerPath)) {
        try {
            // Strategy: the batch kills the app, waits until it's dead,
            // deletes the old uninstaller (which crashes with -1073740940),
            // then launches the new installer.
            const batchPath = path.join(os.tmpdir(), 'vdp-update.bat');
            const batchLogPath = path.join(os.tmpdir(), 'vdp-update-log.txt');
            const exeName = path.basename(process.execPath);
            const installDir = path.dirname(process.execPath);
            const uninstallerPath = path.join(installDir, 'Uninstall Analisi Scenari VDP.exe');
            const batchContent = [
                '@echo off',
                `set LOGFILE="${batchLogPath}"`,
                'echo [%date% %time%] === Update batch started === > %LOGFILE%',
                // Kill the app
                `echo [%date% %time%] Killing ${exeName} >> %LOGFILE%`,
                `taskkill /IM "${exeName}" /F /T >> %LOGFILE% 2>&1`,
                // Loop until the process is truly dead
                ':waitloop',
                'timeout /t 1 /nobreak >nul',
                `tasklist /FI "IMAGENAME eq ${exeName}" 2>nul | find /I "${exeName}" >nul`,
                'if %errorlevel% equ 0 (',
                '  echo [%date% %time%] Process still alive, killing again >> %LOGFILE%',
                `  taskkill /IM "${exeName}" /F /T >> %LOGFILE% 2>&1`,
                '  goto waitloop',
                ')',
                'echo [%date% %time%] Process is dead >> %LOGFILE%',
                // Wait for Defender to release file locks
                'echo [%date% %time%] Waiting 5s for file locks >> %LOGFILE%',
                'timeout /t 5 /nobreak >nul',
                // Check if uninstaller exists
                `if exist "${uninstallerPath}" (`,
                '  echo [%date% %time%] Uninstaller EXISTS, deleting >> %LOGFILE%',
                `  del /f /q "${uninstallerPath}" >> %LOGFILE% 2>&1`,
                '  echo [%date% %time%] Del exit code: %errorlevel% >> %LOGFILE%',
                ') else (',
                '  echo [%date% %time%] Uninstaller NOT FOUND >> %LOGFILE%',
                ')',
                // Check if still exists after delete
                `if exist "${uninstallerPath}" (`,
                '  echo [%date% %time%] Still exists! Trying rename >> %LOGFILE%',
                `  rename "${uninstallerPath}" uninstall.exe.old >> %LOGFILE% 2>&1`,
                '  echo [%date% %time%] Rename exit code: %errorlevel% >> %LOGFILE%',
                ')',
                // Final check
                `if exist "${uninstallerPath}" (`,
                '  echo [%date% %time%] WARNING: uninstaller STILL EXISTS >> %LOGFILE%',
                ') else (',
                '  echo [%date% %time%] Uninstaller successfully removed >> %LOGFILE%',
                ')',
                'timeout /t 2 /nobreak >nul',
                `echo [%date% %time%] Launching installer: ${installerPath} >> %LOGFILE%`,
                `start "" "${installerPath}"`,
                'echo [%date% %time%] Installer launched >> %LOGFILE%',
            ].join('\r\n') + '\r\n';
            fs.writeFileSync(batchPath, batchContent, 'utf8');
            log.info('[updater:install] installDir:', installDir);
            log.info('[updater:install] uninstaller to delete:', uninstallerPath);
            log.info('[updater:install] batch log will be at:', batchLogPath);

            const { spawn } = require('child_process');
            spawn('cmd.exe', ['/c', 'start', '', '/min', 'cmd.exe', '/c', batchPath], {
                detached: true,
                stdio: 'ignore',
            }).unref();

            log.info('[updater:install] batch lanciato, chiusura app...');
            BrowserWindow.getAllWindows().forEach(w => w.destroy());
            setTimeout(() => app.exit(0), 500);
        } catch (err) {
            log.error('[updater:install] errore batch:', err);
            _isUpdaterQuit = true;
            BrowserWindow.getAllWindows().forEach(w => { try { w.destroy(); } catch {} });
            setTimeout(() => autoUpdater.quitAndInstall(false, true), 500);
        }
    } else {
        log.warn('[updater:install] percorso non trovato, uso quitAndInstall fallback');
        _isUpdaterQuit = true;
        BrowserWindow.getAllWindows().forEach(w => { try { w.destroy(); } catch {} });
        setTimeout(() => autoUpdater.quitAndInstall(false, true), 500);
    }
});

// ─── FINESTRA PRINCIPALE ──────────────────────────────────────────────────────
// Modalità sviluppo: electron . --dev  →  carica da Vite dev server
const isDev = !app.isPackaged && process.argv.includes('--dev');

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        icon: path.join(__dirname, 'logoVDP.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs'),
        }
    });

    if (isDev) {
        win.loadURL('http://localhost:5173');
        win.webContents.openDevTools();
    } else {
        win.loadFile(path.join(__dirname, 'dist', 'index.html'));
    }

    // Ripristina il focus della tastiera quando la finestra torna in primo piano
    win.on('focus', () => win.webContents.focus());

    // Apre i link esterni nel browser di sistema invece che in una nuova finestra Electron
    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    const template = [
        {
            label: 'File',
            submenu: [
                { role: 'quit', label: 'Esci' }
            ]
        },
        {
            label: 'Modifica',
            submenu: [
                { role: 'undo',  label: 'Annulla' },
                { role: 'redo',  label: 'Ripristina' },
                { type: 'separator' },
                { role: 'cut',   label: 'Taglia' },
                { role: 'copy',  label: 'Copia' },
                { role: 'paste', label: 'Incolla' }
            ]
        },
        {
            label: 'Visualizza',
            submenu: [
                { role: 'reload',         label: 'Ricarica' },
                { role: 'forceReload',    label: 'Forza Ricarica' },
                { role: 'toggleDevTools', label: 'Strumenti per sviluppatori' },
                { type: 'separator' },
                { role: 'resetZoom',      label: 'Reimposta Zoom' },
                { role: 'zoomIn',         label: 'Ingrandisci' },
                { role: 'zoomOut',        label: 'Riduci' },
                { type: 'separator' },
                { role: 'togglefullscreen', label: 'Schermo intero' }
            ]
        },
        {
            label: 'About',
            submenu: [
                {
                    label: 'Controlla aggiornamenti...',
                    click: async () => {
                        if (!app.isPackaged) {
                            dialog.showMessageBox(win, {
                                type: 'info',
                                title: 'Aggiornamenti',
                                message: 'Controllo aggiornamenti disponibile solo nella versione installata.',
                                buttons: ['OK'],
                            });
                            return;
                        }
                        // Se l'aggiornamento è già pronto, ri-mostra il banner nel renderer
                        if (updateDownloaded) {
                            const w = BrowserWindow.getAllWindows()[0];
                            if (w) w.webContents.send('updater:ready');
                            return;
                        }
                        autoUpdater._manualCheck = true;
                        autoUpdater.checkForUpdates();
                    }
                },
                { type: 'separator' },
                {
                    label: 'Informazioni su...',
                    click: async () => {
                        const aboutWin = new BrowserWindow({
                            width: 800,
                            height: 690,
                            parent: win,
                            modal: false,
                            icon: path.join(__dirname, 'logoVDP.png'),
                            webPreferences: {
                                nodeIntegration: false,
                                contextIsolation: true,
                                preload: path.join(__dirname, 'preload.cjs'),
                            }
                        });
                        aboutWin.loadFile(path.join(__dirname, 'dist', 'about.html'));
                        aboutWin.setMenu(null);
                        // Quando si chiude, restituisce il focus alla finestra principale
                        aboutWin.on('closed', () => { if (!win.isDestroyed()) win.webContents.focus(); });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

// Flag condiviso: aggiornamento già scaricato (usato anche nel menu)
let updateDownloaded = false;
let pendingInstallerPath = null;  // path del file installer scaricato

// Inizializza aggiornamenti automatici (solo in produzione)
if (app.isPackaged) {
    setupUpdater();
}

function setupUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = false;  // evita EBUSY: installa solo su click esplicito
    autoUpdater.disableWebInstaller = true;    // rimuove warning nei log

    autoUpdater.on('update-not-available', () => {
        if (autoUpdater._manualCheck) {
            autoUpdater._manualCheck = false;
            const w = BrowserWindow.getAllWindows()[0];
            dialog.showMessageBox(w || BrowserWindow.getFocusedWindow(), {
                type: 'info',
                title: 'Nessun aggiornamento',
                message: 'Stai già usando la versione più recente.',
                buttons: ['OK'],
            });
        }
    });

    autoUpdater.on('update-available', (info) => {
        autoUpdater._manualCheck = false;
        // Download parte in automatico — avvisa il renderer tramite banner
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send('updater:start', info.version);
    });

    autoUpdater.on('download-progress', (progress) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send('updater:progress', Math.floor(progress.percent));
    });

    autoUpdater.on('update-downloaded', (info) => {
        updateDownloaded = true;
        pendingInstallerPath = info.downloadedFile || null;
        log.info('[update-downloaded] downloadedFile:', pendingInstallerPath);
        log.info('[update-downloaded] info keys:', Object.keys(info));
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send('updater:ready');
    });

    autoUpdater.on('error', (err) => {
        log.error('Errore aggiornamento:', err);
        const w = BrowserWindow.getAllWindows()[0];
        if (w) w.webContents.send('updater:error', err.message || String(err));
    });

    autoUpdater.checkForUpdates();
}

app.whenReady().then(() => {
    createWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Force-kill on Windows: app.quit() sends WM_CLOSE but the process can linger.
// Skip if auto-updater is handling the quit (quitAndInstall needs to launch the installer first).
let _isUpdaterQuit = false;
app.on('will-quit', () => {
    if (_isUpdaterQuit) return; // let electron-updater handle its own quit flow
    process.exit(0);
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
