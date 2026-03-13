const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const https = require('https');

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
ipcMain.handle('updater:install',    ()        => autoUpdater.quitAndInstall());

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
                            dialog.showMessageBox({
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

// Inizializza aggiornamenti automatici (solo in produzione)
if (app.isPackaged) {
    setupUpdater();
}

function setupUpdater() {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-not-available', () => {
        if (autoUpdater._manualCheck) {
            autoUpdater._manualCheck = false;
            dialog.showMessageBox({
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

    autoUpdater.on('update-downloaded', () => {
        updateDownloaded = true;
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send('updater:ready');
    });

    autoUpdater.on('error', (err) => {
        console.log('Errore aggiornamento:', err);
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

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
