/**
 * main.js — Application bootstrap and controller
 */
import './style.css';
import { checkLicense, activateLicense } from './licenseManager.js';
import { parseExcel, parseImportedScenario, dateToMonth } from './dataLoader.js';
import { computeScenario, computeMultiScenario } from './scenarioEngine.js';
import {
    listScenarios, getScenario, createScenario, duplicateScenario,
    updateScenario, updateScenarioInput, deleteScenario,
    saveBaseline, loadBaseline, clearBaseline, renameCommessaKey,
    lockScenario, unlockScenario, setScenarioDraft,
} from './scenarioManager.js';
import { exportToExcel, exportToCSV, exportToTemplate, exportChartToExcel } from './exportManager.js';
import { initResourceModule, renderResourceTab, onScenarioDuplicated } from './resourceUI.js';
import { renameCommessaCodice, listPersone, listAllocazioni } from './resourceManager.js';
import { computeResourceMatrix, computeResourceKpis } from './resourceEngine.js';
import { generateReport } from './reportGenerator.js';
import { supabase, signIn, signUp, signOut, getSession, onAuthStateChange, getUserRole, listUsers, updateUserRole } from './supabaseClient.js';
import { initSync, stopSync, fullPush, fullPull, getSyncStatus, onSyncStatusChange, incrementalSync, trackDeletion, getCurrentRole, canWrite, fetchAllScenariosFromCloud, pushScenarioApproval, pushScenarioDelete, pushSingleScenario, pushScenarioRestore } from './syncManager.js';
import { Chart, registerables } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';

Chart.register(...registerables);

// ─── State ───
let appData = null;        // { commesse, monthlyData, allMonths, filters }
let activeScenarioId = null;
let comparedScenarioIds = null; // List of scenario IDs being compared
let lastResult = null;     // last computed scenario result
let charts = {};           // Chart.js instances
let _currentUserRole = null; // 'admin' | 'editor' | 'hr' | 'commercial' | 'tester' | 'viewer'
let _currentUserEmail = null;

// ─── DOM refs ───
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Electron focus fix: override native dialogs ───
// Native confirm/alert steal focus from Electron webContents.
// Persistent hidden input — avoids DOM add/remove flash on every call.
const _focusAnchor = document.createElement('input');
_focusAnchor.style.cssText = 'position:fixed;top:-100px;left:-100px;opacity:0;width:1px;height:1px;pointer-events:none;';
_focusAnchor.tabIndex = -1;
_focusAnchor.setAttribute('aria-hidden', 'true');
document.body.appendChild(_focusAnchor);

function _restoreFocus() {
    const fix = () => {
        if (window.electronAPI?.focusWindow) window.electronAPI.focusWindow();
        _focusAnchor.focus();
        requestAnimationFrame(() => _focusAnchor.blur());
    };
    setTimeout(fix, 100);
    setTimeout(fix, 300);
}
const _nativeConfirm = window.confirm.bind(window);
const _nativeAlert = window.alert.bind(window);
window.confirm = (msg) => { const r = _nativeConfirm(msg); _restoreFocus(); return r; };
window.alert = (msg) => { _nativeAlert(msg); _restoreFocus(); };

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
    // One-time cleanup: remove duplicate allocazioni from localStorage
    try {
        const _raw = localStorage.getItem('whatif_allocazioni');
        if (_raw) {
            const _alloc = JSON.parse(_raw);
            const _seen = new Map();
            for (const a of _alloc) {
                const k = `${a.personaId}|${a.codiceCommessa}|${a.scenarioId}|${a.dataInizio}|${a.dataFine}|${a.percentuale}`;
                if (_seen.has(k)) {
                    const prev = _seen.get(k);
                    if ((a.updatedAt || '') > (prev.updatedAt || '')) _seen.set(k, a);
                } else {
                    _seen.set(k, a);
                }
            }
            const _cleaned = [..._seen.values()];
            if (_cleaned.length < _alloc.length) {
                console.warn(`[Startup] Rimossi ${_alloc.length - _cleaned.length} allocazioni duplicate`);
                localStorage.setItem('whatif_allocazioni', JSON.stringify(_cleaned));
            }
        }
    } catch (e) { console.warn('[Startup] Dedup error:', e); }

    initTheme();
    setupFileUpload();
    setupUpdateImport();
    setupTabs();
    setupScenarioButtons();
    setupFilterEvents();
    setupExportEvents();
    setupGlobalSliders();
    setupModals();
    setupThemeToggle();
    setupZoomControls();
    setupChangeFileButton();
    setupLicenseScreen();
    setupUpdateBanner();
    setupChartDownloads();
    setupScenarioCompareTab();
    setupCloudAuth();

    // Inizializza modulo risorse (non invasivo)
    initResourceModule({
        getCommesse: () => {
            const base = appData?.commesse || [];
            const scen = activeScenarioId ? getScenario(activeScenarioId) : null;
            const inputs = scen?.inputs || {};
            const newCommesse = scen?.newCommesse || [];
            const all = newCommesse.length ? [...base, ...newCommesse] : base;
            return all.map(c => {
                const ci = inputs[c.key] || {};
                const probEffettiva = ci.probabilita != null
                    ? ci.probabilita
                    : Math.round((c.probabilitaAOP || 0) * 100);
                return { ...c, probabilita: probEffettiva };
            });
        },
        getActiveScenarioId: () => activeScenarioId,
        getScenarios: () => listScenarios(),
        getEffectiveCommessaDates: (codice, scenarioId) => {
            if (!appData) return null;
            const all = appData.commesse || [];
            const comm = all.find(c => c.codice === codice);
            if (!comm) return null;
            const resolvedId = scenarioId !== undefined ? scenarioId : activeScenarioId;

            // computeScenario senza filtri data: vede tutti i mesi inclusi quelli
            // estesi da ritardo/smussamento. Il vdpAOP dei mesi con solo vdpRemaining
            // negativo viene già calcolato dal dataLoader come (remaining * prob) ≠ 0.
            const scen = resolvedId ? getScenario(resolvedId) : null;
            const result = computeScenario([comm], appData.monthlyData, scen || {}, {});
            const cr = result?.commessaResults?.[0];
            // !== 0: include valori negativi (es. rettifiche), esclude solo gli zeri
            const withVdp = (cr?.scenarioMonths || [])
                .filter(m => (m.vdp || 0) !== 0)
                .map(m => m.month)
                .sort();

            if (!withVdp.length) return null;
            return {
                dataInizio: withVdp[0],
                dataFine:   withVdp[withVdp.length - 1],
            };
        },
        getSelectedCommesse: () => {
            const activeKeys = Array.from(document.querySelectorAll('#filter-commessa .filter-chip.active'))
                .map(b => b.dataset.value).filter(Boolean);
            if (!activeKeys.length) return [];
            const base = appData?.commesse || [];
            return activeKeys.map(key => base.find(x => x.key === key)?.codice).filter(Boolean);
        },
        getActiveScenarioName: () => {
            if (!activeScenarioId) return 'Baseline';
            const scen = getScenario(activeScenarioId);
            return scen ? scen.name : 'Scenario attivo';
        },
        getDateRange: () => ({
            from: document.getElementById('filter-date-from')?.value || null,
            to:   document.getElementById('filter-date-to')?.value   || null,
        }),
        getActiveFilters: () => getActiveFilters(),
        renameCommessa: (oldCodice, oldNome, newCodice, newNome) => {
            const allocCount = renameCommessaCodice(oldCodice, newCodice);
            const oldKey = `${oldCodice}|||${oldNome}`;
            const newKey = `${newCodice}|||${newNome}`;
            const scenCount = renameCommessaKey(oldKey, newKey);
            return { allocCount, scenCount };
        },
    });

    await checkAndInitLicense();
});

// ============================================================
//  LICENSE
// ============================================================

// ⚠ Sostituisci con l'URL del tuo prodotto su Lemon Squeezy
// Es. https://tuostore.lemonsqueezy.com/buy/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
const LEMON_SQUEEZY_URL = 'https://fabriziotacchino.lemonsqueezy.com/checkout/buy/6fa698ed-4fc3-488b-b027-b4e05eee4711';

function setupLicenseScreen() {
    $('#btn-activate-license')?.addEventListener('click', async () => {
        const key   = $('#license-key-input')?.value?.trim();
        const errEl = $('#license-error');
        if (!key) { errEl.textContent = 'Incolla la chiave licenza prima di procedere.'; return; }

        errEl.textContent = 'Attivazione in corso...';
        const result = await activateLicense(key);
        if (result.valid) {
            $('#license-overlay').classList.add('hidden');
            afterLicenseValid(result);
        } else {
            errEl.textContent = result.reason || 'Chiave non valida.';
        }
    });

    // Apri Lemon Squeezy nel browser di sistema tramite IPC
    $('#btn-open-store')?.addEventListener('click', () => {
        if (window.electronAPI?.openExternal) {
            window.electronAPI.openExternal(LEMON_SQUEEZY_URL);
        } else {
            window.open(LEMON_SQUEEZY_URL, '_blank'); // fallback Vite dev
        }
    });
}

async function checkAndInitLicense() {
    const result = await checkLicense();
    if (result && result.valid) {
        $('#license-overlay').classList.add('hidden');
        afterLicenseValid(result);
    } else {
        // Licenza assente o scaduta: mostra schermata di attivazione
        $('#license-overlay').classList.remove('hidden');
        if (result?.expired) {
            const errEl = $('#license-error');
            if (errEl) errEl.textContent = result.reason;
        }
    }
}

function afterLicenseValid(licenseResult) {
    // Banner giallo se scade entro 30 giorni
    if (licenseResult.warning && !licenseResult.devMode) {
        const banner = $('#license-warning-banner');
        if (banner) {
            banner.textContent = `⚠ La licenza scade tra ${licenseResult.daysLeft} giorni (${licenseResult.expiresAt}). Contatta Fabrizio Tacchino per il rinnovo.`;
            banner.classList.remove('hidden');
        }
    }

    // Ripristina baseline salvata o mostra schermata di upload
    const saved = loadBaseline();
    if (saved) {
        appData = saved;
        $('#upload-overlay').classList.add('hidden');
        $('#app').classList.remove('hidden');
        initApp();
    } else {
        $('#upload-overlay').classList.remove('hidden');
    }

    // Cloud sync (non-blocking)
    initCloudSync();
}

// ============================================================
//  CLOUD SYNC
// ============================================================

async function initCloudSync() {
    try {
        const session = await getSession();
        if (session) {
            updateCloudIndicator('syncing');
            _currentUserRole = await getUserRole();
            _currentUserEmail = session.user.email || null;
            const result = await initSync();
            updateCloudIndicator('connected');
            const emailEl = $('#cloud-user-email');
            if (emailEl) emailEl.textContent = session.user.email;
            _applyRoleRestrictions(_currentUserRole);

            // If data was pulled, reload the app
            if (result === 'pulled') {
                const saved = loadBaseline();
                if (saved) {
                    appData = saved;
                    $('#upload-overlay').classList.add('hidden');
                    $('#app').classList.remove('hidden');
                    initApp();
                }
            }
        } else {
            updateCloudIndicator('disconnected');
        }
    } catch (err) {
        console.error('[CloudSync] init error:', err);
        updateCloudIndicator('error');
    }

    // Listen for status changes
    onSyncStatusChange((status) => {
        updateCloudIndicator(status.state);
        const lastSyncEl = $('#cloud-last-sync');
        if (lastSyncEl && status.lastSync) {
            lastSyncEl.textContent = new Date(status.lastSync).toLocaleTimeString('it-IT');
        }
        // Show a non-intrusive notification when remote data has changed
        if (status.dataChanged) {
            // Auto-refresh resource tab if it's currently active
            if (document.querySelector('.tab-btn.active')?.dataset.tab === 'risorse') {
                renderResourceTab();
            }
            _showSyncUpdateBanner();
        }
    });
}

function _showSyncUpdateBanner() {
    // Don't show if already visible
    if ($('#sync-update-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'sync-update-banner';
    banner.style.cssText = 'position:fixed;bottom:16px;right:16px;background:var(--bg-card,#fff);border:1px solid var(--primary,#638cff);border-radius:8px;padding:10px 16px;font-size:12px;z-index:1200;box-shadow:0 4px 12px rgba(0,0,0,.15);display:flex;align-items:center;gap:10px;';
    banner.innerHTML = `
        <span style="color:var(--text);">Nuovi dati disponibili dal cloud</span>
        <button id="btn-sync-apply" style="background:var(--primary,#638cff);color:#fff;border:none;border-radius:4px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:600;">Aggiorna</button>
        <button id="btn-sync-dismiss" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:14px;padding:0 4px;">&times;</button>
    `;
    document.body.appendChild(banner);

    $('#btn-sync-apply').addEventListener('click', () => {
        const saved = loadBaseline();
        if (saved && appData) {
            appData = saved;
            refreshDashboard();
            renderAssumptionsTable();
            if (document.querySelector('.tab-btn.active')?.dataset.tab === 'risorse') {
                renderResourceTab();
            }
        }
        // Reload scenario list to reflect lock/unlock/new scenarios from cloud
        loadScenarioList();
        if (activeScenarioId) {
            $('#active-scenario-select').value = activeScenarioId;
        }
        banner.remove();
        _restoreFocus();
    });

    $('#btn-sync-dismiss').addEventListener('click', () => banner.remove());

    // Auto-dismiss after 30 seconds
    setTimeout(() => banner.remove(), 30000);
}

function updateCloudIndicator(state) {
    const states = ['disconnected', 'connected', 'syncing', 'error'];
    states.forEach(s => {
        const icon = $(`#cloud-icon-${s}`);
        if (icon) icon.classList.toggle('hidden', s !== state);
    });

    const label = $('#cloud-sync-label');
    if (label) {
        const labels = { disconnected: 'Cloud', connected: 'Sync OK', syncing: 'Sync...', error: 'Errore', offline: 'Offline' };
        label.textContent = labels[state] || 'Cloud';
    }

    const btn = $('#btn-cloud-sync');
    if (btn) {
        btn.title = {
            disconnected: 'Cloud Sync — Clicca per accedere',
            connected: 'Cloud Sync — Connesso',
            syncing: 'Cloud Sync — Sincronizzazione in corso...',
            error: 'Cloud Sync — Errore di sincronizzazione',
            offline: 'Cloud Sync — Offline'
        }[state] || 'Cloud Sync';
    }
}

function setupCloudAuth() {
    const modal = $('#cloud-auth-modal');
    const conflictModal = $('#cloud-conflict-modal');
    if (!modal) return;

    // Open modal — shared handler for both buttons
    async function _openCloudModal() {
        const session = await getSession();
        if (session) {
            // Show logged-in view
            $('#cloud-auth-tabs').classList.add('hidden');
            $('#cloud-login-form').classList.add('hidden');
            $('#cloud-register-form').classList.add('hidden');
            $('#cloud-logged-in').classList.remove('hidden');
            $('#cloud-user-email').textContent = session.user.email;
            // Role badge
            const roleBadge = $('#cloud-user-role-badge');
            if (roleBadge) {
                roleBadge.textContent = _currentUserRole || 'viewer';
                roleBadge.className = 'role-badge ' + (_currentUserRole || 'viewer');
            }
            // Admin panel
            if (_currentUserRole === 'admin') {
                $('#cloud-admin-panel')?.classList.remove('hidden');
                _loadAdminUserList();
            } else {
                $('#cloud-admin-panel')?.classList.add('hidden');
            }
            const status = getSyncStatus();
            const lastSyncEl = $('#cloud-last-sync');
            if (lastSyncEl && status.lastSync) {
                lastSyncEl.textContent = new Date(status.lastSync).toLocaleString('it-IT');
            }
        } else {
            // Show login form
            $('#cloud-auth-tabs').classList.remove('hidden');
            $('#cloud-login-form').classList.remove('hidden');
            $('#cloud-register-form').classList.add('hidden');
            $('#cloud-logged-in').classList.add('hidden');
            // Reset active tab
            document.querySelectorAll('.cloud-auth-tab').forEach(t => t.classList.remove('active'));
            document.querySelector('.cloud-auth-tab[data-tab="login"]')?.classList.add('active');
        }
        modal.classList.remove('hidden');
    }

    $('#btn-cloud-sync')?.addEventListener('click', _openCloudModal);
    $('#btn-cloud-from-upload')?.addEventListener('click', _openCloudModal);

    // Close modal
    $('#cloud-modal-close')?.addEventListener('click', () => modal.classList.add('hidden'));
    modal.querySelector('.modal-backdrop')?.addEventListener('click', () => modal.classList.add('hidden'));

    // Tab switching
    document.querySelectorAll('.cloud-auth-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.cloud-auth-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const isLogin = tab.dataset.tab === 'login';
            $('#cloud-login-form').classList.toggle('hidden', !isLogin);
            $('#cloud-register-form').classList.toggle('hidden', isLogin);
            // Clear errors
            $('#cloud-login-error').classList.add('hidden');
            $('#cloud-register-error').classList.add('hidden');
        });
    });

    // Login form
    $('#cloud-login-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('#cloud-login-email').value.trim();
        const password = $('#cloud-login-password').value;
        const errEl = $('#cloud-login-error');
        errEl.classList.add('hidden');

        try {
            await signIn(email, password);
            modal.classList.add('hidden');
            updateCloudIndicator('syncing');

            _currentUserRole = await getUserRole();
            _currentUserEmail = email;
            const result = await initSync();
            updateCloudIndicator('connected');
            $('#cloud-user-email').textContent = email;
            _applyRoleRestrictions(_currentUserRole);

            if (result === 'pulled') {
                const saved = loadBaseline();
                if (saved) {
                    appData = saved;
                    $('#upload-overlay').classList.add('hidden');
                    $('#app').classList.remove('hidden');
                    initApp();
                }
            }
        } catch (err) {
            errEl.textContent = _translateAuthError(err.message);
            errEl.classList.remove('hidden');
        }
    });

    // Register form
    $('#cloud-register-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = $('#cloud-register-email').value.trim();
        const pw = $('#cloud-register-password').value;
        const pw2 = $('#cloud-register-password2').value;
        const errEl = $('#cloud-register-error');
        errEl.classList.add('hidden');

        if (pw !== pw2) {
            errEl.textContent = 'Le password non coincidono.';
            errEl.classList.remove('hidden');
            return;
        }

        try {
            const data = await signUp(email, pw);
            if (data.user && !data.session) {
                // Email confirmation required — try auto-login immediately
                try {
                    await signIn(email, pw);
                    _currentUserRole = await getUserRole();
                    _currentUserEmail = email;
                    _applyRoleRestrictions(_currentUserRole);
                    modal.classList.add('hidden');
                    updateCloudIndicator('syncing');
                    const result = await initSync();
                    updateCloudIndicator('connected');
                    // If data was pulled, load the app
                    if (result === 'pulled') {
                        const saved = loadBaseline();
                        if (saved) {
                            appData = saved;
                            $('#upload-overlay').classList.add('hidden');
                            $('#app').classList.remove('hidden');
                            initApp();
                        }
                    }
                } catch {
                    // Auto-login failed (email confirmation enforced)
                    errEl.textContent = 'Registrazione completata! Controlla la tua email per confermare, poi accedi.';
                    errEl.style.background = 'rgba(34,197,94,.1)';
                    errEl.style.color = 'var(--success, #22c55e)';
                    errEl.classList.remove('hidden');
                }
            } else if (data.session) {
                // Auto-confirmed, proceed to sync
                _currentUserRole = await getUserRole();
                _currentUserEmail = email;
                _applyRoleRestrictions(_currentUserRole);
                modal.classList.add('hidden');
                updateCloudIndicator('syncing');
                const result = await initSync();
                updateCloudIndicator('connected');
                if (result === 'pulled') {
                    const saved = loadBaseline();
                    if (saved) {
                        appData = saved;
                        $('#upload-overlay').classList.add('hidden');
                        $('#app').classList.remove('hidden');
                        initApp();
                    }
                }
            }
        } catch (err) {
            errEl.textContent = _translateAuthError(err.message);
            errEl.classList.remove('hidden');
        }
    });

    // Logout
    $('#btn-cloud-logout')?.addEventListener('click', async () => {
        try {
            stopSync();
            await signOut();
            _currentUserRole = null;
            _currentUserEmail = null;
            updateCloudIndicator('disconnected');
            $('#viewer-banner')?.classList.add('hidden');
            modal.classList.add('hidden');
        } catch (err) {
            console.error('[CloudAuth] logout error:', err);
        }
    });

    // Force push/pull — NO native confirm() to avoid Electron focus loss
    $('#btn-cloud-force-push')?.addEventListener('click', async () => {
        try {
            modal.classList.add('hidden');
            updateCloudIndicator('syncing');
            await fullPush();
            updateCloudIndicator('connected');
            const lastSyncEl = $('#cloud-last-sync');
            if (lastSyncEl) lastSyncEl.textContent = new Date().toLocaleString('it-IT');
            _restoreFocus();
        } catch (err) {
            console.error('[CloudSync] force push error:', err);
            updateCloudIndicator('error');
            _restoreFocus();
        }
    });

    $('#btn-cloud-force-pull')?.addEventListener('click', async () => {
        try {
            modal.classList.add('hidden');
            updateCloudIndicator('syncing');
            await fullPull();
            updateCloudIndicator('connected');
            const lastSyncEl = $('#cloud-last-sync');
            if (lastSyncEl) lastSyncEl.textContent = new Date().toLocaleString('it-IT');
            const saved = loadBaseline();
            if (saved) {
                appData = saved;
                initApp();
            }
            _restoreFocus();
        } catch (err) {
            console.error('[CloudSync] force pull error:', err);
            updateCloudIndicator('error');
            _restoreFocus();
        }
    });

    // Conflict modal handlers
    $('#cloud-conflict-close')?.addEventListener('click', () => conflictModal?.classList.add('hidden'));
    conflictModal?.querySelector('.modal-backdrop')?.addEventListener('click', () => conflictModal?.classList.add('hidden'));
    $('#btn-conflict-local')?.addEventListener('click', async () => {
        conflictModal?.classList.add('hidden');
        updateCloudIndicator('syncing');
        await fullPush();
        updateCloudIndicator('connected');
    });
    $('#btn-conflict-cloud')?.addEventListener('click', async () => {
        conflictModal?.classList.add('hidden');
        updateCloudIndicator('syncing');
        await fullPull();
        updateCloudIndicator('connected');
        const saved = loadBaseline();
        if (saved) { appData = saved; initApp(); }
        setTimeout(() => document.body.focus(), 100);
    });
    $('#btn-conflict-merge')?.addEventListener('click', async () => {
        conflictModal?.classList.add('hidden');
        updateCloudIndicator('syncing');
        await incrementalSync();
        updateCloudIndicator('connected');
    });
}

function _applyRoleRestrictions(role) {
    const viewerBanner = $('#viewer-banner');
    const testerBanner = $('#tester-banner');
    const pushBtn = $('#btn-cloud-force-push');

    // Viewer: read-only banner, push disabled
    if (role === 'viewer') {
        viewerBanner?.classList.remove('hidden');
        testerBanner?.classList.add('hidden');
        if (pushBtn) { pushBtn.disabled = true; pushBtn.title = 'Sola lettura'; }
    } else if (role === 'tester') {
        // Tester: sandbox banner, push disabled (download only)
        viewerBanner?.classList.add('hidden');
        testerBanner?.classList.remove('hidden');
        if (pushBtn) { pushBtn.disabled = true; pushBtn.title = 'Modalità test — upload disabilitato'; }
    } else {
        viewerBanner?.classList.add('hidden');
        testerBanner?.classList.add('hidden');
        if (pushBtn) { pushBtn.disabled = false; pushBtn.title = 'Invia tutti i dati locali al cloud'; }
    }

    // Scenario buttons: disabled for viewer and hr (tester CAN edit locally)
    const scenarioWriteDisabled = (role === 'viewer' || role === 'hr');
    const scenarioBtns = [
        '#btn-new-scenario', '#btn-import-scenario', '#btn-duplicate-scenario',
        '#btn-rename-scenario', '#btn-delete-scenario'
    ];
    scenarioBtns.forEach(sel => {
        const btn = $(sel);
        if (btn) {
            btn.disabled = scenarioWriteDisabled;
            if (scenarioWriteDisabled) btn.title = 'Non hai i permessi per modificare gli scenari';
        }
    });

    // Resource/Persone buttons: disabled for viewer and commercial (tester CAN edit locally)
    const personeWriteDisabled = (role === 'viewer' || role === 'commercial');
    const personeBtns = ['#btn-res-add-persona', '#btn-res-pm-save'];
    personeBtns.forEach(sel => {
        const btn = $(sel);
        if (btn) {
            btn.disabled = personeWriteDisabled;
            if (personeWriteDisabled) btn.title = 'Non hai i permessi per modificare le risorse';
        }
    });

    // Allocazioni buttons: disabled for viewer and hr (tester CAN edit locally)
    const allocWriteDisabled = (role === 'viewer' || role === 'hr');
    const allocBtns = ['#btn-res-add-alloc', '#btn-res-alloc-save', '#btn-res-copy-confirm'];
    allocBtns.forEach(sel => {
        const btn = $(sel);
        if (btn) {
            btn.disabled = allocWriteDisabled;
            if (allocWriteDisabled) btn.title = 'Non hai i permessi per modificare le allocazioni';
        }
    });

    // Gestione Scenari tab: visible only for admin
    const gestioneTab = $('#tab-btn-gestione-scenari');
    if (gestioneTab) {
        if (role === 'admin') {
            gestioneTab.classList.remove('hidden');
        } else {
            gestioneTab.classList.add('hidden');
        }
    }

    // Tester: update push button and banner for draft mode
    if (role === 'tester') {
        if (pushBtn) { pushBtn.disabled = false; pushBtn.title = 'Invia scenari come bozze al cloud'; }
    }
}

async function _loadAdminUserList() {
    const container = $('#cloud-users-list');
    if (!container) return;
    try {
        const users = await listUsers();
        container.innerHTML = users.map(u => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;">
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;">${u.email || u.user_id.substring(0, 12) + '...'}</span>
                <select data-uid="${u.user_id}" class="role-select" style="font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid var(--border);background:var(--bg-2);color:var(--text);">
                    <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                    <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>Editor</option>
                    <option value="hr" ${u.role === 'hr' ? 'selected' : ''}>HR</option>
                    <option value="commercial" ${u.role === 'commercial' ? 'selected' : ''}>Commercial</option>
                    <option value="tester" ${u.role === 'tester' ? 'selected' : ''}>Tester</option>
                    <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                </select>
            </div>
        `).join('');

        container.querySelectorAll('.role-select').forEach(sel => {
            sel.addEventListener('change', async (e) => {
                try {
                    await updateUserRole(e.target.dataset.uid, e.target.value);
                } catch (err) {
                    alert('Errore nel cambio ruolo: ' + err.message);
                    _loadAdminUserList(); // Reload to reset
                }
            });
        });
    } catch (err) {
        container.innerHTML = '<p style="font-size:11px;color:var(--danger);">Errore caricamento utenti</p>';
    }
}

function _translateAuthError(msg) {
    if (msg.includes('Invalid login')) return 'Email o password non validi.';
    if (msg.includes('already registered')) return 'Questa email e\' gia\' registrata.';
    if (msg.includes('Password should be')) return 'La password deve avere almeno 6 caratteri.';
    if (msg.includes('rate limit')) return 'Troppi tentativi. Riprova tra qualche minuto.';
    if (msg.includes('network')) return 'Errore di rete. Verifica la connessione.';
    return msg;
}

// ============================================================
//  FILE UPLOAD
// ============================================================
function setupFileUpload() {
    const input = $('#file-input');
    const overlay = $('#upload-overlay');
    const dropZone = $('#drop-zone');

    // Click handler
    input.addEventListener('change', (e) => handleFile(e.target.files[0]));

    // Drag & Drop handlers
    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!overlay.classList.contains('hidden')) {
            dropZone.classList.add('dragging');
        }
    });

    window.addEventListener('dragleave', (e) => {
        if (e.target === window || e.target === document) {
            dropZone.classList.remove('dragging');
        }
    });

    window.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragging');
        if (overlay.classList.contains('hidden')) return;
        if (e.dataTransfer.files.length) {
            handleFile(e.dataTransfer.files[0]);
        }
    });
}

async function handleFile(file) {
    if (!file) return;

    const overlay = $('#upload-overlay');
    const prog = $('#upload-progress');
    const fill = $('#progress-fill');
    const txt = $('#progress-text');

    prog.classList.remove('hidden');
    fill.style.width = '20%';
    txt.textContent = 'Lettura file...';

    try {
        const buf = await file.arrayBuffer();
        fill.style.width = '60%';
        txt.textContent = 'Parsing dati...';

        appData = parseExcel(buf);
        saveBaseline(appData);
        fill.style.width = '90%';
        txt.textContent = 'Inizializzazione...';

        await new Promise(r => setTimeout(r, 300));
        fill.style.width = '100%';
        txt.textContent = 'Fatto!';

        await new Promise(r => setTimeout(r, 400));
        overlay.classList.add('hidden');
        $('#app').classList.remove('hidden');

        initApp();
    } catch (err) {
        txt.textContent = '❌ Errore: ' + err.message;
        fill.style.width = '100%';
        fill.style.background = 'var(--danger)';
        console.error(err);
    }
}

function setupUpdateImport() {
    const btn = $('#btn-import-scenario');
    const input = $('#update-file-input');

    btn?.addEventListener('click', () => input.click());

    input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        input.value = ''; // Reset so the same file can be re-imported
        if (!file || !appData) return;

        try {
            const buf = await file.arrayBuffer();
            const { monthlyData: importedData, typeFromFile, settoreFromFile, inputOverrides, fileIsUnweighted } = parseImportedScenario(buf);

            // Create a new scenario of type 'imported'
            const name = file.name.replace(/\.[^/.]+$/, "") || 'Scenario Importato';
            const scen = createScenario(name, 'Importato da Excel', 'imported', importedData, _currentUserEmail);

            // Auto-apply type overrides from the imported file
            if (typeFromFile) {
                for (const [key, newType] of Object.entries(typeFromFile)) {
                    const baseComm = appData.commesse.find(c => c.key === key);
                    if (baseComm && newType && newType !== baseComm.type) {
                        updateScenarioInput(scen.id, key, { type: newType });
                    }
                }
            }

            // Auto-apply probabilità / margine WhatIf dal file (solo se diversi dalla baseline)
            if (inputOverrides) {
                for (const [key, overrides] of Object.entries(inputOverrides)) {
                    const baseComm = appData.commesse.find(c => c.key === key);
                    const toApply = {};
                    if (overrides.probabilita != null) {
                        const baseProb = baseComm ? Math.round((baseComm.probabilitaAOP || 0) * 100) : null;
                        if (baseProb == null || overrides.probabilita !== baseProb) {
                            toApply.probabilita = overrides.probabilita;
                        }
                        // probabilitaFile = riferimento per il calcolo di probScale in computeScenario.
                        // Nuovo formato (VDP Remaining = 100% non pesato): il file è già al lordo,
                        // quindi fileProb = 1.0 → probabilitaFile = 100.
                        // Vecchio formato (SIL Remaining = già pesato): probabilitaFile = prob del file.
                        toApply.probabilitaFile = fileIsUnweighted ? 100 : overrides.probabilita;
                    }
                    if (overrides.margine != null) {
                        const baseMarg = baseComm ? parseFloat(((baseComm.margineAOP || 0) * 100).toFixed(2)) : null;
                        if (baseMarg == null || overrides.margine !== baseMarg) {
                            toApply.margine = overrides.margine;
                        }
                    }
                    if (Object.keys(toApply).length) {
                        updateScenarioInput(scen.id, key, toApply);
                    }
                }
            }

            // Identifica commesse presenti nel file scenario ma non nell'AOP baseline
            const newCommesse = [];
            for (const key of Object.keys(importedData)) {
                if (!appData.commesse.find(c => c.key === key)) {
                    const [codice, nome] = key.split('|||');
                    newCommesse.push({
                        key,
                        codice: codice || '',
                        nome: nome || '',
                        settore: (settoreFromFile && settoreFromFile[key]) || '',
                        type: (typeFromFile && typeFromFile[key]) || 'Order Intake',
                        probabilitaAOP: 0,
                        margineAOP: 0,
                        vdpTotale: 0,
                    });
                }
            }
            if (newCommesse.length > 0) {
                updateScenario(scen.id, { newCommesse });
            }

            activeScenarioId = scen.id;
            comparedScenarioIds = null;
            loadScenarioList();
            $('#active-scenario-select').value = scen.id;

            refreshDashboard();
            renderAssumptionsTable();
            alert('Scenario importato con successo!');
        } catch (err) {
            alert('Errore durante l\'importazione: ' + err.message);
            console.error(err);
        }
    });
}



function setupChangeFileButton() {
    $('#btn-change-file')?.addEventListener('click', () => {
        clearBaseline();
        appData = null;
        activeScenarioId = null;
        comparedScenarioIds = null;
        lastResult = null;
        Object.values(charts).forEach(c => c.destroy());
        charts = {};
        $('#app').classList.add('hidden');
        $('#upload-overlay').classList.remove('hidden');
        // Reset progress bar
        const prog = $('#upload-progress');
        const fill = $('#progress-fill');
        if (prog) prog.classList.add('hidden');
        if (fill) { fill.style.width = '0%'; fill.style.background = ''; }
    });
}

// ============================================================
//  APP INIT (after data loaded)
// ============================================================
function initApp() {
    populateFilters();
    loadScenarioList();
    renderDashboard();
    renderAssumptionsTable();
    _restoreFocus();
}

// ============================================================
//  FILTERS (toggle-chip based)
// ============================================================
function populateFilters() {
    const { filters, allMonths, commesse } = appData;

    // Settore chips (ricreati ad ogni initApp — nessun listener diretto, usa delegation)
    const settoreContainer = $('#filter-settore');
    settoreContainer.innerHTML = '';
    for (const s of filters.settori) {
        const btn = document.createElement('button');
        btn.className = 'filter-chip';
        btn.dataset.value = s;
        btn.textContent = s;
        settoreContainer.appendChild(btn);
    }

    // Type chips — statici in HTML, nessun listener diretto (usa delegation)
    // Non serve fare nulla: il click è gestito da setupFilterEvents una volta sola.

    // Commessa chips (ricreati ad ogni initApp — nessun listener diretto, usa delegation)
    const commContainer = $('#filter-commessa');
    commContainer.innerHTML = '';
    for (const c of commesse) {
        const btn = document.createElement('button');
        btn.className = 'filter-chip';
        btn.dataset.value = c.key;
        btn.dataset.settore = c.settore;
        btn.dataset.type = c.type;
        btn.dataset.search = `${c.codice} ${c.nome}`.toLowerCase();
        btn.textContent = `${c.codice} — ${c.nome}`;
        commContainer.appendChild(btn);
    }

    // Date range
    if (allMonths.length) {
        $('#filter-date-from').value = allMonths[0];
        $('#filter-date-to').value = allMonths[allMonths.length - 1];
    }
}

function getActiveFilters() {
    const settore = Array.from($$('#filter-settore .filter-chip.active')).map(b => b.dataset.value);
    const types = Array.from($$('#filter-type .filter-chip.active')).map(b => b.dataset.value);
    const commesse = Array.from($$('#filter-commessa .filter-chip.active')).map(b => b.dataset.value);
    return {
        settori: settore,
        types: types,
        commesse: commesse,
        dateFrom: $('#filter-date-from').value || null,
        dateTo: $('#filter-date-to').value || null,
    };
}

function setupFilterEvents() {
    // ── Event delegation sui container dei filtri ──────────────────────────
    // Un singolo listener per container, impostato UNA VOLTA sola.
    // Funziona sia per chip statici HTML sia per chip aggiunti dinamicamente.
    // Previene l'accumulo di listener duplicati che si cancellano a vicenda.
    $('#filter-settore')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        chip.classList.toggle('active');
        filterSidebarCommesse();
        refreshDashboard();
        if (document.querySelector('.tab-btn.active')?.dataset.tab === 'risorse') renderResourceTab();
    });

    $('#filter-type')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        chip.classList.toggle('active');
        filterSidebarCommesse();
        refreshDashboard();
        if (document.querySelector('.tab-btn.active')?.dataset.tab === 'risorse') renderResourceTab();
    });

    $('#filter-commessa')?.addEventListener('click', (e) => {
        const chip = e.target.closest('.filter-chip');
        if (!chip) return;
        chip.classList.toggle('active');
        refreshDashboard();
        // Se il tab risorse è attivo, aggiorna anche quello
        if (document.querySelector('.tab-btn.active')?.dataset.tab === 'risorse') {
            renderResourceTab();
        }
    });

    // Date inputs
    for (const sel of ['#filter-date-from', '#filter-date-to']) {
        $(sel)?.addEventListener('change', () => {
            // Deseleziona eventuali shortcut anno attivi quando la data viene cambiata manualmente
            $$('.btn-year-shortcut.active').forEach(b => b.classList.remove('active'));
            refreshDashboard();
            if (document.querySelector('.tab-btn.active')?.dataset.tab === 'risorse') renderResourceTab();
        });
    }

    // Shortcut annualità
    $$('.btn-year-shortcut').forEach(btn => {
        btn.addEventListener('click', () => {
            const year = btn.dataset.year;
            const isRisorse = document.querySelector('.tab-btn.active')?.dataset.tab === 'risorse';
            const isActive = btn.classList.contains('active');

            // Toggle: se già attivo lo deseleziono e ripristino range completo
            if (isActive) {
                btn.classList.remove('active');
                if (appData?.allMonths?.length) {
                    $('#filter-date-from').value = appData.allMonths[0];
                    $('#filter-date-to').value = appData.allMonths[appData.allMonths.length - 1];
                }
            } else {
                // Deseleziona gli altri shortcut e attiva questo
                $$('.btn-year-shortcut.active').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                $('#filter-date-from').value = `${year}-01`;
                $('#filter-date-to').value = `${year}-12`;
            }
            refreshDashboard();
            if (isRisorse) renderResourceTab();
        });
    });

    // Commessa Search
    $('#commessa-search')?.addEventListener('input', () => {
        filterSidebarCommesse();
    });

    $('#btn-reset-filters')?.addEventListener('click', () => {
        // Remove active class from all chips
        $$('.filter-chip.active').forEach(c => c.classList.remove('active'));
        // Deseleziona shortcut anno
        $$('.btn-year-shortcut.active').forEach(b => b.classList.remove('active'));

        // Clear search
        const searchInput = $('#commessa-search');
        if (searchInput) {
            searchInput.value = '';
        }
        filterSidebarCommesse();

        if (appData?.allMonths?.length) {
            $('#filter-date-from').value = appData.allMonths[0];
            $('#filter-date-to').value = appData.allMonths[appData.allMonths.length - 1];
        }
        refreshDashboard();
        const isRisorse = $('#tab-risorse')?.classList.contains('active');
        if (isRisorse) renderResourceTab();
    });
}


// ============================================================
//  THEME TOGGLE
// ============================================================
function initTheme() {
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    updateThemeUI(savedTheme);
}

function setupThemeToggle() {
    $('#btn-theme-toggle')?.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        updateThemeUI(newTheme);
    });
}

function updateThemeUI(theme) {
    const sunIcon = $('#btn-theme-toggle .sun');
    const moonIcon = $('#btn-theme-toggle .moon');
    if (theme === 'light') {
        sunIcon?.classList.add('hidden');
        moonIcon?.classList.remove('hidden');
    } else {
        sunIcon?.classList.remove('hidden');
        moonIcon?.classList.add('hidden');
    }
}

// ============================================================
//  TABS
// ============================================================
function setupTabs() {
    for (const btn of $$('.tab-btn')) {
        btn.addEventListener('click', () => {
            $$('.tab-btn').forEach(b => b.classList.remove('active'));
            $$('.tab-panel').forEach(p => p.classList.remove('active'));
            btn.classList.add('active');
            $(`#tab-${btn.dataset.tab}`).classList.add('active');

            // Re-render charts for the newly activated tab
            const tab = btn.dataset.tab;
            if (tab === 'assumptions') return;
            if (tab === 'risorse') { renderResourceTab(); return; }
            if (tab === 'scenario-compare') { renderScenarioCompareTable(); return; }
            if (tab === 'gestione-scenari') { renderGestioneScenari(); return; }
            if (!lastResult) return;
            Object.values(charts).forEach(c => c.destroy());
            charts = {};
            if (tab === 'dashboard')          renderCharts(lastResult.monthly, lastResult.commessaResults);
            else if (tab === 'details')       renderDetailsCharts(lastResult.monthly, lastResult.commessaResults);
            else if (tab === 'details-type')  renderDetailsTypeCharts(lastResult.monthly, lastResult.commessaResults);
            else if (tab === 'analisi')       renderAnalisiCharts(lastResult.monthly, lastResult.commessaResults);
        });
    }
}

// ============================================================
//  SCENARIO MANAGEMENT
// ============================================================
function loadScenarioList() {
    const sel = $('#active-scenario-select');
    const scenarios = listScenarios();
    sel.innerHTML = '';

    // Always add a "Baseline (no modifications)" option
    const baseOpt = document.createElement('option');
    baseOpt.value = '__baseline__';
    baseOpt.textContent = '— Baseline (nessuna modifica) —';
    sel.appendChild(baseOpt);

    for (const s of scenarios) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.locked ? '\uD83D\uDD12 ' + s.name : s.name;
        sel.appendChild(opt);
    }

    if (activeScenarioId) {
        sel.value = activeScenarioId;
    }

    sel.addEventListener('change', () => {
        activeScenarioId = sel.value === '__baseline__' ? null : sel.value;
        comparedScenarioIds = null; // esci da modalità confronto se attiva
        refreshDashboard();
        renderAssumptionsTable();
        if (document.querySelector('.tab-btn.active')?.dataset.tab === 'risorse') {
            renderResourceTab();
        }
    });

    loadScenariCompareSelects(scenarios);
}

function loadScenariCompareSelects(scenarios) {
    if (!scenarios) scenarios = listScenarios();
    for (const selId of ['#compare-scen-a', '#compare-scen-b']) {
        const sel = $(selId);
        if (!sel) continue;
        const prev = sel.value;
        sel.innerHTML = '';
        const baseOpt = document.createElement('option');
        baseOpt.value = '__baseline__';
        baseOpt.textContent = '— Baseline —';
        sel.appendChild(baseOpt);
        for (const s of scenarios) {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name;
            sel.appendChild(opt);
        }
        if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
    }
}

function setupScenarioButtons() {
    $('#btn-new-scenario')?.addEventListener('click', () => {
        openModal('new-scenario-modal');
        $('#new-scenario-name').value = '';
        $('#new-scenario-notes').value = '';
    });

    $('#btn-create-scenario')?.addEventListener('click', () => {
        const name = $('#new-scenario-name').value.trim() || 'Nuovo Scenario';
        const notes = $('#new-scenario-notes').value.trim();
        const scen = createScenario(name, notes, 'calculated', null, _currentUserEmail);
        activeScenarioId = scen.id;
        loadScenarioList();
        $('#active-scenario-select').value = scen.id;
        closeModal('new-scenario-modal');
        comparedScenarioIds = null; // Exit comparison mode
        refreshDashboard();
        renderAssumptionsTable();
    });

    $('#btn-duplicate-scenario')?.addEventListener('click', () => {
        if (!activeScenarioId) return;
        const orig = getScenario(activeScenarioId);
        if (!orig) return;
        $('#duplicate-scenario-name').value = orig.name + ' (copia)';
        $('#duplicate-scenario-notes').value = orig.notes || '';
        openModal('duplicate-scenario-modal');
    });

    $('#btn-confirm-duplicate')?.addEventListener('click', () => {
        if (!activeScenarioId) return;
        const name = $('#duplicate-scenario-name').value.trim() || 'Scenario (copia)';
        const notes = $('#duplicate-scenario-notes').value.trim();
        const sourceId = activeScenarioId;
        const dup = duplicateScenario(activeScenarioId, { name, notes, createdBy: _currentUserEmail });
        if (dup) {
            activeScenarioId = dup.id;
            onScenarioDuplicated(dup.id, sourceId);
            loadScenarioList();
            $('#active-scenario-select').value = dup.id;
            comparedScenarioIds = null;
            closeModal('duplicate-scenario-modal');
            refreshDashboard();
            renderAssumptionsTable();
        }
    });

    $('#btn-rename-scenario')?.addEventListener('click', () => {
        if (!activeScenarioId) return;
        const scen = getScenario(activeScenarioId);
        if (!scen) return;
        if (scen.locked) { alert('Questo scenario è bloccato e non può essere rinominato.'); return; }
        $('#rename-scenario-name').value = scen.name;
        $('#rename-scenario-notes').value = scen.notes || '';
        openModal('rename-scenario-modal');
    });

    $('#btn-confirm-rename')?.addEventListener('click', () => {
        if (!activeScenarioId) return;
        const name = $('#rename-scenario-name').value.trim();
        if (!name) return;
        const notes = $('#rename-scenario-notes').value.trim();
        updateScenario(activeScenarioId, { name, notes });
        loadScenarioList();
        $('#active-scenario-select').value = activeScenarioId;
        closeModal('rename-scenario-modal');
        refreshDashboard();
    });

    $('#btn-delete-scenario')?.addEventListener('click', () => {
        if (!activeScenarioId) return;
        const scenDel = getScenario(activeScenarioId);
        if (scenDel?.locked) { alert('Questo scenario è bloccato e non può essere eliminato.'); return; }
        if (!confirm('Eliminare questo scenario?')) return;
        trackDeletion('scenario', activeScenarioId);
        deleteScenario(activeScenarioId);
        activeScenarioId = null;
        loadScenarioList();
        comparedScenarioIds = null; // Exit comparison mode
        refreshDashboard();
        renderAssumptionsTable();
        _restoreFocus();
    });

    // Gestione Scenari: refresh button (clear cache to force re-fetch)
    $('#btn-refresh-gestione')?.addEventListener('click', () => { _gestioneCloudData = null; renderGestioneScenari(); });
}

// ============================================================
//  GESTIONE SCENARI (Admin Page)
// ============================================================
let _gestioneCloudData = null; // cached cloud data for filtering
let _gestioneFilter = 'all';

async function renderGestioneScenari(useCache = false) {
    const container = $('#gestione-scenari-container');
    if (!container) return;

    // Setup filter and search listeners (once)
    _setupGestioneListeners();

    if (!useCache || !_gestioneCloudData) {
        container.textContent = 'Caricamento scenari dal cloud...';
        try {
            _gestioneCloudData = await fetchAllScenariosFromCloud();
        } catch (err) {
            container.textContent = 'Errore: ' + err.message;
            console.error('[GestioneScenari] fetch error:', err);
            return;
        }
    }

    const cloudRows = _gestioneCloudData || [];
    const searchQuery = ($('#gestione-search-input')?.value || '').toLowerCase().trim();

    // Apply filters
    const filtered = cloudRows.filter(row => {
        const scen = row.data || {};
        const isDeleted = !!row.deleted;
        const isDraft = !!row.draft;
        const isLocked = !!scen.locked;

        // Filter by status
        if (_gestioneFilter === 'active' && (isDeleted || isDraft || isLocked)) return false;
        if (_gestioneFilter === 'draft' && !isDraft) return false;
        if (_gestioneFilter === 'locked' && !isLocked) return false;
        if (_gestioneFilter === 'deleted' && !isDeleted) return false;
        if (_gestioneFilter === 'all' && isDeleted) return false; // "Tutti" hides deleted by default

        // Search by name or creator
        if (searchQuery) {
            const name = (scen.name || '').toLowerCase();
            const creator = (row.created_by_email || scen.createdBy || '').toLowerCase();
            if (!name.includes(searchQuery) && !creator.includes(searchQuery)) return false;
        }

        return true;
    });

    if (filtered.length === 0) {
        container.textContent = _gestioneFilter === 'deleted'
            ? 'Nessuno scenario eliminato.'
            : 'Nessuno scenario trovato.';
        return;
    }

    // Count label
    const countDiv = document.createElement('div');
    countDiv.className = 'gestione-count';
    countDiv.textContent = filtered.length + ' scenario' + (filtered.length !== 1 ? 'i' : '') + ' trovato' + (filtered.length !== 1 ? 'i' : '');

    const table = document.createElement('table');
    table.className = 'gestione-table';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Nome', 'Tipo', 'Creato da', 'Aggiornato', 'Stato', 'Azioni'].forEach(text => {
        const th = document.createElement('th');
        th.textContent = text;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');

    for (const row of filtered) {
        const scen = row.data || {};
        const isDeleted = !!row.deleted;
        const tr = document.createElement('tr');
        if (isDeleted) tr.className = 'row-deleted';

        // Nome
        const tdName = document.createElement('td');
        tdName.textContent = scen.name || row.local_id;
        tdName.style.fontWeight = '600';
        tr.appendChild(tdName);

        // Tipo
        const tdType = document.createElement('td');
        const typeBadge = document.createElement('span');
        typeBadge.className = scen.type === 'imported' ? 'type-badge order-intake' : 'type-badge backlog';
        typeBadge.textContent = scen.type === 'imported' ? 'Importato' : 'Calcolato';
        tdType.appendChild(typeBadge);
        tr.appendChild(tdType);

        // Creato da
        const tdCreator = document.createElement('td');
        tdCreator.textContent = row.created_by_email || scen.createdBy || '\u2014';
        tdCreator.style.fontSize = '11px';
        tr.appendChild(tdCreator);

        // Aggiornato
        const tdUpdated = document.createElement('td');
        tdUpdated.textContent = scen.updatedAt
            ? new Date(scen.updatedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
            : '\u2014';
        tdUpdated.style.fontSize = '11px';
        tr.appendChild(tdUpdated);

        // Stato (badges + lock info)
        const tdStatus = document.createElement('td');
        if (isDeleted) {
            const badge = document.createElement('span');
            badge.className = 'badge badge-deleted';
            badge.textContent = 'Eliminato';
            tdStatus.appendChild(badge);
        } else {
            if (row.draft) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-draft';
                badge.textContent = 'Bozza';
                tdStatus.appendChild(badge);
            }
            if (scen.locked) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-locked';
                badge.textContent = 'Bloccato';
                tdStatus.appendChild(badge);
                // Show who locked and when
                if (scen.lockedBy || scen.lockedAt) {
                    const info = document.createElement('div');
                    info.className = 'gestione-lock-info';
                    const parts = [];
                    if (scen.lockedBy) parts.push('da ' + scen.lockedBy);
                    if (scen.lockedAt) parts.push('il ' + new Date(scen.lockedAt).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
                    info.textContent = parts.join(' ');
                    tdStatus.appendChild(info);
                }
            }
            if (!row.draft && !scen.locked) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-active';
                badge.textContent = 'Attivo';
                tdStatus.appendChild(badge);
            }
        }
        tr.appendChild(tdStatus);

        // Azioni
        const tdActions = document.createElement('td');
        tdActions.className = 'gestione-actions';

        if (isDeleted) {
            // Restore button for deleted scenarios
            const restoreBtn = document.createElement('button');
            restoreBtn.className = 'btn btn-outline btn-xs';
            restoreBtn.style.color = 'var(--success)';
            restoreBtn.textContent = 'Ripristina';
            restoreBtn.addEventListener('click', () => _gestioneAction('restore', row.local_id, scen.name || row.local_id, scen));
            tdActions.appendChild(restoreBtn);
        } else {
            // Lock/Unlock
            const lockBtn = document.createElement('button');
            lockBtn.className = 'btn btn-outline btn-xs';
            lockBtn.textContent = scen.locked ? 'Sblocca' : 'Blocca';
            lockBtn.addEventListener('click', () => _gestioneAction(scen.locked ? 'unlock' : 'lock', row.local_id, scen.name || row.local_id, scen));
            tdActions.appendChild(lockBtn);

            // Approve (only if draft)
            if (row.draft) {
                const approveBtn = document.createElement('button');
                approveBtn.className = 'btn btn-outline btn-xs';
                approveBtn.style.color = 'var(--success)';
                approveBtn.textContent = 'Approva';
                approveBtn.addEventListener('click', () => _gestioneAction('approve', row.local_id, scen.name || row.local_id, scen));
                tdActions.appendChild(approveBtn);
            }

            // Delete
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'btn btn-outline btn-xs';
            deleteBtn.style.color = 'var(--danger)';
            deleteBtn.textContent = 'Elimina';
            deleteBtn.addEventListener('click', () => _gestioneAction('delete', row.local_id, scen.name || row.local_id, scen));
            tdActions.appendChild(deleteBtn);
        }

        tr.appendChild(tdActions);
        tbody.appendChild(tr);
    }

    table.appendChild(tbody);
    container.textContent = '';
    container.appendChild(countDiv);
    container.appendChild(table);
}

let _gestioneListenersSetup = false;
function _setupGestioneListeners() {
    if (_gestioneListenersSetup) return;
    _gestioneListenersSetup = true;

    // Filter buttons
    document.addEventListener('click', e => {
        const btn = e.target.closest('.gestione-filter-btn');
        if (!btn || !btn.dataset.filter) return;
        _gestioneFilter = btn.dataset.filter;
        $$('.gestione-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === _gestioneFilter));
        renderGestioneScenari(true); // use cached data
    });

    // Search input
    let searchTimer = null;
    $('#gestione-search-input')?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => renderGestioneScenari(true), 250); // debounce
    });
}

function _gestioneAction(action, localId, scenName, cloudScenData) {
    const titles = {
        lock: 'Bloccare scenario?',
        unlock: 'Sbloccare scenario?',
        approve: 'Approvare bozza?',
        delete: 'Eliminare scenario?',
        restore: 'Ripristinare scenario?'
    };
    const messages = {
        lock: 'Lo scenario "' + scenName + '" sarà bloccato. Nessuno potrà modificarlo o eliminarlo.',
        unlock: 'Lo scenario "' + scenName + '" sarà sbloccato e nuovamente modificabile.',
        approve: 'La bozza "' + scenName + '" diventerà visibile a tutti gli utenti.',
        delete: 'Lo scenario "' + scenName + '" sarà eliminato definitivamente dal cloud.',
        restore: 'Lo scenario "' + scenName + '" sarà ripristinato e tornerà visibile a tutti.'
    };

    $('#gestione-confirm-title').textContent = titles[action] || 'Conferma';
    $('#gestione-confirm-text').textContent = messages[action] || '';
    openModal('gestione-confirm-modal');

    const okBtn = $('#gestione-confirm-ok');
    const cancelBtn = $('#gestione-confirm-cancel');

    // Clone and replace to remove old listeners
    const newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

    newCancel.addEventListener('click', () => closeModal('gestione-confirm-modal'));

    newOk.addEventListener('click', async () => {
        closeModal('gestione-confirm-modal');
        try {
            if (action === 'lock') {
                let updated = lockScenario(localId, _currentUserEmail);
                if (!updated && cloudScenData) {
                    updated = { ...cloudScenData, locked: true, lockedBy: _currentUserEmail, lockedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
                }
                if (updated) await pushSingleScenario(localId, updated);
            } else if (action === 'unlock') {
                let updated = unlockScenario(localId);
                if (!updated && cloudScenData) {
                    updated = { ...cloudScenData, locked: false, lockedBy: null, lockedAt: null, updatedAt: new Date().toISOString() };
                }
                if (updated) await pushSingleScenario(localId, updated);
            } else if (action === 'approve') {
                await pushScenarioApproval(localId, false);
                setScenarioDraft(localId, false);
            } else if (action === 'delete') {
                await pushScenarioDelete(localId);
                deleteScenario(localId);
                trackDeletion('scenario', localId);
            } else if (action === 'restore') {
                await pushScenarioRestore(localId);
            }
            // Refresh: clear cache to re-fetch from cloud
            _gestioneCloudData = null;
            loadScenarioList();
            renderGestioneScenari();
        } catch (err) {
            alert('Errore: ' + err.message);
            console.error('[GestioneScenari] action error:', err);
        }
    });
}

// ============================================================
//  SIDEBAR FILTER SYNC
// ============================================================
function filterSidebarCommesse() {
    const activeSettori = Array.from($$('#filter-settore .filter-chip.active')).map(b => b.dataset.value);
    const activeTypes = Array.from($$('#filter-type .filter-chip.active')).map(b => b.dataset.value);
    const searchQuery = ($('#commessa-search')?.value || '').toLowerCase().trim();

    $$('#filter-commessa .filter-chip').forEach(chip => {
        let visible = true;

        // Filter by settore
        if (activeSettori.length && !activeSettori.includes(chip.dataset.settore)) {
            visible = false;
        }

        // Filter by type
        if (activeTypes.length && !activeTypes.includes(chip.dataset.type)) {
            visible = false;
        }

        // Filter by search query
        if (searchQuery && !chip.dataset.search.includes(searchQuery)) {
            visible = false;
        }

        chip.style.display = visible ? 'flex' : 'none';
    });
}

// ============================================================
//  DASHBOARD RENDERING
// ============================================================
function refreshDashboard() {
    // Salva il tab attivo prima di qualsiasi render: Chart.js e operazioni DOM
    // possono causare scroll/focus che resettano la navigazione
    const activeTabId = document.querySelector('.tab-btn.active')?.dataset.tab;

    if (comparedScenarioIds && comparedScenarioIds.length) {
        const scenarios = comparedScenarioIds.map(id => getScenario(id)).filter(Boolean);
        const filters = getActiveFilters();
        const results = computeMultiScenario(appData.commesse, appData.monthlyData, scenarios, filters);
        renderCompareCharts(results);
    } else if (activeTabId === 'scenario-compare') {
        // scenario-compare non usa renderCharts — calcola i dati e aggiorna la tabella
        renderDashboard();
        renderScenarioCompareTable();
    } else {
        // renderDashboard → renderCharts gestisce già tutti i tab tramite routing interno
        renderDashboard();
    }

    // Also refresh assumptions table if it's currently relevant
    renderAssumptionsTable();

    // Ripristina il tab attivo (garantisce che filtri e refresh non cambino mai pagina)
    if (activeTabId) {
        $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === activeTabId));
        $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${activeTabId}`));
    }
}

function renderDashboard() {
    if (!appData) return;

    // Ripristina KPI normali (nasconde la riga compare se attiva)
    $('#kpi-row')?.classList.remove('hidden');
    $('#kpi-row-compare')?.classList.add('hidden');

    const filters = getActiveFilters();
    const scen = activeScenarioId ? getScenario(activeScenarioId) : null;
    const inputs = scen ? scen.inputs || {} : {};

    const scenNewCommesse = scen?.newCommesse || [];
    const commesseForCalc = scenNewCommesse.length > 0 ? [...appData.commesse, ...scenNewCommesse] : appData.commesse;
    lastResult = computeScenario(commesseForCalc, appData.monthlyData, scen || {}, filters);

    // Sync sidebar chip data-type with effective type (respects scenario overrides)
    const effectiveTypeMap = {};
    for (const c of lastResult.commessaResults) effectiveTypeMap[c.key] = c.effectiveType || c.type;
    $$('#filter-commessa .filter-chip').forEach(chip => {
        const et = effectiveTypeMap[chip.dataset.value];
        if (et) chip.dataset.type = et;
    });

    renderKPIs(lastResult.kpis);
    renderCharts(lastResult.monthly, lastResult.commessaResults);
    refreshTypeFilterChips(lastResult.commessaResults);
}

function refreshTypeFilterChips(commessaResults) {
    if (!commessaResults || !commessaResults.length) return;
    const typeContainer = $('#filter-type');
    if (!typeContainer) return;
    const effectiveTypes = new Set(commessaResults.map(c => c.effectiveType || c.type));
    const existingValues = new Set(Array.from(typeContainer.querySelectorAll('.filter-chip')).map(b => b.dataset.value));
    for (const et of effectiveTypes) {
        if (!existingValues.has(et)) {
            const btn = document.createElement('button');
            btn.className = 'filter-chip';
            btn.dataset.value = et;
            btn.textContent = et;
            // Nessun listener diretto: il click è gestito dalla delegation in setupFilterEvents
            typeContainer.appendChild(btn);
        }
    }
}

function formatCompact(n) {
    if (n == null || n === 0) return '';
    const abs = Math.abs(n);
    if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1).replace('.', ',') + ' M';
    if (abs >= 1_000) return (n / 1_000).toFixed(0) + ' K';
    return String(Math.round(n));
}

function formatEuro(n) {
    if (n == null) return '—';
    if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M€';
    if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(0) + ' k€';
    return Math.round(n).toLocaleString('it-IT') + ' €';
}

function _formatEuroExact(n) {
    if (n == null) return '';
    return Math.round(n).toLocaleString('it-IT') + ' €';
}

function renderKPIs(kpis) {
    const vdpBase = $('#kpi-val-vdp-base');
    const vdpScen = $('#kpi-val-vdp-scen');
    const marBase = $('#kpi-val-margin-base');
    const marScen = $('#kpi-val-margin-scen');

    vdpBase.textContent = formatEuro(kpis.totalBaseVDP);
    vdpScen.textContent = formatEuro(kpis.totalScenVDP);
    marBase.textContent = formatEuro(kpis.totalBaseMar);
    marScen.textContent = formatEuro(kpis.totalScenMar);

    vdpBase.title = _formatEuroExact(kpis.totalBaseVDP);
    vdpScen.title = _formatEuroExact(kpis.totalScenVDP);
    marBase.title = _formatEuroExact(kpis.totalBaseMar);
    marScen.title = _formatEuroExact(kpis.totalScenMar);

    renderDelta('#kpi-delta-vdp', kpis.deltaVDP, kpis.deltaVDPPerc);
    renderDelta('#kpi-delta-margin', kpis.deltaMar, kpis.deltaMarPerc);

    // Labels for Baseline
    $('#kpi-vdp-baseline .kpi-label').textContent = 'VDP Totale Baseline';
}




function renderDelta(sel, value, perc) {
    const el = $(sel);
    if (!el) return;
    const sign = value >= 0 ? '+' : '';
    el.textContent = `${sign}${formatEuro(value)}  (${sign}${perc.toFixed(1)}%)`;
    el.title = `${sign}${_formatEuroExact(value)}  (${sign}${perc.toFixed(1)}%)`;
    el.className = 'kpi-delta ' + (value >= 0 ? 'positive' : 'negative');
}

// ============================================================
//  CHARTS
// ============================================================
const chartColors = {
    baseline:  { bg: 'rgba(236, 180, 12, 0.70)',  border: '#ECB40C' },
    actual:    { bg: 'rgba(17, 110, 191, 0.80)',   border: '#116EBF' },
    remaining: { bg: 'rgba(8, 160, 69, 0.70)',     border: '#08A045' },
    scenario:  { bg: 'rgba(8, 160, 69, 0.70)',     border: '#08A045' },
    scenarioB: { bg: 'rgba(244, 114, 182, 0.6)',   border: '#f472b6' },
    deltaPos:  { bg: 'rgba(148, 225, 131, 0.55)',  border: '#94E183' },
    deltaNeg:  { bg: 'rgba(240, 173, 173, 0.55)',  border: '#F0ADAD' },
};

// Palette for Details stacked charts (one color per commessa)
const DETAILS_PALETTE = [
    { bg: 'rgba(59,  130, 246, 0.80)', border: '#3B82F6' },
    { bg: 'rgba(239,  68,  68, 0.80)', border: '#EF4444' },
    { bg: 'rgba(34,  197,  94, 0.80)', border: '#22C55E' },
    { bg: 'rgba(245, 158,  11, 0.80)', border: '#F59E0B' },
    { bg: 'rgba(168,  85, 247, 0.80)', border: '#A855F7' },
    { bg: 'rgba(236,  72, 153, 0.80)', border: '#EC4899' },
    { bg: 'rgba(20,  184, 166, 0.80)', border: '#14B8A6' },
    { bg: 'rgba(249, 115,  22, 0.80)', border: '#F97316' },
    { bg: 'rgba(99,  102, 241, 0.80)', border: '#6366F1' },
    { bg: 'rgba(16,  185, 129, 0.80)', border: '#10B981' },
    { bg: 'rgba(244,  63,  94, 0.80)', border: '#F43F5E' },
    { bg: 'rgba(6,   182, 212, 0.80)', border: '#06B6D4' },
    { bg: 'rgba(139,  92, 246, 0.80)', border: '#8B5CF6' },
    { bg: 'rgba(234, 179,   8, 0.80)', border: '#EAB308' },
    { bg: 'rgba(52,  211, 153, 0.80)', border: '#34D399' },
    { bg: 'rgba(251, 191,  36, 0.80)', border: '#FBBF24' },
    { bg: 'rgba(129, 140, 248, 0.80)', border: '#818CF8' },
    { bg: 'rgba(45,  212, 191, 0.80)', border: '#2DD4BF' },
    { bg: 'rgba(253, 186, 116, 0.80)', border: '#FDBA74' },
    { bg: 'rgba(196, 181, 253, 0.80)', border: '#C4B5FD' },
    { bg: 'rgba(249, 168, 212, 0.80)', border: '#F9A8D4' },
    { bg: 'rgba(110, 231, 183, 0.80)', border: '#6EE7B7' },
    { bg: 'rgba(147, 197, 253, 0.80)', border: '#93C5FD' },
    { bg: 'rgba(165, 180, 252, 0.80)', border: '#A5B4FC' },
    { bg: 'rgba(94,  234, 212, 0.80)', border: '#5EEAD4' },
    { bg: 'rgba(252, 211,  77, 0.80)', border: '#FCD34D' },
    { bg: 'rgba(253, 164, 175, 0.80)', border: '#FDA4AF' },
    { bg: 'rgba(167, 243, 208, 0.80)', border: '#A7F3D0' },
    { bg: 'rgba(254, 202, 202, 0.80)', border: '#FECACA' },
    { bg: 'rgba(199, 210, 254, 0.80)', border: '#C7D2FE' },
];



function renderCharts(monthly, commessaResults = []) {
    const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'dashboard';

    // Destroy existing charts
    Object.values(charts).forEach(c => c.destroy());
    charts = {};

    // Route to the correct render function — never render hidden tabs
    if (activeTab === 'details') {
        renderDetailsCharts(monthly, commessaResults);
        return;
    }
    if (activeTab === 'details-type') {
        renderDetailsTypeCharts(monthly, commessaResults);
        return;
    }
    if (activeTab === 'analisi') {
        renderAnalisiCharts(monthly, commessaResults);
        return;
    }
    if (activeTab !== 'dashboard') return; // assumptions / unknown tab: nothing to render

    const labels = monthly.map(m => m.month);

    // Find last index of actual data to truncate that curve
    let lastActualIdx = -1;
    for (let i = 0; i < monthly.length; i++) {
        if (monthly[i].scenarioActual > 0) lastActualIdx = i;
    }

    // Factory function — restituisce un oggetto opzioni FRESCO ogni volta.
    // Necessario perché Chart.js muta internamente l'oggetto options del primo
    // grafico creato: se i grafici successivi condividono gli stessi riferimenti
    // annidati (scales.x, scales.y, plugins…) ereditano quelle mutazioni e
    // si comportano in modo imprevisto (es. prima barra invisibile).
    const makeCommonOpts = () => ({
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
            legend: { labels: { color: '#8892a8', font: { family: 'Inter', size: 11 } } },
            tooltip: {
                backgroundColor: '#1a2340',
                borderColor: 'rgba(255,255,255,0.1)',
                borderWidth: 1,
                titleFont: { family: 'Inter' },
                bodyFont: { family: 'Inter' },
                callbacks: {
                    label: (ctx) => `${ctx.dataset.label}: ${formatEuro(ctx.parsed.y)}`,
                },
            },
        },
        scales: {
            x: {
                offset: true,
                ticks: { color: '#5a6478', font: { size: 10 }, maxRotation: 45 },
                grid: { color: 'rgba(255,255,255,0.04)' },
            },
            y: {
                beginAtZero: true,
                ticks: {
                    color: '#5a6478',
                    font: { size: 10 },
                    callback: (v) => formatEuro(v),
                },
                grid: { color: 'rgba(255,255,255,0.04)' },
            },
        },
    });

    // 1. VDP Monthly (bar) - Stacked for Scenario
    const vdpDatasets = [
        {
            label: 'Baseline (AOP)',
            data: monthly.map(m => m.baselineVDP),
            backgroundColor: chartColors.baseline.bg,
            borderColor: chartColors.baseline.border,
            borderWidth: 1,
            stack: 'base'
        },
        {
            label: 'Scenario (Actual)',
            data: monthly.map((m, i) => i <= lastActualIdx ? m.scenarioActual : null),
            backgroundColor: chartColors.actual.bg,
            borderColor: chartColors.actual.border,
            borderWidth: 1,
            stack: 'scen'
        },
        {
            label: 'Scenario (Remaining)',
            data: monthly.map(m => m.scenarioRemaining),
            backgroundColor: chartColors.remaining.bg,
            borderColor: chartColors.remaining.border,
            borderWidth: 1,
            stack: 'scen'
        }
    ];

    charts.vdpMonthly = new Chart($('#chart-vdp-monthly'), {
        type: 'bar',
        data: { labels, datasets: vdpDatasets },
        options: (() => {
            const o = makeCommonOpts();
            o.scales.x.stacked = true;
            o.scales.y.stacked = true;
            return o;
        })(),
    });



    // 2. VDP Cumulative (line)
    let cumBase = 0, cumScenActual = 0, cumScenTotal = 0;
    const cumBaseArr = [], cumScenActualArr = [], cumScenTotalArr = [];
    for (const m of monthly) {
        cumBase += m.baselineVDP;
        cumScenActual += m.scenarioActual;
        cumScenTotal += (m.scenarioActual + m.scenarioRemaining);

        cumBaseArr.push(cumBase);
        cumScenActualArr.push(cumScenActual);
        cumScenTotalArr.push(cumScenTotal);
    }

    const vdpCumDatasets = [
        { label: 'Baseline (AOP)', data: cumBaseArr, borderColor: chartColors.baseline.border, backgroundColor: 'rgba(236,180,12,0.10)', fill: true, tension: 0.3, pointRadius: 2 },
        { label: 'Scenario (Actual)', data: cumScenActualArr.map((v, i) => i <= lastActualIdx ? v : null), borderColor: chartColors.actual.border, backgroundColor: 'transparent', borderDash: [5, 5], tension: 0.3, pointRadius: 2 },
        { label: 'Scenario (Total)', data: cumScenTotalArr, borderColor: chartColors.scenario.border, backgroundColor: 'rgba(8,160,69,0.10)', fill: true, tension: 0.3, pointRadius: 2 },
    ];

    charts.vdpCum = new Chart($('#chart-vdp-cumulative'), {
        type: 'line',
        data: { labels, datasets: vdpCumDatasets },
        options: makeCommonOpts(),
    });



    // 3. Margin Monthly (bar) - struttura identica a VDP (3 dataset, 2 stack)
    //    per garantire larghezza barre e scala X esattamente uguali
    charts.marginMonthly = new Chart($('#chart-margin-monthly'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Baseline',
                    data: monthly.map(m => m.baselineMargine),
                    backgroundColor: chartColors.baseline.bg,
                    borderColor: chartColors.baseline.border,
                    borderWidth: 1,
                    stack: 'base'
                },
                {
                    label: 'Scenario (Actual)',
                    data: monthly.map((m, i) => i <= lastActualIdx ? m.scenarioMargine : null),
                    backgroundColor: chartColors.actual.bg,
                    borderColor: chartColors.actual.border,
                    borderWidth: 1,
                    stack: 'scen'
                },
                {
                    label: 'Scenario (Remaining)',
                    data: monthly.map((m, i) => i > lastActualIdx ? m.scenarioMargine : null),
                    backgroundColor: chartColors.remaining.bg,
                    borderColor: chartColors.remaining.border,
                    borderWidth: 1,
                    stack: 'scen'
                }
            ],
        },
        options: (() => {
            const o = makeCommonOpts();
            o.scales.x.stacked = true;
            // y.stacked volutamente NON impostato: con due stack separati (base/scen)
            // e un dataset per stack, non serve la somma verticale.
            // beginAtZero:true è già impostato in makeCommonOpts.
            return o;
        })(),
    });

    // 4. Margin Cumulative (line)
    let cumBaseMar = 0, cumScenMar = 0;
    const cumBaseMarArr = [], cumScenMarArr = [];
    for (const m of monthly) {
        cumBaseMar += m.baselineMargine; cumScenMar += m.scenarioMargine;
        cumBaseMarArr.push(cumBaseMar); cumScenMarArr.push(cumScenMar);
    }
    charts.marginCum = new Chart($('#chart-margin-cumulative'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'Baseline', data: cumBaseMarArr, borderColor: chartColors.baseline.border, backgroundColor: 'rgba(236,180,12,0.10)', fill: true, tension: 0.3, pointRadius: 2 },
                { label: 'Scenario', data: cumScenMarArr, borderColor: chartColors.scenario.border, backgroundColor: 'rgba(8,160,69,0.10)', fill: true, tension: 0.3, pointRadius: 2 },
            ],
        },
        options: makeCommonOpts(),
    });


} // fine renderCharts

// ============================================================
//  DETAILS CHARTS (tab: details) — stacked bar per commessa
// ============================================================

// Plugin inline: disegna il totale della pila sopra ogni barra
const stackedTotalPlugin = {
    id: 'stackedTotalLabels',
    afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        const nLabels = data.labels.length;

        for (let i = 0; i < nLabels; i++) {
            let total = 0;
            let topY = Infinity;
            let barX = null;

            data.datasets.forEach((ds, dsIdx) => {
                const meta = chart.getDatasetMeta(dsIdx);
                if (meta.hidden) return;
                const bar = meta.data[i];
                if (!bar) return;
                total += ds.data[i] || 0;
                if (bar.y < topY) {
                    topY = bar.y;
                    barX = bar.x;
                }
            });

            if (barX == null || total === 0) continue;

            const text = formatCompact(total);
            ctx.save();
            ctx.fillStyle = '#3a3f4a';
            ctx.font = 'bold 10px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(text, barX, topY - 3);
            ctx.restore();
        }
    },
};

function renderDetailsCharts(monthly, commessaResults = []) {
    const labels = monthly.map(m => m.month);

    const vdpDatasets = [];
    const marDatasets  = [];

    commessaResults.forEach((comm, idx) => {
        const color = DETAILS_PALETTE[idx % DETAILS_PALETTE.length];
        const parts = [comm.codice, comm.nome].filter(Boolean);
        const label = parts.join(' - ') || `Commessa ${idx + 1}`;

        // Aggregate scenario values per month from scenarioMonths
        const byMonth = {};
        for (const sm of (comm.scenarioMonths || [])) {
            if (!byMonth[sm.month]) byMonth[sm.month] = { vdp: 0, margine: 0 };
            byMonth[sm.month].vdp     += sm.vdp     || 0;
            byMonth[sm.month].margine += sm.margine  || 0;
        }

        const vdpData = labels.map(m => {
            const v = byMonth[m]?.vdp;
            return (v && v !== 0) ? v : null;
        });
        const marData = labels.map(m => {
            const v = byMonth[m]?.margine;
            return (v && v !== 0) ? v : null;
        });

        // Skip commesse with zero contribution in this period
        if (!vdpData.some(v => v != null) && !marData.some(v => v != null)) return;

        const base = {
            label,
            backgroundColor: color.bg,
            borderColor:     color.border,
            borderWidth:     1,
            stack:           'details',
        };
        vdpDatasets.push({ ...base, data: vdpData });
        marDatasets.push({ ...base, data: marData });
    });

    const makeOpts = () => ({
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#1a2340',
                borderColor: 'rgba(255,255,255,0.15)',
                borderWidth: 1,
                titleFont: { family: 'Inter', size: 11, weight: 'bold' },
                bodyFont:  { family: 'Inter', size: 11 },
                callbacks: {
                    title: (items) => items[0]?.label ?? '',
                    label: (ctx) => {
                        const v = ctx.parsed.y;
                        if (v == null || v === 0) return null;
                        return `${ctx.dataset.label}:  ${formatEuro(v)}`;
                    },
                },
            },
        },
        scales: {
            x: {
                stacked: true,
                offset: true,
                ticks: { color: '#5a6478', font: { size: 10 }, maxRotation: 45 },
                grid:  { color: 'rgba(255,255,255,0.04)' },
            },
            y: {
                stacked: true,
                beginAtZero: true,
                ticks: {
                    color: '#5a6478',
                    font: { size: 10 },
                    callback: (v) => formatEuro(v),
                },
                grid: { color: 'rgba(255,255,255,0.04)' },
            },
        },
    });

    charts.detailsVdp = new Chart($('#chart-details-vdp'), {
        type: 'bar',
        plugins: [stackedTotalPlugin],
        data: { labels, datasets: vdpDatasets },
        options: makeOpts(),
    });

    charts.detailsMar = new Chart($('#chart-details-mar'), {
        type: 'bar',
        plugins: [stackedTotalPlugin],
        data: { labels, datasets: marDatasets },
        options: makeOpts(),
    });

    // Render detail tables: if details is already open, render immediately.
    // Otherwise, render on first toggle. Always re-render on new data (filters).
    const detailsTablesEl = document.querySelector('#tab-details details');
    if (detailsTablesEl) {
        if (detailsTablesEl.open) {
            _renderDetailsTables(commessaResults, labels);
        }
        // Remove old listener by replacing the element's handler attribute
        const newDetails = detailsTablesEl;
        newDetails._pendingData = { commessaResults, labels };
        if (!newDetails._listenerAttached) {
            newDetails._listenerAttached = true;
            newDetails.addEventListener('toggle', () => {
                if (newDetails.open && newDetails._pendingData) {
                    _renderDetailsTables(newDetails._pendingData.commessaResults, newDetails._pendingData.labels);
                }
            });
        } else {
            // Listener already attached, just update pending data (already done above)
        }
    }
}

function _renderDetailsTables(commessaResults, months) {
    const container = $('#details-tables-container');
    if (!container) return;

    // Build per-commessa monthly data
    const rows = [];
    for (const comm of commessaResults) {
        const label = [comm.codice, comm.nome].filter(Boolean).join(' - ') || 'N/D';
        const byMonth = {};
        for (const sm of (comm.scenarioMonths || [])) {
            if (!byMonth[sm.month]) byMonth[sm.month] = { vdp: 0, margine: 0 };
            byMonth[sm.month].vdp += sm.vdp || 0;
            byMonth[sm.month].margine += sm.margine || 0;
        }
        const totalVdp = months.reduce((s, m) => s + (byMonth[m]?.vdp || 0), 0);
        const totalMar = months.reduce((s, m) => s + (byMonth[m]?.margine || 0), 0);
        if (totalVdp === 0 && totalMar === 0) continue;
        rows.push({ label, codice: comm.codice || '', byMonth, totalVdp, totalMar });
    }

    function buildTable(title, field, excelFilename) {
        const section = document.createElement('div');
        section.style.marginBottom = '20px';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin:12px 0 8px;';

        const h4 = document.createElement('h4');
        h4.style.cssText = 'font-size:14px;font-weight:700;margin:0;';
        h4.textContent = title;
        header.appendChild(h4);

        const exportBtn = document.createElement('button');
        exportBtn.className = 'btn btn-outline btn-sm';
        exportBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Esporta Excel';
        exportBtn.addEventListener('click', () => {
            const exRows = [];
            for (const row of rows) {
                const entry = { 'Commessa': row.label };
                for (const m of months) {
                    entry[m] = Math.round(row.byMonth[m]?.[field] || 0);
                }
                entry['Totale'] = Math.round(field === 'vdp' ? row.totalVdp : row.totalMar);
                exRows.push(entry);
            }
            // Add totals row
            const totEntry = { 'Commessa': 'TOTALE' };
            for (const m of months) {
                totEntry[m] = Math.round(rows.reduce((s, r) => s + (r.byMonth[m]?.[field] || 0), 0));
            }
            totEntry['Totale'] = Math.round(rows.reduce((s, r) => s + (field === 'vdp' ? r.totalVdp : r.totalMar), 0));
            exRows.push(totEntry);
            exportChartToExcel(excelFilename, exRows);
        });
        header.appendChild(exportBtn);

        section.appendChild(header);

        const wrapper = document.createElement('div');
        wrapper.className = 'table-container';
        wrapper.style.overflowX = 'auto';

        const table = document.createElement('table');
        table.className = 'details-data-table';

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        const thComm = document.createElement('th');
        thComm.textContent = 'Commessa';
        thComm.className = 'details-th-sortable';
        thComm.dataset.sort = 'label';
        headerRow.appendChild(thComm);

        for (const m of months) {
            const th = document.createElement('th');
            th.textContent = m;
            th.className = 'details-th-month';
            headerRow.appendChild(th);
        }

        const thTotal = document.createElement('th');
        thTotal.textContent = 'Totale';
        thTotal.className = 'details-th-sortable details-th-total';
        thTotal.dataset.sort = 'total';
        headerRow.appendChild(thTotal);

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Sort state
        let sortKey = null;
        let sortAsc = true;

        function renderBody() {
            const sorted = [...rows];
            if (sortKey === 'label') {
                sorted.sort((a, b) => sortAsc ? a.label.localeCompare(b.label) : b.label.localeCompare(a.label));
            } else if (sortKey === 'total') {
                sorted.sort((a, b) => {
                    const va = field === 'vdp' ? a.totalVdp : a.totalMar;
                    const vb = field === 'vdp' ? b.totalVdp : b.totalMar;
                    return sortAsc ? va - vb : vb - va;
                });
            }

            let oldTbody = table.querySelector('tbody');
            if (oldTbody) oldTbody.remove();

            const tbody = document.createElement('tbody');

            for (const row of sorted) {
                const tr = document.createElement('tr');
                const tdLabel = document.createElement('td');
                tdLabel.textContent = row.label;
                tdLabel.className = 'details-td-commessa';
                tr.appendChild(tdLabel);

                for (const m of months) {
                    const td = document.createElement('td');
                    const val = row.byMonth[m]?.[field] || 0;
                    td.textContent = val !== 0 ? formatCompact(val) : '';
                    td.title = val !== 0 ? _formatEuroExact(val) : '';
                    td.className = 'details-td-value';
                    if (val < 0) td.style.color = 'var(--danger, #ef4444)';
                    tr.appendChild(td);
                }

                const tdTotal = document.createElement('td');
                const total = field === 'vdp' ? row.totalVdp : row.totalMar;
                tdTotal.textContent = formatCompact(total);
                tdTotal.title = _formatEuroExact(total);
                tdTotal.className = 'details-td-value details-td-total';
                if (total < 0) tdTotal.style.color = 'var(--danger, #ef4444)';
                tr.appendChild(tdTotal);

                tbody.appendChild(tr);
            }

            // Footer with totals
            const tfoot = document.createElement('tr');
            tfoot.className = 'details-tfoot';
            const tfLabel = document.createElement('td');
            tfLabel.textContent = 'TOTALE';
            tfLabel.className = 'details-td-commessa';
            tfLabel.style.fontWeight = '700';
            tfoot.appendChild(tfLabel);

            let grandTotal = 0;
            for (const m of months) {
                const td = document.createElement('td');
                const sum = rows.reduce((s, r) => s + (r.byMonth[m]?.[field] || 0), 0);
                td.textContent = sum !== 0 ? formatCompact(sum) : '';
                td.title = sum !== 0 ? _formatEuroExact(sum) : '';
                td.className = 'details-td-value';
                td.style.fontWeight = '700';
                grandTotal += sum;
                tfoot.appendChild(td);
            }
            const tfTotal = document.createElement('td');
            tfTotal.textContent = formatCompact(grandTotal);
            tfTotal.title = _formatEuroExact(grandTotal);
            tfTotal.className = 'details-td-value details-td-total';
            tfTotal.style.fontWeight = '700';
            tfoot.appendChild(tfTotal);

            tbody.appendChild(tfoot);
            table.appendChild(tbody);
        }

        // Sort click handlers
        headerRow.querySelectorAll('.details-th-sortable').forEach(th => {
            th.style.cursor = 'pointer';
            th.addEventListener('click', () => {
                if (sortKey === th.dataset.sort) {
                    sortAsc = !sortAsc;
                } else {
                    sortKey = th.dataset.sort;
                    sortAsc = true;
                }
                // Update sort indicators
                headerRow.querySelectorAll('.details-th-sortable').forEach(h => h.dataset.sortDir = '');
                th.dataset.sortDir = sortAsc ? 'asc' : 'desc';
                renderBody();
            });
        });

        renderBody();
        wrapper.appendChild(table);
        section.appendChild(wrapper);
        return section;
    }

    container.textContent = '';
    container.appendChild(buildTable('VDP Mensile — Dettaglio per Commessa', 'vdp', 'Tabella_VDP_per_Commessa'));
    container.appendChild(buildTable('Margine Mensile — Dettaglio per Commessa', 'margine', 'Tabella_Margine_per_Commessa'));
}

function renderDetailsTypeCharts(monthly, commessaResults = []) {
    const labels = monthly.map(m => m.month);

    const TYPES = ['Backlog', 'Order Intake'];
    const TYPE_COLORS = {
        'Backlog':       { bg: 'rgba(251, 146, 60, 0.80)',  border: '#fb923c' },
        'Order Intake':  { bg: 'rgba(99,  140, 255, 0.80)', border: '#638cff' },
    };

    // Aggrega VDP e Margine per tipo per ogni mese
    const byTypeMonth = {};
    for (const t of TYPES) byTypeMonth[t] = {};

    for (const comm of commessaResults) {
        const type = comm.effectiveType || comm.type || 'Backlog';
        const bucket = TYPES.includes(type) ? type : 'Backlog';
        for (const sm of (comm.scenarioMonths || [])) {
            if (!byTypeMonth[bucket][sm.month]) byTypeMonth[bucket][sm.month] = { vdp: 0, margine: 0 };
            byTypeMonth[bucket][sm.month].vdp     += sm.vdp     || 0;
            byTypeMonth[bucket][sm.month].margine += sm.margine || 0;
        }
    }

    const vdpDatasets = [];
    const marDatasets  = [];

    for (const type of TYPES) {
        const color = TYPE_COLORS[type];
        const vdpData = labels.map(m => byTypeMonth[type][m]?.vdp     || null);
        const marData = labels.map(m => byTypeMonth[type][m]?.margine || null);

        if (!vdpData.some(v => v != null) && !marData.some(v => v != null)) continue;

        const base = {
            label:           type,
            backgroundColor: color.bg,
            borderColor:     color.border,
            borderWidth:     1,
            stack:           'type-details',
        };
        vdpDatasets.push({ ...base, data: vdpData });
        marDatasets.push({ ...base, data: marData });
    }

    const makeOpts = () => ({
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 22 } },
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
            legend: {
                display: true,
                position: 'top',
                labels: { color: '#cbd5e1', font: { family: 'Inter', size: 12 }, boxWidth: 14 },
            },
            tooltip: {
                backgroundColor: '#1a2340',
                borderColor: 'rgba(255,255,255,0.15)',
                borderWidth: 1,
                titleFont: { family: 'Inter', size: 11, weight: 'bold' },
                bodyFont:  { family: 'Inter', size: 11 },
                callbacks: {
                    title: (items) => items[0]?.label ?? '',
                    label: (ctx) => {
                        const v = ctx.parsed.y;
                        if (v == null || v === 0) return null;
                        return `${ctx.dataset.label}:  ${formatEuro(v)}`;
                    },
                },
            },
        },
        scales: {
            x: {
                stacked: true,
                offset: true,
                ticks: { color: '#5a6478', font: { size: 10 }, maxRotation: 45 },
                grid:  { color: 'rgba(255,255,255,0.04)' },
            },
            y: {
                stacked: true,
                beginAtZero: true,
                ticks: {
                    color: '#5a6478',
                    font: { size: 10 },
                    callback: (v) => formatEuro(v),
                },
                grid: { color: 'rgba(255,255,255,0.04)' },
            },
        },
    });

    charts.detailsTypeVdp = new Chart($('#chart-details-type-vdp'), {
        type: 'bar',
        plugins: [stackedTotalPlugin],
        data: { labels, datasets: vdpDatasets },
        options: makeOpts(),
    });

    charts.detailsTypeMar = new Chart($('#chart-details-type-mar'), {
        type: 'bar',
        plugins: [stackedTotalPlugin],
        data: { labels, datasets: marDatasets },
        options: makeOpts(),
    });
}

// ============================================================
//  ANALISI ANNUALITÀ CHARTS (tab: analisi)
// ============================================================
function renderAnalisiCharts(monthly, commessaResults) {
    const commonOpts = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: '#8892a8', font: { family: 'Inter', size: 11 } } },
            tooltip: {
                backgroundColor: '#1a2340',
                borderColor: 'rgba(255,255,255,0.1)',
                borderWidth: 1,
                titleFont: { family: 'Inter' },
                bodyFont: { family: 'Inter' },
                callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatEuro(ctx.parsed.y)}` },
            },
        },
        scales: {
            x: { ticks: { color: '#5a6478', font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { ticks: { color: '#5a6478', font: { size: 10 }, callback: (v) => formatEuro(v) }, grid: { color: 'rgba(255,255,255,0.04)' } },
        },
    };

    // 5. VDP per Anno (grouped bar: Baseline vs Scenario)
    const yearBaseVdp = {}, yearScenVdp = {};
    for (const m of monthly) {
        const y = m.month.substring(0, 4);
        yearBaseVdp[y] = (yearBaseVdp[y] || 0) + m.baselineVDP;
        yearScenVdp[y] = (yearScenVdp[y] || 0) + m.scenarioVDP;
    }
    const yearLabels = [...new Set([...Object.keys(yearBaseVdp), ...Object.keys(yearScenVdp)])].sort();

    // Opzioni asse X per grafici annuali
    const yearlyXScale = {
        ...commonOpts.scales.x,
        offset: true,
        ticks: { ...commonOpts.scales.x.ticks, maxRotation: 0 },
    };

    // 3 barre per gruppo → barPercentage più alto per non sprecare spazio
    const slimBar = { barPercentage: 0.75, categoryPercentage: 0.82, clip: false };

    // Datalabels barre normali (valore sopra)
    const barLabelOpts = {
        anchor: 'end',
        align: 'top',
        display: 'auto',
        formatter: (v) => (typeof v === 'number' && v > 0) ? formatCompact(v) : '',
        font: { family: 'Inter', size: 9, weight: '600' },
        color: '#3a3f4a',
        clip: false,
    };

    // Datalabels barra delta floating: sopra se positivo, sotto se negativo
    const deltaLabelOpts = {
        anchor: (ctx) => {
            const raw = ctx.dataset.data[ctx.dataIndex];
            return Array.isArray(raw) && (raw[1] - raw[0]) < 0 ? 'start' : 'end';
        },
        align: (ctx) => {
            const raw = ctx.dataset.data[ctx.dataIndex];
            return Array.isArray(raw) && (raw[1] - raw[0]) < 0 ? 'bottom' : 'top';
        },
        formatter: (v) => {
            if (!Array.isArray(v)) return '';
            const delta = v[1] - v[0];
            if (delta === 0) return '';
            return (delta > 0 ? 'Δ +' : 'Δ −') + formatCompact(Math.abs(delta));
        },
        color: '#3a3f4a',
        font: { family: 'Inter', size: 10, weight: '700' },
        clip: false,
    };

    // Tooltip che gestisce sia barre normali sia floating bars
    const yearlyTooltip = {
        ...commonOpts.plugins.tooltip,
        callbacks: {
            label: (ctx) => {
                const raw = ctx.raw;
                if (Array.isArray(raw)) {
                    const delta = raw[1] - raw[0];
                    return `Δ Scenario − Baseline: ${delta >= 0 ? '+' : ''}${formatEuro(delta)}`;
                }
                return `${ctx.dataset.label}: ${formatEuro(ctx.parsed.y)}`;
            },
        },
    };

    // Helper: genera dataset delta floating per un set di valori base/scen
    const makeDeltaDataset = (baseMap, scenMap) => ({
        label: 'Δ Scenario − Baseline',
        data: yearLabels.map(y => [
            Math.round(baseMap[y] || 0),
            Math.round(scenMap[y] || 0),
        ]),
        backgroundColor: yearLabels.map(y => {
            const delta = (scenMap[y] || 0) - (baseMap[y] || 0);
            return delta >= 0 ? chartColors.deltaPos.bg : chartColors.deltaNeg.bg;
        }),
        borderColor: yearLabels.map(y => {
            const delta = (scenMap[y] || 0) - (baseMap[y] || 0);
            return delta >= 0 ? chartColors.deltaPos.border : chartColors.deltaNeg.border;
        }),
        borderWidth: 1,
        ...slimBar,
        datalabels: deltaLabelOpts,
    });

    charts.vdpYearly = new Chart($('#chart-vdp-yearly'), {
        type: 'bar',
        plugins: [ChartDataLabels],
        data: {
            labels: yearLabels,
            datasets: [
                { label: 'Baseline (AOP)', data: yearLabels.map(y => Math.round(yearBaseVdp[y] || 0)), backgroundColor: chartColors.baseline.bg, borderColor: chartColors.baseline.border, borderWidth: 1, ...slimBar, datalabels: barLabelOpts },
                makeDeltaDataset(yearBaseVdp, yearScenVdp),
                { label: 'Scenario',       data: yearLabels.map(y => Math.round(yearScenVdp[y]  || 0)), backgroundColor: chartColors.scenario.bg,  borderColor: chartColors.scenario.border,  borderWidth: 1, ...slimBar, datalabels: barLabelOpts },
            ],
        },
        options: {
            ...commonOpts,
            layout: { padding: { top: 30, left: 8, right: 8 } },
            scales: { ...commonOpts.scales, x: yearlyXScale },
            plugins: { ...commonOpts.plugins, tooltip: yearlyTooltip },
        },
    });

    // 6. Margine per Anno (grouped bar: Baseline vs Scenario + delta)
    const yearBaseMargine = {}, yearScenMargine = {};
    for (const m of monthly) {
        const y = m.month.substring(0, 4);
        yearBaseMargine[y] = (yearBaseMargine[y] || 0) + m.baselineMargine;
        yearScenMargine[y] = (yearScenMargine[y] || 0) + m.scenarioMargine;
    }

    charts.margineYearly = new Chart($('#chart-margin-yearly'), {
        type: 'bar',
        plugins: [ChartDataLabels],
        data: {
            labels: yearLabels,
            datasets: [
                { label: 'Baseline (AOP)', data: yearLabels.map(y => Math.round(yearBaseMargine[y] || 0)), backgroundColor: chartColors.baseline.bg, borderColor: chartColors.baseline.border, borderWidth: 1, ...slimBar, datalabels: barLabelOpts },
                makeDeltaDataset(yearBaseMargine, yearScenMargine),
                { label: 'Scenario',       data: yearLabels.map(y => Math.round(yearScenMargine[y] || 0)), backgroundColor: chartColors.scenario.bg,  borderColor: chartColors.scenario.border,  borderWidth: 1, ...slimBar, datalabels: barLabelOpts },
            ],
        },
        options: {
            ...commonOpts,
            layout: { padding: { top: 30, left: 8, right: 8 } },
            scales: { ...commonOpts.scales, x: yearlyXScale },
            plugins: { ...commonOpts.plugins, tooltip: yearlyTooltip },
        },
    });

    // 7. VDP Scenario per Tipo × Anno (stacked bar)
    const typeColors = {
        'Backlog':       { bg: chartColors.actual.bg,    border: chartColors.actual.border    },
        'Order Intake':  { bg: chartColors.remaining.bg, border: chartColors.remaining.border },
    };
    const fallbackTypeColors = [
        { bg: 'rgba(251,191,36,0.75)', border: '#fbbf24' },
        { bg: 'rgba(248,113,113,0.75)', border: '#f87171' },
    ];
    const yearTypeScen = {}; // { year: { typeName: vdp } }
    const typeSet = new Set();
    for (const comm of commessaResults) {
        const type = comm.effectiveType || comm.type || 'Altro';
        typeSet.add(type);
        for (const m of (comm.scenarioMonths || [])) {
            const y = m.month.substring(0, 4);
            if (!yearTypeScen[y]) yearTypeScen[y] = {};
            yearTypeScen[y][type] = (yearTypeScen[y][type] || 0) + (m.actual || 0) + (m.remaining || 0);
        }
    }
    const allTypeYears = [...new Set(Object.keys(yearTypeScen))].sort();
    const allTypes = [...typeSet].sort();
    let fallbackIdx = 0;
    const typeDatasets = allTypes.map(type => {
        const col = typeColors[type] || fallbackTypeColors[fallbackIdx++ % fallbackTypeColors.length];
        return {
            label: type,
            data: allTypeYears.map(y => Math.round((yearTypeScen[y] || {})[type] || 0)),
            backgroundColor: col.bg,
            borderColor: col.border,
            borderWidth: 1,
            stack: 'scen',
            barPercentage: 0.5,
            categoryPercentage: 0.7,
            clip: false,
        };
    });

    // Soglia minima per mostrare l'etichetta (evita label su segmenti microscopici)
    const typeTotal = Object.values(yearTypeScen).flatMap(yy => Object.values(yy)).reduce((a, b) => a + b, 0);
    const typeLabelThreshold = typeTotal / Math.max(allTypeYears.length * allTypes.length, 1) * 0.15;

    charts.vdpType = new Chart($('#chart-vdp-type'), {
        type: 'bar',
        plugins: [ChartDataLabels],
        data: { labels: allTypeYears, datasets: typeDatasets },
        options: {
            ...commonOpts,
            layout: { padding: { top: 24, left: 8, right: 8 } },
            scales: {
                ...commonOpts.scales,
                x: { ...yearlyXScale, stacked: true },
                y: { ...commonOpts.scales.y, stacked: true },
            },
            plugins: {
                ...commonOpts.plugins,
                datalabels: {
                    anchor: 'center',
                    align: 'center',
                    formatter: (v) => v > typeLabelThreshold ? formatCompact(v) : '',
                    font: { family: 'Inter', size: 10, weight: '700' },
                    color: '#3a3f4a',
                },
            },
        },
    });

    // 8. Margine Scenario per Tipo × Anno (stacked bar)
    const yearTypeMarScen = {};
    for (const comm of commessaResults) {
        const type = comm.effectiveType || comm.type || 'Altro';
        for (const m of (comm.scenarioMonths || [])) {
            const y = m.month.substring(0, 4);
            if (!yearTypeMarScen[y]) yearTypeMarScen[y] = {};
            yearTypeMarScen[y][type] = (yearTypeMarScen[y][type] || 0) + (m.margine || 0);
        }
    }
    const allMarTypeYears = [...new Set(Object.keys(yearTypeMarScen))].sort();
    let fallbackMarIdx = 0;
    const marTypeDatasets = allTypes.map(type => {
        const col = typeColors[type] || fallbackTypeColors[fallbackMarIdx++ % fallbackTypeColors.length];
        return {
            label: type,
            data: allMarTypeYears.map(y => Math.round((yearTypeMarScen[y] || {})[type] || 0)),
            backgroundColor: col.bg,
            borderColor: col.border,
            borderWidth: 1,
            stack: 'scen',
            barPercentage: 0.5,
            categoryPercentage: 0.7,
            clip: false,
        };
    });
    const marTypeTotal = Object.values(yearTypeMarScen).flatMap(yy => Object.values(yy)).reduce((a, b) => a + b, 0);
    const marTypeLabelThreshold = marTypeTotal / Math.max(allMarTypeYears.length * allTypes.length, 1) * 0.15;

    charts.margineType = new Chart($('#chart-margin-type'), {
        type: 'bar',
        plugins: [ChartDataLabels],
        data: { labels: allMarTypeYears, datasets: marTypeDatasets },
        options: {
            ...commonOpts,
            layout: { padding: { top: 24, left: 8, right: 8 } },
            scales: {
                ...commonOpts.scales,
                x: { ...yearlyXScale, stacked: true },
                y: { ...commonOpts.scales.y, stacked: true },
            },
            plugins: {
                ...commonOpts.plugins,
                datalabels: {
                    anchor: 'center',
                    align: 'center',
                    formatter: (v) => v > marTypeLabelThreshold ? formatCompact(v) : '',
                    font: { family: 'Inter', size: 10, weight: '700' },
                    color: '#3a3f4a',
                },
            },
        },
    });

    // ── 9 & 10. Waterfall VDP / Margine — Delta per Commessa ──────────────────
    if (!commessaResults || !commessaResults.length) return;

    const wfTrunc = (s, n) => s && s.length > n ? s.substring(0, n) + '…' : (s || '');
    const wfLabel = (c) => wfTrunc(c.nome || c.codice, 14);

    function buildWaterfall(results, getBase, getScen) {
        const sorted = [...results]
            .filter(c => Math.round(getScen(c) - getBase(c)) !== 0)
            .sort((a, b) => (getScen(b) - getBase(b)) - (getScen(a) - getBase(a)));
        const totalBase = results.reduce((s, c) => s + getBase(c), 0);
        const totalScen = results.reduce((s, c) => s + getScen(c), 0);

        const labels = ['Baseline', ...sorted.map(wfLabel), 'Scenario'];
        const data = [], bgs = [], borders = [];

        data.push([0, Math.round(totalBase)]);
        bgs.push(chartColors.baseline.bg);
        borders.push(chartColors.baseline.border);

        let running = totalBase;
        for (const c of sorted) {
            const delta = getScen(c) - getBase(c);
            data.push([Math.round(running), Math.round(running + delta)]);
            running += delta;
            bgs.push(delta >= 0 ? chartColors.deltaPos.bg : chartColors.deltaNeg.bg);
            borders.push(delta >= 0 ? chartColors.deltaPos.border : chartColors.deltaNeg.border);
        }

        data.push([0, Math.round(totalScen)]);
        bgs.push(chartColors.scenario.bg);
        borders.push(chartColors.scenario.border);

        return { labels, data, bgs, borders, sorted };
    }

    function makeWaterfallChart(canvasEl, wfData, keyLabel) {
        if (!canvasEl) return null;
        const { labels, data, bgs, borders, sorted } = wfData;
        const nTotal = data.length;

        return new Chart(canvasEl, {
            type: 'bar',
            plugins: [ChartDataLabels],
            data: {
                labels,
                datasets: [{
                    label: keyLabel,
                    data,
                    backgroundColor: bgs,
                    borderColor: borders,
                    borderWidth: 1,
                    barPercentage: 0.7,
                    categoryPercentage: 0.85,
                    clip: false,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                layout: { padding: { top: 28, left: 8, right: 8 } },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1a2340',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        titleFont: { family: 'Inter' },
                        bodyFont: { family: 'Inter' },
                        callbacks: {
                            label: (ctx) => {
                                const raw = ctx.raw;
                                if (!Array.isArray(raw)) return '';
                                if (ctx.dataIndex === 0) return `Baseline: ${formatEuro(raw[1])}`;
                                if (ctx.dataIndex === nTotal - 1) return `Scenario: ${formatEuro(raw[1])}`;
                                const delta = raw[1] - raw[0];
                                const comm = sorted[ctx.dataIndex - 1];
                                const lines = [`Δ ${keyLabel}: ${delta >= 0 ? '+' : ''}${formatEuro(delta)}`];
                                if (comm) {
                                    const base = keyLabel === 'VDP' ? comm.baseVdpTot : comm.baseMarTot;
                                    const scen = keyLabel === 'VDP' ? comm.scenVdpTot : comm.scenMarTot;
                                    lines.push(`Baseline: ${formatEuro(base)}`);
                                    lines.push(`Scenario: ${formatEuro(scen)}`);
                                }
                                return lines;
                            },
                        },
                    },
                    datalabels: {
                        anchor: (ctx) => {
                            const raw = ctx.dataset.data[ctx.dataIndex];
                            if (!Array.isArray(raw)) return 'end';
                            const isEdge = ctx.dataIndex === 0 || ctx.dataIndex === nTotal - 1;
                            return (isEdge || raw[1] - raw[0] >= 0) ? 'end' : 'start';
                        },
                        align: (ctx) => {
                            const raw = ctx.dataset.data[ctx.dataIndex];
                            if (!Array.isArray(raw)) return 'top';
                            const isEdge = ctx.dataIndex === 0 || ctx.dataIndex === nTotal - 1;
                            return (isEdge || raw[1] - raw[0] >= 0) ? 'top' : 'bottom';
                        },
                        formatter: (v, ctx) => {
                            if (!Array.isArray(v)) return '';
                            const isEdge = ctx.dataIndex === 0 || ctx.dataIndex === nTotal - 1;
                            if (isEdge) return formatCompact(v[1]);
                            const delta = v[1] - v[0];
                            if (delta === 0) return '';
                            return (delta > 0 ? '+' : '−') + formatCompact(Math.abs(delta));
                        },
                        font: { family: 'Inter', size: 9, weight: '600' },
                        color: '#3a3f4a',
                        clip: false,
                    },
                },
                scales: {
                    x: {
                        ticks: { color: '#5a6478', font: { size: 8 }, maxRotation: 90, minRotation: 45 },
                        grid: { color: 'rgba(255,255,255,0.04)' },
                    },
                    y: {
                        ticks: { color: '#5a6478', font: { size: 10 }, callback: (v) => formatCompact(v) },
                        grid: { color: 'rgba(255,255,255,0.04)' },
                    },
                },
            },
        });
    }

    const wfVdp = buildWaterfall(commessaResults, c => c.baseVdpTot, c => c.scenVdpTot);
    charts.wfVdp = makeWaterfallChart($('#chart-wf-vdp'), wfVdp, 'VDP');

    const wfMar = buildWaterfall(commessaResults, c => c.baseMarTot, c => c.scenMarTot);
    charts.wfMar = makeWaterfallChart($('#chart-wf-mar'), wfMar, 'Margine');

    // --- Commesse con cambio Type (horizontal bar) ---
    const typeColorsTC = {
        'Backlog':      { bg: chartColors.actual.bg,    border: chartColors.actual.border    },
        'Order Intake': { bg: chartColors.remaining.bg, border: chartColors.remaining.border },
    };
    const fallbackTC = [
        { bg: 'rgba(251,191,36,0.75)', border: '#fbbf24' },
        { bg: 'rgba(248,113,113,0.75)', border: '#f87171' },
    ];
    const truncate = (s, n) => s && s.length > n ? s.substring(0, n) + '…' : (s || '');
    const typeChanges = commessaResults.filter(c => (c.effectiveType || c.type) !== c.type);
    const wrapTypeChanges = document.getElementById('wrap-type-changes');

    if (wrapTypeChanges && !wrapTypeChanges.querySelector('#chart-type-changes')) {
        const cv = document.createElement('canvas');
        cv.id = 'chart-type-changes';
        wrapTypeChanges.innerHTML = '';
        wrapTypeChanges.appendChild(cv);
    }
    wrapTypeChanges?.querySelectorAll('.no-data-msg').forEach(el => el.remove());

    const typeChangesCanvas = $('#chart-type-changes');
    if (!typeChanges.length) {
        if (wrapTypeChanges) {
            if (typeChangesCanvas) typeChangesCanvas.style.display = 'none';
            const msg = document.createElement('p');
            msg.className = 'no-data-msg';
            msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:14px;margin:0;';
            msg.textContent = 'Nessuna commessa con cambio type';
            wrapTypeChanges.appendChild(msg);
        }
    } else if (typeChangesCanvas) {
        typeChangesCanvas.style.display = '';
        const tcLabels = typeChanges.map(c => truncate(`${c.codice} · ${c.nome}`, 35));
        const tcData = typeChanges.map(c => Math.round(c.scenVdpTot));
        const tcColors = typeChanges.map(c => {
            const et = c.effectiveType || c.type;
            return (typeColorsTC[et] || fallbackTC[0]).bg;
        });
        const tcDirLabels = typeChanges.map(c => {
            const et = c.effectiveType || c.type;
            return et === 'Backlog' ? '↑ BL' : '↓ OI';
        });
        if (wrapTypeChanges) {
            wrapTypeChanges.style.height = Math.max(280, typeChanges.length * 28 + 80) + 'px';
        }
        charts.typeChanges = new Chart(typeChangesCanvas, {
            type: 'bar',
            plugins: [ChartDataLabels],
            data: {
                labels: tcLabels,
                datasets: [{
                    label: 'VDP Scenario',
                    data: tcData,
                    backgroundColor: tcColors,
                    borderColor: tcColors,
                    borderWidth: 1,
                    barPercentage: 0.65,
                    categoryPercentage: 0.85,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                layout: { padding: { top: 4, bottom: 4 } },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1a2340',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        callbacks: {
                            label: (ctx) => {
                                const c = typeChanges[ctx.dataIndex];
                                return [`VDP Scenario: ${formatEuro(ctx.parsed.x)}`, `Baseline type: ${c.type}`, `Scenario type: ${c.effectiveType || c.type}`];
                            },
                        },
                    },
                    datalabels: {
                        anchor: 'center',
                        align: 'center',
                        formatter: (v, ctx) => `${formatCompact(v)}  ${tcDirLabels[ctx.dataIndex]}`,
                        font: { family: 'Inter', size: 10, weight: '600' },
                        color: '#3a3f4a',
                    },
                },
                scales: {
                    x: { ticks: { color: '#5a6478', font: { size: 10 }, callback: (v) => formatCompact(v) }, grid: { color: 'rgba(255,255,255,0.04)' } },
                    y: { ticks: { color: '#8892a8', font: { family: 'Inter', size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
                },
            },
        });
    }

    // --- VDP Scenario per Settore (doughnut) ---
    const settoreVdp = {};
    for (const comm of commessaResults) {
        const s = comm.settore || '?';
        settoreVdp[s] = (settoreVdp[s] || 0) + comm.scenVdpTot;
    }
    const settoreLabels = Object.keys(settoreVdp).sort();
    const pieColorPalette = ['#638cff', '#34d399', '#f472b6', '#fbbf24', '#f87171', '#a78bfa', '#38bdf8', '#fb923c', '#4ade80', '#e879f9'];
    const pieTotal = settoreLabels.reduce((s, k) => s + settoreVdp[k], 0);
    const settorePieCanvas = $('#chart-settore-pie');
    if (settorePieCanvas) {
        charts.settorePie = new Chart(settorePieCanvas, {
            type: 'doughnut',
            plugins: [ChartDataLabels],
            data: {
                labels: settoreLabels,
                datasets: [{
                    data: settoreLabels.map(s => Math.round(settoreVdp[s])),
                    backgroundColor: settoreLabels.map((_, i) => pieColorPalette[i % pieColorPalette.length]),
                    borderColor: '#1a2340',
                    borderWidth: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { color: '#8892a8', font: { family: 'Inter', size: 11 }, padding: 14 } },
                    tooltip: {
                        backgroundColor: '#1a2340',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        callbacks: {
                            label: (ctx) => {
                                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
                                return ` ${ctx.label}: ${formatEuro(ctx.parsed)} (${pct}%)`;
                            },
                        },
                    },
                    datalabels: {
                        formatter: (value) => {
                            const pct = pieTotal > 0 ? (value / pieTotal * 100) : 0;
                            if (pct < 4) return '';
                            return `${pct.toFixed(1)}%\n${formatCompact(value)}`;
                        },
                        font: { family: 'Inter', size: 10, weight: '700' },
                        color: '#3a3f4a',
                        textAlign: 'center',
                    },
                },
            },
        });
    }
}

// ============================================================
//  ASSUMPTIONS TABLE
// ============================================================
function renderAssumptionsTable() {
    if (!appData) return;
    const tbody = $('#assumptions-tbody');
    tbody.innerHTML = '';

    const scen = activeScenarioId ? getScenario(activeScenarioId) : null;
    const inputs = scen ? scen.inputs || {} : {};
    const showModifiedOnly = $('#chk-show-modified')?.checked || false;

    // Filters logic
    const filters = getActiveFilters();
    const searchQuery = ($('#commessa-search')?.value || '').toLowerCase().trim();

    // Unisce commesse AOP + eventuali nuove commesse dello scenario importato
    const scenNewCommesse = scen?.newCommesse || [];
    const allCommesseForTable = scenNewCommesse.length > 0 ? [...appData.commesse, ...scenNewCommesse] : appData.commesse;

    for (const comm of allCommesseForTable) {
        // Sector Filter
        if (filters.settori && filters.settori.length && !filters.settori.includes(comm.settore)) continue;
        // Type Filter — use effective type (respects scenario override)
        const effectiveTypeForAssumptions = (inputs[comm.key] || {}).type || comm.type;
        if (filters.types && filters.types.length && !filters.types.includes(effectiveTypeForAssumptions)) continue;
        // Sidebar selection Filter (only if some are selected)
        if (filters.commesse && filters.commesse.length && !filters.commesse.includes(comm.key)) continue;
        // Search Filter
        if (searchQuery) {
            const searchStr = `${comm.codice} ${comm.nome}`.toLowerCase();
            if (!searchStr.includes(searchQuery)) continue;
        }

        const ci = inputs[comm.key] || {};
        const effectiveType = ci.type || comm.type;
        const isOI = effectiveType === 'Order Intake';
        const isBL = effectiveType === 'Backlog';

        const isModified = ci.shiftStart || ci.probabilita != null && ci.probabilita !== '' ||
            ci.margine != null && ci.margine !== '' ||
            ci.ritardo || ci.smussamento;

        if (showModifiedOnly && !isModified) continue;

        const tr = document.createElement('tr');
        if (isModified) tr.classList.add('modified');

        // Helpers locali — costruzione sicura del DOM (nessun innerHTML con dati utente)
        const mkTd = (text, cls) => {
            const el = document.createElement('td');
            if (cls) el.className = cls;
            el.textContent = text;
            return el;
        };
        const mkInput = (cls, value, min, max, step, placeholder, disabled) => {
            const el = document.createElement('input');
            el.type = 'number';
            el.className = cls;
            el.dataset.key = comm.key;
            el.value = value;
            el.min = min;
            el.max = max;
            el.step = step;
            el.placeholder = placeholder;
            el.disabled = disabled;
            return el;
        };

        // Type badge
        const badge = document.createElement('span');
        badge.className = isOI ? 'type-badge order-intake' : 'type-badge backlog';
        badge.textContent = isOI ? 'Order Intake' : 'Backlog';
        const tdType = document.createElement('td');
        tdType.appendChild(badge);

        // Codice con <strong>
        const strong = document.createElement('strong');
        strong.textContent = comm.codice;
        const tdCodice = document.createElement('td');
        tdCodice.appendChild(strong);

        // Celle input
        const tdShift = document.createElement('td');
        tdShift.appendChild(mkInput('input-shift', ci.shiftStart || '', '-24', '24', '1', '0', !isOI || !activeScenarioId));

        const tdProb = document.createElement('td');
        tdProb.appendChild(mkInput('input-prob', ci.probabilita != null && ci.probabilita !== '' ? ci.probabilita : '', '0', '100', '5', (comm.probabilitaAOP * 100).toFixed(0), !isOI || !activeScenarioId));

        const tdMargin = document.createElement('td');
        tdMargin.appendChild(mkInput('input-margin', ci.margine != null && ci.margine !== '' ? ci.margine : '', '0', '100', '0.5', (comm.margineAOP * 100).toFixed(1), !activeScenarioId));

        const tdRitardo = document.createElement('td');
        tdRitardo.appendChild(mkInput('input-ritardo', ci.ritardo || '', '0', '24', '1', '0', !isBL || !activeScenarioId));

        // Type override dropdown
        const tdTypeOverride = document.createElement('td');
        const selType = document.createElement('select');
        selType.className = 'input-assumption input-type';
        selType.dataset.key = comm.key;
        selType.dataset.baseType = comm.type;
        selType.disabled = !activeScenarioId;
        const optBlank = document.createElement('option');
        optBlank.value = '';
        optBlank.textContent = `— baseline (${comm.type}) —`;
        selType.appendChild(optBlank);
        for (const tOpt of ['Backlog', 'Order Intake']) {
            const opt = document.createElement('option');
            opt.value = tOpt;
            opt.textContent = tOpt;
            if (ci.type === tOpt) opt.selected = true;
            selType.appendChild(opt);
        }
        tdTypeOverride.appendChild(selType);

        tr.append(
            mkTd(comm.settore),
            tdType,
            tdCodice,
            mkTd(comm.nome),
            mkTd(`${(comm.probabilitaAOP * 100).toFixed(0)}%`, 'td-right'),
            mkTd(formatEuro(comm.vdpTotale), 'td-right'),
            mkTd(`${(comm.margineAOP * 100).toFixed(1)}%`, 'td-right'),
            tdShift,
            tdProb,
            tdMargin,
            tdRitardo,
            tdTypeOverride,
        );

        tbody.appendChild(tr);
    }

    // Attach change events for inputs
    tbody.querySelectorAll('input').forEach(inp => {
        inp.addEventListener('change', (e) => {
            if (!activeScenarioId) return;
            const key = e.target.dataset.key;
            const field = e.target.classList.contains('input-shift') ? 'shiftStart'
                : e.target.classList.contains('input-prob') ? 'probabilita'
                    : e.target.classList.contains('input-margin') ? 'margine'
                        : e.target.classList.contains('input-ritardo') ? 'ritardo'
                            : null;
            if (!field) return;
            const val = e.target.value === '' ? null : Number(e.target.value);

            // Validation
            if (field === 'probabilita' && val != null && (val < 0 || val > 100)) {
                e.target.value = '';
                return;
            }
            if (field === 'margine' && val != null && (val < 0 || val > 100)) {
                e.target.value = '';
                return;
            }
            if ((field === 'shiftStart' || field === 'ritardo') && val != null && !Number.isInteger(val)) {
                e.target.value = Math.round(val);
            }

            updateScenarioInput(activeScenarioId, key, { [field]: val });

            // Mark row
            const tr = e.target.closest('tr');
            const scen = getScenario(activeScenarioId);
            const ci = scen?.inputs?.[key] || {};
            const hasAny = ci.shiftStart || (ci.probabilita != null && ci.probabilita !== '') ||
                (ci.margine != null && ci.margine !== '') || ci.ritardo;
            tr.classList.toggle('modified', !!hasAny);

            refreshDashboard();
        });
    });

    // Attach change events for type override selects
    tbody.querySelectorAll('select.input-type').forEach(sel => {
        sel.addEventListener('change', (e) => {
            if (!activeScenarioId) return;
            const key = e.target.dataset.key;
            const newType = e.target.value || null;
            updateScenarioInput(activeScenarioId, key, { type: newType });

            // Aggiorna dinamicamente disabled di shift/prob/ritardo nella stessa riga
            const effectiveType = newType || e.target.dataset.baseType;
            const tr = e.target.closest('tr');
            const newIsOI = effectiveType === 'Order Intake';
            const newIsBL = effectiveType === 'Backlog';
            const shiftInp = tr.querySelector('.input-shift');
            const probInp  = tr.querySelector('.input-prob');
            const ritInp   = tr.querySelector('.input-ritardo');
            if (shiftInp) shiftInp.disabled = !newIsOI;
            if (probInp)  probInp.disabled  = !newIsOI;
            if (ritInp)   ritInp.disabled   = !newIsBL;

            refreshDashboard();
        });
    });

    // Show modified filter
    $('#chk-show-modified')?.removeEventListener('change', handleShowModified);
    $('#chk-show-modified')?.addEventListener('change', handleShowModified);
}

function handleShowModified() {
    renderAssumptionsTable();
}

// ============================================================
//  GLOBAL SLIDERS
// ============================================================
function setupGlobalSliders() {
    // Order Intake — Shift
    $('#btn-apply-oi-shift')?.addEventListener('click', () => {
        applyGlobal('Order Intake', 'shiftStart', Number($('#global-oi-shift').value) || 0);
    });
    // Order Intake — Prob
    $('#btn-apply-oi-prob')?.addEventListener('click', () => {
        const val = $('#global-oi-prob').value;
        applyGlobal('Order Intake', 'probabilita', val === '' ? null : Number(val));
    });
    // Order Intake — Margin
    $('#btn-apply-oi-margin')?.addEventListener('click', () => {
        const val = $('#global-oi-margin').value;
        applyGlobal('Order Intake', 'margine', val === '' ? null : Number(val));
    });
    // Backlog — Delay
    $('#btn-apply-bl-delay')?.addEventListener('click', () => {
        applyGlobal('Backlog', 'ritardo', Number($('#global-bl-delay').value) || 0);
    });
    // Backlog — Margin
    $('#btn-apply-bl-margin')?.addEventListener('click', () => {
        const val = $('#global-bl-margin').value;
        applyGlobal('Backlog', 'margine', val === '' ? null : Number(val));
    });
}

// ============================================================
//  SCENARIO COMPARISON TABLE (tab: scenario-compare)
// ============================================================

// Sorting state for the comparison table
let scenCompareSortCol = null;   // column key string
let scenCompareSortDir = 'asc';  // 'asc' | 'desc'

function setupScenarioCompareTab() {
    for (const selId of ['#compare-scen-a', '#compare-scen-b']) {
        $(selId)?.addEventListener('change', () => renderScenarioCompareTable());
    }

    // Column sort — delegated on the thead
    $('#scen-compare-table')?.addEventListener('click', (e) => {
        const th = e.target.closest('th[data-sort]');
        if (!th) return;
        const col = th.dataset.sort;
        if (scenCompareSortCol === col) {
            scenCompareSortDir = scenCompareSortDir === 'asc' ? 'desc' : 'asc';
        } else {
            scenCompareSortCol = col;
            scenCompareSortDir = 'asc';
        }
        renderScenarioCompareTable();
    });
}

function renderScenarioCompareTable() {
    if (!appData) return;

    const scenAId = $('#compare-scen-a')?.value;
    const scenBId = $('#compare-scen-b')?.value;
    const scenA = (scenAId && scenAId !== '__baseline__') ? getScenario(scenAId) : null;
    const scenB = (scenBId && scenBId !== '__baseline__') ? getScenario(scenBId) : null;
    const nameA = scenA ? scenA.name : 'Baseline';
    const nameB = scenB ? scenB.name : 'Baseline';

    const filters = getActiveFilters();

    // Include newCommesse from both scenarios
    const newComA = scenA?.newCommesse || [];
    const newComB = scenB?.newCommesse || [];
    const extraKeys = new Set(newComA.map(c => c.key));
    const mergedNew = [...newComA];
    for (const c of newComB) { if (!extraKeys.has(c.key)) mergedNew.push(c); }
    const commesseForCalc = mergedNew.length ? [...appData.commesse, ...mergedNew] : appData.commesse;

    const resultA = computeScenario(commesseForCalc, appData.monthlyData, scenA || {}, filters);
    const resultB = computeScenario(commesseForCalc, appData.monthlyData, scenB || {}, filters);

    const mapA = new Map(resultA.commessaResults.map(c => [c.key, c]));
    const mapB = new Map(resultB.commessaResults.map(c => [c.key, c]));
    const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

    const rows = [];
    for (const key of allKeys) {
        const ca = mapA.get(key);
        const cb = mapB.get(key);
        const comm = ca || cb;
        rows.push({
            key,
            codice:       comm.codice || '—',
            nome:         comm.nome   || '—',
            typeA:        ca?.effectiveType || '—',
            typeB:        cb?.effectiveType || '—',
            probA:        ca?.effectiveProbabilita ?? null,
            probB:        cb?.effectiveProbabilita ?? null,
            margPercA:    ca?.effectiveMargine ?? null,
            margPercB:    cb?.effectiveMargine ?? null,
            vdpA:         ca?.scenVdpTot || 0,
            vdpB:         cb?.scenVdpTot || 0,
            margA:        ca?.scenMarTot || 0,
            margB:        cb?.scenMarTot || 0,
            deltaVdp:    (cb?.scenVdpTot || 0) - (ca?.scenVdpTot || 0),
            deltaMar:    (cb?.scenMarTot || 0) - (ca?.scenMarTot || 0),
            typeChanged:  (ca?.effectiveType || '—') !== (cb?.effectiveType || '—'),
            originalType: comm.type || 'Altro',
        });
    }

    // ── Sorting ──
    const sortKey = scenCompareSortCol;
    const sortDir = scenCompareSortDir === 'asc' ? 1 : -1;
    if (sortKey) {
        rows.sort((a, b) => {
            let va = a[sortKey], vb = b[sortKey];
            if (va == null) va = sortDir === 1 ? Infinity : -Infinity;
            if (vb == null) vb = sortDir === 1 ? Infinity : -Infinity;
            if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
            return (va - vb) * sortDir;
        });
    } else {
        // Default: codice alphabetical
        rows.sort((a, b) => (a.codice || '').localeCompare(b.codice || ''));
    }

    // ── Subtotals per tipo effettivo di ciascuno scenario (non il tipo originale) ──
    // subA[tipo] = somma vdpA/margA delle commesse con typeA === tipo
    // subB[tipo] = somma vdpB/margB delle commesse con typeB === tipo
    // Il delta per categoria = subB[tipo].vdp - subA[tipo].vdp
    const subA = {};
    const subB = {};
    const grand = { vdpA: 0, vdpB: 0, margA: 0, margB: 0, deltaVdp: 0, deltaMar: 0 };
    for (const r of rows) {
        const tA = r.typeA || 'Altro';
        const tB = r.typeB || 'Altro';
        if (!subA[tA]) subA[tA] = { vdp: 0, marg: 0 };
        if (!subB[tB]) subB[tB] = { vdp: 0, marg: 0 };
        subA[tA].vdp  += r.vdpA;
        subA[tA].marg += r.margA;
        subB[tB].vdp  += r.vdpB;
        subB[tB].marg += r.margB;
        grand.vdpA     += r.vdpA;
        grand.vdpB     += r.vdpB;
        grand.margA    += r.margA;
        grand.margB    += r.margB;
        grand.deltaVdp += r.deltaVdp;
        grand.deltaMar += r.deltaMar;
    }

    // ── KPI header ──
    const kpiContainer = $('#scen-compare-kpis');
    if (kpiContainer) {
        const dVdp = grand.deltaVdp;
        const dMar = grand.deltaMar;
        const pVdp = resultA.kpis.totalScenVDP ? (dVdp / resultA.kpis.totalScenVDP * 100) : 0;
        const pMar = resultA.kpis.totalScenMar ? (dMar / resultA.kpis.totalScenMar * 100) : 0;
        kpiContainer.innerHTML = `
          <div class="scen-kpi-block scen-kpi-a">
            <div class="scen-kpi-title">${nameA}</div>
            <div class="scen-kpi-val">${formatEuro(resultA.kpis.totalScenVDP)}</div>
            <div class="scen-kpi-sub">Marg. ${formatEuro(resultA.kpis.totalScenMar)}</div>
          </div>
          <div class="scen-kpi-vs">VS</div>
          <div class="scen-kpi-block scen-kpi-b">
            <div class="scen-kpi-title">${nameB}</div>
            <div class="scen-kpi-val">${formatEuro(resultB.kpis.totalScenVDP)}</div>
            <div class="scen-kpi-sub">Marg. ${formatEuro(resultB.kpis.totalScenMar)}</div>
          </div>
          <div class="scen-kpi-block scen-kpi-delta">
            <div class="scen-kpi-title">Δ B − A</div>
            <div class="scen-kpi-val ${dVdp >= 0 ? 'delta-pos' : 'delta-neg'}">${dVdp >= 0 ? '+' : ''}${formatEuro(dVdp)} <span class="scen-kpi-perc">(${pVdp >= 0 ? '+' : ''}${pVdp.toFixed(1)}%)</span></div>
            <div class="scen-kpi-sub ${dMar >= 0 ? 'delta-pos' : 'delta-neg'}">Δ Marg. ${dMar >= 0 ? '+' : ''}${formatEuro(dMar)} <span class="scen-kpi-perc">(${pMar >= 0 ? '+' : ''}${pMar.toFixed(1)}%)</span></div>
          </div>`;
    }

    // ── Update header sort indicators ──
    $$('#scen-compare-table thead th[data-sort]').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === scenCompareSortCol) {
            th.classList.add(scenCompareSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });

    // ── Table body: data rows (no group separators) ──
    const tbody = $('#scen-compare-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const fmtProb  = v => (v != null ? (v * 100).toFixed(0) + '%' : '—');
    const fmtPerc  = v => (v != null ? (v * 100).toFixed(1) + '%' : '—');
    const dCls     = v => v > 0 ? 'delta-pos' : v < 0 ? 'delta-neg' : '';
    const fmtDelta = v => (v === 0 ? '—' : (v > 0 ? '+' : '') + formatEuro(v));

    for (const row of rows) {
        const tr = document.createElement('tr');
        if (row.typeChanged) tr.classList.add('scen-row-type-changed');

        const typeBadge = row.typeChanged
            ? `<span class="scen-type-badge scen-type-changed" title="Tipo cambiato tra i due scenari">↔</span>`
            : '';

        tr.innerHTML = `
          <td>${row.codice}</td>
          <td class="scen-nome">${row.nome}</td>
          <td><span class="type-badge type-${(row.typeA || '').replace(/\s+/g, '-').toLowerCase()}">${row.typeA}</span></td>
          <td><span class="type-badge type-${(row.typeB || '').replace(/\s+/g, '-').toLowerCase()}">${row.typeB}</span>${typeBadge}</td>
          <td class="col-num">${fmtProb(row.probA)}</td>
          <td class="col-num">${fmtProb(row.probB)}</td>
          <td class="col-num">${formatEuro(row.vdpA)}</td>
          <td class="col-num">${formatEuro(row.vdpB)}</td>
          <td class="col-num ${dCls(row.deltaVdp)}">${fmtDelta(row.deltaVdp)}</td>
          <td class="col-num">${fmtPerc(row.margPercA)}</td>
          <td class="col-num">${fmtPerc(row.margPercB)}</td>
          <td class="col-num ${dCls(row.deltaMar)}">${fmtDelta(row.deltaMar)}</td>`;
        tbody.appendChild(tr);
    }

    // ── Footer matriciale: subtotale OI, subtotale BL, totale generale ──
    // VDP A = somma commesse con typeA === categoria
    // VDP B = somma commesse con typeB === categoria
    // Δ = VDP B (categoria) - VDP A (categoria)
    const footerTypes = ['Order Intake', 'Backlog'];
    let firstFooter = true;
    for (const t of footerTypes) {
        const sA = subA[t]; const sB = subB[t];
        if (!sA && !sB) continue;
        const vdpA  = sA?.vdp  || 0;
        const vdpB  = sB?.vdp  || 0;
        const margA = sA?.marg || 0;
        const margB = sB?.marg || 0;
        const dVdp  = vdpB  - vdpA;
        const dMar  = margB - margA;
        const tr = document.createElement('tr');
        tr.className = 'scen-compare-subtotal' + (firstFooter ? ' scen-footer-first' : '');
        firstFooter = false;
        tr.innerHTML = `
          <td colspan="6"><strong>Totale ${t}</strong></td>
          <td class="col-num"><strong>${formatEuro(vdpA)}</strong></td>
          <td class="col-num"><strong>${formatEuro(vdpB)}</strong></td>
          <td class="col-num ${dCls(dVdp)}"><strong>${fmtDelta(dVdp)}</strong></td>
          <td class="col-num"></td>
          <td class="col-num"></td>
          <td class="col-num ${dCls(dMar)}"><strong>${fmtDelta(dMar)}</strong></td>`;
        tbody.appendChild(tr);
    }

    const totalTr = document.createElement('tr');
    totalTr.className = 'scen-compare-grand-total';
    totalTr.innerHTML = `
      <td colspan="6"><strong>TOTALE GENERALE</strong></td>
      <td class="col-num"><strong>${formatEuro(grand.vdpA)}</strong></td>
      <td class="col-num"><strong>${formatEuro(grand.vdpB)}</strong></td>
      <td class="col-num ${dCls(grand.deltaVdp)}"><strong>${fmtDelta(grand.deltaVdp)}</strong></td>
      <td class="col-num"></td>
      <td class="col-num"></td>
      <td class="col-num ${dCls(grand.deltaMar)}"><strong>${fmtDelta(grand.deltaMar)}</strong></td>`;
    tbody.appendChild(totalTr);

    // ── Charts ──
    renderScenarioCompareCharts(rows, subA, subB, grand, nameA, nameB);
}

function renderScenarioCompareCharts(rows, subA, subB, grand, nameA, nameB) {
    // Destroy previous instances
    charts.scenWaterfall?.destroy();
    delete charts.scenWaterfall;
    charts.scenDeltaRank?.destroy();
    delete charts.scenDeltaRank;
    charts.scenWaterfallMar?.destroy();
    delete charts.scenWaterfallMar;
    charts.scenDeltaRankMar?.destroy();
    delete charts.scenDeltaRankMar;

    const ACCENT  = '#638cff';
    const SUCCESS = '#34d399';
    const DANGER  = '#ff5f5f';
    const TICK_COLOR = '#5a6478';
    const GRID_COLOR = 'rgba(255,255,255,0.04)';

    // ── Chart 1: Bridge / Waterfall VDP ──
    const deltaOI = (subB['Order Intake']?.vdp || 0) - (subA['Order Intake']?.vdp || 0);
    const deltaBL = (subB['Backlog']?.vdp || 0) - (subA['Backlog']?.vdp || 0);
    const vdpA = grand.vdpA;
    const vdpB = grand.vdpB;

    const runOI = vdpA + deltaOI;
    const runBL = runOI + deltaBL;

    // Floating bars: [start, end]
    const wfData = [
        [0, vdpA],        // Scenario A anchor
        [vdpA, runOI],    // Δ Order Intake
        [runOI, runBL],   // Δ Backlog
        [0, vdpB],        // Scenario B anchor
    ];
    const _wrapLabel = (s) => s.length > 12 ? s.split(' ') : s;
    const wfLabels = [_wrapLabel(nameA), ['Δ Order', 'Intake'], 'Δ Backlog', _wrapLabel(nameB)];
    const wfColors = [
        ACCENT,
        deltaOI >= 0 ? SUCCESS : DANGER,
        deltaBL >= 0 ? SUCCESS : DANGER,
        ACCENT,
    ];

    // Update chart title
    const titleEl = $('#scen-waterfall-title');
    if (titleEl) titleEl.textContent = `Bridge VDP — ${nameA} → ${nameB}`;

    const wfCanvas = $('#chart-scen-waterfall');
    if (wfCanvas) {
        charts.scenWaterfall = new Chart(wfCanvas, {
            type: 'bar',
            data: {
                labels: wfLabels,
                datasets: [{
                    label: 'VDP',
                    data: wfData,
                    backgroundColor: wfColors,
                    borderColor: wfColors,
                    borderWidth: 1,
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const d = ctx.raw;
                                const val = Array.isArray(d) ? d[1] - d[0] : d;
                                return ` ${val >= 0 ? '+' : ''}${formatEuro(val)}`;
                            },
                        },
                    },
                    datalabels: {
                        anchor: ctx => {
                            const d = ctx.dataset.data[ctx.dataIndex];
                            const val = Array.isArray(d) ? d[1] - d[0] : d;
                            return val >= 0 ? 'end' : 'start';
                        },
                        align: ctx => {
                            const d = ctx.dataset.data[ctx.dataIndex];
                            const val = Array.isArray(d) ? d[1] - d[0] : d;
                            return val >= 0 ? 'top' : 'bottom';
                        },
                        formatter: (_, ctx) => {
                            const d = ctx.dataset.data[ctx.dataIndex];
                            const v = Array.isArray(d) ? d[1] - d[0] : d;
                            return formatEuro(v);
                        },
                        color: ctx => {
                            const d = ctx.dataset.data[ctx.dataIndex];
                            const v = Array.isArray(d) ? d[1] - d[0] : d;
                            return v >= 0 ? '#1a1a1a' : DANGER;
                        },
                        font: { size: 11, weight: '500' },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: TICK_COLOR, font: { size: 11 } },
                        grid: { color: GRID_COLOR },
                    },
                    y: {
                        ticks: { color: TICK_COLOR, font: { size: 10 }, callback: v => formatEuro(v) },
                        grid: { color: GRID_COLOR },
                    },
                },
            },
            plugins: [ChartDataLabels],
        });
    }

    // ── Shared rank chart builder ──
    function buildRankChart(canvasId, chartKey, allRows, deltaField, label, topN) {
        charts[chartKey]?.destroy();
        delete charts[chartKey];
        const sorted = [...allRows]
            .filter(r => r[deltaField] !== 0)
            .sort((a, b) => Math.abs(b[deltaField]) - Math.abs(a[deltaField]));
        const ranked = topN > 0 ? sorted.slice(0, topN) : sorted;

        const rankLabels = ranked.map(r => r.nome || r.codice || '—');
        const rankData   = ranked.map(r => r[deltaField]);
        const rankColors = ranked.map(r => r[deltaField] >= 0 ? SUCCESS : DANGER);

        const canvas = $(canvasId);
        if (!canvas) return;
        const barH = Math.max(28, 300 / Math.max(ranked.length, 1));
        const canvasH = Math.max(300, ranked.length * barH + 60);
        canvas.parentElement.style.minHeight = canvasH + 'px';

        charts[chartKey] = new Chart(canvas, {
            type: 'bar',
            plugins: [ChartDataLabels],
            data: {
                labels: rankLabels,
                datasets: [{
                    label,
                    data: rankData,
                    backgroundColor: rankColors,
                    borderColor: rankColors,
                    borderWidth: 1,
                    borderRadius: 3,
                }],
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => ` ${ctx.raw >= 0 ? '+' : ''}${formatEuro(ctx.raw)}`,
                        },
                    },
                    datalabels: {
                        anchor: ctx => ctx.dataset.data[ctx.dataIndex] >= 0 ? 'end' : 'start',
                        align: ctx => ctx.dataset.data[ctx.dataIndex] >= 0 ? 'right' : 'left',
                        formatter: v => `${v >= 0 ? '+' : ''}${formatCompact(v)}`,
                        font: { family: 'Inter', size: 10, weight: '600' },
                        color: ctx => ctx.dataset.data[ctx.dataIndex] >= 0 ? '#1a1a1a' : DANGER,
                    },
                },
                scales: {
                    x: {
                        ticks: { color: TICK_COLOR, font: { size: 10 }, callback: v => formatEuro(v) },
                        grid: { color: GRID_COLOR },
                    },
                    y: {
                        ticks: { color: TICK_COLOR, font: { size: 11 } },
                        grid: { display: false },
                    },
                },
            },
        });
    }

    // ── Chart 2: Top Δ VDP per Commessa ──
    let topNVdp = 15;
    buildRankChart('#chart-scen-delta-rank', 'scenDeltaRank', rows, 'deltaVdp', 'Δ VDP (B − A)', topNVdp);

    $('#top-n-vdp')?.querySelectorAll('.top-n-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            topNVdp = parseInt(btn.dataset.n);
            $('#top-n-vdp').querySelectorAll('.top-n-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            buildRankChart('#chart-scen-delta-rank', 'scenDeltaRank', rows, 'deltaVdp', 'Δ VDP (B − A)', topNVdp);
        });
    });

    // ── Chart 3: Bridge / Waterfall Margine ──
    const deltaOI_Mar = (subB['Order Intake']?.marg || 0) - (subA['Order Intake']?.marg || 0);
    const deltaBL_Mar = (subB['Backlog']?.marg || 0) - (subA['Backlog']?.marg || 0);
    const marA = grand.margA;
    const marB = grand.margB;

    const runOI_Mar = marA + deltaOI_Mar;
    const runBL_Mar = runOI_Mar + deltaBL_Mar;

    const wfDataMar = [
        [0, marA],
        [marA, runOI_Mar],
        [runOI_Mar, runBL_Mar],
        [0, marB],
    ];
    const wfLabelsMar = [_wrapLabel(nameA), ['Δ Order', 'Intake'], 'Δ Backlog', _wrapLabel(nameB)];
    const wfColorsMar = [
        ACCENT,
        deltaOI_Mar >= 0 ? SUCCESS : DANGER,
        deltaBL_Mar >= 0 ? SUCCESS : DANGER,
        ACCENT,
    ];

    const titleElMar = $('#scen-waterfall-mar-title');
    if (titleElMar) titleElMar.textContent = `Bridge Margine — ${nameA} → ${nameB}`;

    const wfCanvasMar = $('#chart-scen-waterfall-mar');
    if (wfCanvasMar) {
        charts.scenWaterfallMar = new Chart(wfCanvasMar, {
            type: 'bar',
            data: {
                labels: wfLabelsMar,
                datasets: [{
                    label: 'Margine',
                    data: wfDataMar,
                    backgroundColor: wfColorsMar,
                    borderColor: wfColorsMar,
                    borderWidth: 1,
                    borderRadius: 4,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => {
                                const d = ctx.raw;
                                const val = Array.isArray(d) ? d[1] - d[0] : d;
                                return ` ${val >= 0 ? '+' : ''}${formatEuro(val)}`;
                            },
                        },
                    },
                    datalabels: {
                        anchor: ctx => {
                            const d = ctx.dataset.data[ctx.dataIndex];
                            const val = Array.isArray(d) ? d[1] - d[0] : d;
                            return val >= 0 ? 'end' : 'start';
                        },
                        align: ctx => {
                            const d = ctx.dataset.data[ctx.dataIndex];
                            const val = Array.isArray(d) ? d[1] - d[0] : d;
                            return val >= 0 ? 'top' : 'bottom';
                        },
                        formatter: (_, ctx) => {
                            const d = ctx.dataset.data[ctx.dataIndex];
                            const v = Array.isArray(d) ? d[1] - d[0] : d;
                            return formatEuro(v);
                        },
                        color: ctx => {
                            const d = ctx.dataset.data[ctx.dataIndex];
                            const v = Array.isArray(d) ? d[1] - d[0] : d;
                            return v >= 0 ? '#1a1a1a' : DANGER;
                        },
                        font: { size: 11, weight: '500' },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: TICK_COLOR, font: { size: 11 } },
                        grid: { color: GRID_COLOR },
                    },
                    y: {
                        ticks: { color: TICK_COLOR, font: { size: 10 }, callback: v => formatEuro(v) },
                        grid: { color: GRID_COLOR },
                    },
                },
            },
            plugins: [ChartDataLabels],
        });
    }

    // ── Chart 4: Top Δ Margine per Commessa ──
    let topNMar = 15;
    buildRankChart('#chart-scen-delta-rank-mar', 'scenDeltaRankMar', rows, 'deltaMar', 'Δ Margine (B − A)', topNMar);

    $('#top-n-mar')?.querySelectorAll('.top-n-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            topNMar = parseInt(btn.dataset.n);
            $('#top-n-mar').querySelectorAll('.top-n-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            buildRankChart('#chart-scen-delta-rank-mar', 'scenDeltaRankMar', rows, 'deltaMar', 'Δ Margine (B − A)', topNMar);
        });
    });
}

function applyGlobal(type, field, value) {
    if (!activeScenarioId || !appData) return;
    const filtered = appData.commesse.filter(c => c.type === type);

    // Also apply filter context
    const filters = getActiveFilters();
    for (const c of filtered) {
        if (filters.settori.length && !filters.settori.includes(c.settore)) continue;
        if (filters.commesse.length && !filters.commesse.includes(c.key)) continue;
        updateScenarioInput(activeScenarioId, c.key, { [field]: value });
    }

    renderAssumptionsTable();
    refreshDashboard();
}

// ============================================================
//  COMPARE
// ============================================================
function setupModals() {
    // Compare
    $('#btn-compare')?.addEventListener('click', () => {
        const scenarios = listScenarios();
        const list = $('#compare-scenario-list');
        list.innerHTML = '';
        for (const s of scenarios) {
            const div = document.createElement('div');
            div.className = 'compare-item';
            div.innerHTML = `
        <input type="checkbox" id="cmp-${s.id}" value="${s.id}" ${s.id === activeScenarioId ? 'checked' : ''} />
        <label for="cmp-${s.id}">${s.name}</label>
      `;
            list.appendChild(div);
        }
        if (scenarios.length === 0) {
            list.innerHTML = '<p style="color:var(--text-muted)">Nessuno scenario creato. Crea prima uno scenario.</p>';
        }
        openModal('compare-modal');
    });

    $('#btn-run-compare')?.addEventListener('click', () => {
        const checked = Array.from($$('#compare-scenario-list input:checked')).map(i => i.value);
        if (checked.length === 0) return;
        comparedScenarioIds = checked; // Persist state
        refreshDashboard();
        closeModal('compare-modal');
    });

    // Close modals
    for (const closeBtn of $$('.modal-close')) {
        closeBtn.addEventListener('click', () => {
            closeBtn.closest('.modal').classList.add('hidden');
        });
    }
    for (const backdrop of $$('.modal-backdrop')) {
        backdrop.addEventListener('click', () => {
            backdrop.closest('.modal').classList.add('hidden');
        });
    }
}

function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }

function renderCompareCharts(results) {
    // Switch to dashboard tab
    $$('.tab-btn').forEach(b => b.classList.remove('active'));
    $$('.tab-panel').forEach(p => p.classList.remove('active'));
    $$('.tab-btn')[0].classList.add('active');
    $('#tab-dashboard').classList.add('active');

    // Recompute baseline
    const filters = getActiveFilters();
    const baselineResult = computeScenario(appData.commesse, appData.monthlyData, {}, filters);

    // Collect all months
    const allMonthsSet = new Set(baselineResult.monthly.map(m => m.month));
    for (const r of results) {
        r.result.monthly.forEach(m => allMonthsSet.add(m.month));
    }
    const allMonths = Array.from(allMonthsSet).sort();

    // Build lookup maps
    const baseMap = {};
    for (const m of baselineResult.monthly) baseMap[m.month] = m;

    const scenMaps = results.map(r => {
        const map = {};
        for (const m of r.result.monthly) map[m.month] = m;
        return { name: r.name, map };
    });

    const colors = [
        { bg: 'rgba(52, 211, 153, 0.6)', border: '#34d399' },
        { bg: 'rgba(251, 191, 36, 0.6)', border: '#fbbf24' },
        { bg: 'rgba(244, 114, 182, 0.6)', border: '#f472b6' },
        { bg: 'rgba(168, 85, 247, 0.6)', border: '#a855f7' },
    ];

    const commonOpts = {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { labels: { color: '#8892a8', font: { family: 'Inter', size: 11 } } },
            tooltip: {
                backgroundColor: '#1a2340', borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1,
                callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatEuro(ctx.parsed.y)}` },
            },
        },
        scales: {
            x: { ticks: { color: '#5a6478', font: { size: 10 }, maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { ticks: { color: '#5a6478', font: { size: 10 }, callback: (v) => formatEuro(v) }, grid: { color: 'rgba(255,255,255,0.04)' } },
        },
    };

    Object.values(charts).forEach(c => c.destroy());
    charts = {};

    // Build datasets
    const baseDs = (key) => ({
        label: 'Baseline',
        data: allMonths.map(m => (baseMap[m] || {})[key] || 0),
        backgroundColor: 'rgba(99, 140, 255, 0.6)',
        borderColor: '#638cff', borderWidth: 1,
    });

    const scenDs = (key, i, name) => ({
        label: name,
        data: allMonths.map(m => (scenMaps[i].map[m] || {})[key] || 0),
        backgroundColor: colors[i % colors.length].bg,
        borderColor: colors[i % colors.length].border, borderWidth: 1,
    });

    // VDP Monthly
    charts.vdpMonthly = new Chart($('#chart-vdp-monthly'), {
        type: 'bar',
        data: {
            labels: allMonths,
            datasets: [baseDs('baselineVDP'), ...scenMaps.map((s, i) => scenDs('scenarioVDP', i, s.name))],
        },
        options: commonOpts,
    });

    // VDP Cumulative
    const cumData = (data) => { let c = 0; return data.map(v => c += v); };
    charts.vdpCum = new Chart($('#chart-vdp-cumulative'), {
        type: 'line',
        data: {
            labels: allMonths,
            datasets: [
                { label: 'Baseline', data: cumData(allMonths.map(m => (baseMap[m] || {}).baselineVDP || 0)), borderColor: '#638cff', tension: 0.3, pointRadius: 2, fill: false },
                ...scenMaps.map((s, i) => ({
                    label: s.name,
                    data: cumData(allMonths.map(m => (s.map[m] || {}).scenarioVDP || 0)),
                    borderColor: colors[i % colors.length].border, tension: 0.3, pointRadius: 2, fill: false,
                })),
            ],
        },
        options: commonOpts,
    });

    // Margin Monthly
    charts.marginMonthly = new Chart($('#chart-margin-monthly'), {
        type: 'bar',
        data: {
            labels: allMonths,
            datasets: [baseDs('baselineMargine'), ...scenMaps.map((s, i) => scenDs('scenarioMargine', i, s.name))],
        },
        options: commonOpts,
    });

    // Margin Cumulative
    charts.marginCum = new Chart($('#chart-margin-cumulative'), {
        type: 'line',
        data: {
            labels: allMonths,
            datasets: [
                { label: 'Baseline', data: cumData(allMonths.map(m => (baseMap[m] || {}).baselineMargine || 0)), borderColor: '#638cff', tension: 0.3, pointRadius: 2, fill: false },
                ...scenMaps.map((s, i) => ({
                    label: s.name,
                    data: cumData(allMonths.map(m => (s.map[m] || {}).scenarioMargine || 0)),
                    borderColor: colors[i % colors.length].border, tension: 0.3, pointRadius: 2, fill: false,
                })),
            ],
        },
        options: commonOpts,
    });

    // KPI compare row
    renderCompareKPIs(results, baselineResult.kpis);
}

function renderCompareKPIs(results, baselineKpis) {
    const row = $('#kpi-row-compare');
    const normalRow = $('#kpi-row');
    if (!row) return;

    // Nascondi riga normale, mostra riga compare
    normalRow?.classList.add('hidden');
    row.classList.remove('hidden');

    const fmtMargP = (mar, vdp) => vdp > 0 ? (mar / vdp * 100).toFixed(1) + '%' : '—';
    const fmtDelta = (v, base) => {
        if (base === 0) return '—';
        const perc = (v / base * 100).toFixed(1);
        const sign = v >= 0 ? '+' : '';
        return `${sign}${formatEuro(v)} (${sign}${perc}%)`;
    };
    const fmtDeltaMargPP = (scenMar, scenVdp, baseMar, baseVdp) => {
        if (scenVdp <= 0 || baseVdp <= 0) return null;
        const diff = (scenMar / scenVdp - baseMar / baseVdp) * 100;
        const sign = diff >= 0 ? '+' : '';
        return `${sign}${diff.toFixed(1)} pp`;
    };
    const deltaClass = v => v >= 0 ? 'delta-pos' : 'delta-neg';

    // Card Baseline
    const baseVdp = baselineKpis.totalBaseVDP;
    const baseMar = baselineKpis.totalBaseMar;

    let html = `
      <div class="kpi-compare-card card-baseline">
        <div class="kpi-compare-name">Baseline</div>
        <div class="kpi-compare-row">
          <span class="kpi-compare-row-label">VDP</span>
          <span class="kpi-compare-row-val">${formatEuro(baseVdp)}</span>
        </div>
        <div class="kpi-compare-row">
          <span class="kpi-compare-row-label">Margine</span>
          <span class="kpi-compare-row-val">${formatEuro(baseMar)}</span>
        </div>
        <div class="kpi-compare-margp">Marg% ${fmtMargP(baseMar, baseVdp)}</div>
      </div>`;

    // Card per ogni scenario
    results.forEach((r, i) => {
        const kpis = r.result.kpis;
        const sVdp = kpis.totalScenVDP;
        const sMar = kpis.totalScenMar;
        const dVdp = sVdp - baseVdp;
        const dMar = sMar - baseMar;
        const dMargPP = fmtDeltaMargPP(sMar, sVdp, baseMar, baseVdp);

        html += `
          <div class="kpi-compare-card card-scen-${i}">
            <div class="kpi-compare-name" title="${r.name}">${r.name}</div>
            <div class="kpi-compare-row">
              <span class="kpi-compare-row-label">VDP</span>
              <span class="kpi-compare-row-val">${formatEuro(sVdp)}</span>
            </div>
            <div class="kpi-compare-row">
              <span class="kpi-compare-row-label">Margine</span>
              <span class="kpi-compare-row-val">${formatEuro(sMar)}</span>
            </div>
            <div class="kpi-compare-margp">Marg% ${fmtMargP(sMar, sVdp)}</div>
            <div class="kpi-compare-deltas">
              <div class="kpi-compare-delta-item">
                <span>Δ VDP</span>
                <span class="${deltaClass(dVdp)}">${fmtDelta(dVdp, baseVdp)}</span>
              </div>
              <div class="kpi-compare-delta-item">
                <span>Δ Margine</span>
                <span class="${deltaClass(dMar)}">${fmtDelta(dMar, baseMar)}</span>
              </div>
              ${dMargPP ? `<div class="kpi-compare-delta-item">
                <span>Δ Marg%</span>
                <span class="${deltaClass(parseFloat(dMargPP))}">${dMargPP}</span>
              </div>` : ''}
            </div>
          </div>`;
    });

    row.innerHTML = html;
}

// ============================================================
//  EXPORT
// ============================================================
function setupExportEvents() {
    $('#btn-export')?.addEventListener('click', () => openModal('export-modal'));

    $('#btn-export-template')?.addEventListener('click', () => {
        if (!lastResult) return;
        const scen = activeScenarioId ? getScenario(activeScenarioId) : null;
        exportToTemplate(lastResult.commessaResults, scen?.name || 'Baseline');
        closeModal('export-modal');
    });

    $('#btn-export-xlsx')?.addEventListener('click', () => {
        if (!lastResult) return;
        const scen = activeScenarioId ? getScenario(activeScenarioId) : null;
        exportToExcel(lastResult.monthly, lastResult.commessaResults, scen?.name || 'Baseline');
        closeModal('export-modal');
    });

    $('#btn-export-csv')?.addEventListener('click', () => {
        if (!lastResult) return;
        const scen = activeScenarioId ? getScenario(activeScenarioId) : null;
        exportToCSV(lastResult.monthly, scen?.name || 'Baseline');
        closeModal('export-modal');
    });

    // ── Backup / Restore (selettivo) ──
    const BACKUP_GROUPS = {
        scenari:     ['whatif_baseline', 'whatif_scenarios'],
        risorse:     ['whatif_ruoli', 'whatif_persone', 'whatif_allocazioni', 'whatif_audit'],
        preferenze:  ['theme', 'appZoomLevel', 'res-cessate-banner-collapsed', 'res-cessate-ignorati-collapsed', 'whatif_supabase_auth', 'whatif_sync_queue', 'whatif_sync_last', 'whatif_deleted_scenarios', 'whatif_deleted_persone', 'whatif_deleted_allocazioni'],
    };

    $('#btn-backup-export')?.addEventListener('click', () => {
        const includi = {
            scenari:    $('#bkp-scenari')?.checked,
            risorse:    $('#bkp-risorse')?.checked,
            preferenze: $('#bkp-preferenze')?.checked,
        };
        if (!includi.scenari && !includi.risorse && !includi.preferenze) {
            alert('Seleziona almeno una categoria da esportare.');
            return;
        }
        const keys = [];
        for (const [group, groupKeys] of Object.entries(BACKUP_GROUPS)) {
            if (includi[group]) keys.push(...groupKeys);
        }
        const backup = {
            _meta: {
                version: 2,
                appName: 'Scenario Whatif',
                exportedAt: new Date().toISOString(),
                includes: Object.keys(includi).filter(k => includi[k]),
            },
            data: {},
        };
        for (const key of keys) {
            const val = localStorage.getItem(key);
            if (val !== null) backup.data[key] = val;
        }
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const dateStr = new Date().toISOString().slice(0, 10);
        const suffix = includi.scenari && includi.risorse ? 'completo'
            : includi.scenari ? 'scenari'
            : includi.risorse ? 'risorse'
            : 'preferenze';
        a.download = `whatif-backup-${suffix}-${dateStr}.json`;
        a.click();
        URL.revokeObjectURL(url);
        closeModal('export-modal');
    });

    $('#btn-backup-import')?.addEventListener('click', () => {
        $('#backup-file-input')?.click();
    });

    $('#backup-file-input')?.addEventListener('change', e => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const backup = JSON.parse(reader.result);
                if (!backup._meta || !backup.data) {
                    alert('File non valido — non è un backup di Scenario Whatif.');
                    return;
                }
                const exportDate = backup._meta.exportedAt
                    ? new Date(backup._meta.exportedAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
                    : 'data sconosciuta';

                // Rileva cosa contiene il backup
                const hasScenari = BACKUP_GROUPS.scenari.some(k => k in backup.data);
                const hasRisorse = BACKUP_GROUPS.risorse.some(k => k in backup.data);
                const hasPreferenze = BACKUP_GROUPS.preferenze.some(k => k in backup.data);
                const contenuto = [
                    hasScenari ? 'Scenari (baseline + scenari)' : null,
                    hasRisorse ? 'Risorse (persone + allocazioni)' : null,
                    hasPreferenze ? 'Preferenze (tema, zoom)' : null,
                ].filter(Boolean);

                const msg = `Backup del ${exportDate}\n\nContenuto:\n${contenuto.map(c => `  • ${c}`).join('\n')}\n\nSOLO queste categorie verranno sovrascritte.\nI dati delle altre categorie rimarranno invariati.\n\nProcedere?`;
                if (!confirm(msg)) return;

                for (const [key, val] of Object.entries(backup.data)) {
                    localStorage.setItem(key, val);
                }
                closeModal('export-modal');
                alert('Backup ripristinato con successo. L\'applicazione verrà ricaricata.');
                location.reload();
            } catch (err) {
                alert('Errore nella lettura del file: ' + err.message);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // ── Genera Report ──
    $('#btn-report')?.addEventListener('click', () => openModal('report-modal'));
    $('#report-modal-close')?.addEventListener('click', () => closeModal('report-modal'));

    $('#btn-generate-report')?.addEventListener('click', async () => {
        const sections = {
            dashboard:      $('#rpt-dashboard')?.checked,
            scenario:       $('#rpt-scenario')?.checked,
            economics:      $('#rpt-economics')?.checked,
            capacity:       $('#rpt-capacity')?.checked,
            pianificazione: $('#rpt-pianificazione')?.checked,
            persone:        $('#rpt-persone')?.checked,
        };

        const useFilters = $('#rpt-use-filters')?.checked;
        const progressBar = $('#report-progress');
        const progressFill = $('#report-progress-fill');
        const progressText = $('#report-progress-text');
        const btnGenerate = $('#btn-generate-report');

        progressBar.style.display = 'block';
        btnGenerate.disabled = true;
        btnGenerate.textContent = 'Generazione in corso...';

        const onProgress = (pct, msg) => {
            progressFill.style.width = `${pct}%`;
            progressText.textContent = msg;
        };

        try {
            // Scenario data
            const scenarioData = lastResult || null;
            const scen = activeScenarioId ? getScenario(activeScenarioId) : null;
            const scenarioName = scen?.name || 'Baseline';

            // Date range
            const dateFrom = useFilters ? ($('#filter-date-from')?.value || '') : '';
            const dateTo = useFilters ? ($('#filter-date-to')?.value || '') : '';
            const dateRange = { from: dateFrom, to: dateTo };
            const periodo = dateFrom && dateTo
                ? `${fmtYMForReport(dateFrom)} → ${fmtYMForReport(dateTo)}`
                : dateFrom ? `Da ${fmtYMForReport(dateFrom)}`
                : dateTo ? `Fino a ${fmtYMForReport(dateTo)}`
                : 'Tutto il periodo';

            // Resource data
            let resourceData = null;
            if (sections.economics || sections.capacity || sections.pianificazione || sections.persone) {
                const persone = listPersone();
                const commesse = appData?.commesse || [];
                const scenarioId = activeScenarioId;
                const allocazioni = listAllocazioni({ scenarioId });

                // Build months from allocations for capacity
                const monthSet = new Set();
                for (const a of allocazioni) {
                    if (!a.dataInizio || !a.dataFine) continue;
                    let cur = a.dataInizio;
                    while (cur <= a.dataFine) {
                        if ((!dateRange.from || cur >= dateRange.from) && (!dateRange.to || cur <= dateRange.to)) {
                            monthSet.add(cur);
                        }
                        const [yy, mm] = cur.split('-').map(Number);
                        const t = yy * 12 + mm;
                        cur = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
                    }
                }
                // Fill gaps
                if (monthSet.size > 0) {
                    const sorted = [...monthSet].sort();
                    let cur = sorted[0];
                    const last = sorted[sorted.length - 1];
                    while (cur < last) {
                        monthSet.add(cur);
                        const [yy, mm] = cur.split('-').map(Number);
                        const t = yy * 12 + mm;
                        cur = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
                    }
                }
                const months = [...monthSet].sort();

                const getEffDates = (codice, sid) => {
                    if (!appData) return null;
                    const comm = commesse.find(c => c.codice === codice);
                    if (!comm) return null;
                    const resolvedId = sid !== undefined ? sid : activeScenarioId;
                    const s = resolvedId ? getScenario(resolvedId) : null;
                    const result = computeScenario([comm], appData.monthlyData, s || {}, {});
                    const cr = result?.commessaResults?.[0];
                    const withVdp = (cr?.scenarioMonths || []).filter(m => (m.vdp || 0) !== 0).map(m => m.month).sort();
                    if (!withVdp.length) return null;
                    return { dataInizio: withVdp[0], dataFine: withVdp[withVdp.length - 1] };
                };

                const matrix = computeResourceMatrix(scenarioId, commesse, months, getEffDates);
                const kpis = computeResourceKpis(matrix, months);

                resourceData = { persone, allocazioni, commesse, matrix, months, kpis, dateRange, getEffectiveDates: getEffDates };
            }

            await generateReport({
                scenarioData,
                resourceData,
                scenarioName,
                periodo,
                sections,
                onProgress,
            });

            // Chiudi modal dopo generazione riuscita
            setTimeout(() => {
                closeModal('report-modal');
                progressBar.style.display = 'none';
                progressFill.style.width = '0%';
                btnGenerate.disabled = false;
                btnGenerate.textContent = 'Genera PDF';
            }, 800);

        } catch (err) {
            console.error('Report generation error:', err);
            alert('Errore nella generazione del report: ' + err.message);
            btnGenerate.disabled = false;
            btnGenerate.textContent = 'Genera PDF';
            progressBar.style.display = 'none';
            progressFill.style.width = '0%';
        }
    });
}

function fmtYMForReport(ym) {
    if (!ym) return '';
    const [y, m] = ym.split('-');
    const mesi = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
    return `${mesi[parseInt(m)-1]} ${y}`;
}

// ============================================================
//  ZOOM CONTROLS
// ============================================================
function setupZoomControls() {
    const ZOOM_STEP = 10;
    const ZOOM_MIN = 50;
    const ZOOM_MAX = 200;
    const ZOOM_DEFAULT = 100;

    // Load saved zoom level
    let currentZoom = parseInt(localStorage.getItem('appZoomLevel')) || ZOOM_DEFAULT;
    applyZoom(currentZoom);

    function applyZoom(level) {
        currentZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level));
        const factor = currentZoom / 100;

        if (window.electronAPI?.setZoomFactor) {
            // In Electron: usa lo zoom nativo — mouse events e coordinate sono
            // automaticamente coerenti, nessun offset su Chart.js
            window.electronAPI.setZoomFactor(factor);
            // Ripristina eventuali override CSS residui
            document.body.style.zoom = '';
            document.body.style.width = '';
            document.body.style.height = '';
        } else {
            // Fallback per dev-mode nel browser
            document.body.style.zoom = factor.toString();
            document.body.style.width = (100 / factor) + 'vw';
            document.body.style.height = (100 / factor) + 'vh';
        }

        const label = $('#zoom-level-text');
        if (label) label.textContent = currentZoom + '%';
        localStorage.setItem('appZoomLevel', currentZoom);

        // Forza il resize dei grafici dopo il cambio di zoom
        setTimeout(() => {
            Object.values(charts).forEach(c => {
                if (typeof c.resize === 'function') c.resize();
            });
            window.dispatchEvent(new Event('resize'));
        }, 100);
    }

    // Button handlers
    $('#btn-zoom-in')?.addEventListener('click', () => applyZoom(currentZoom + ZOOM_STEP));
    $('#btn-zoom-out')?.addEventListener('click', () => applyZoom(currentZoom - ZOOM_STEP));
    $('#btn-zoom-reset')?.addEventListener('click', () => applyZoom(ZOOM_DEFAULT));

    $('#btn-zoom-fit')?.addEventListener('click', () => {
        // Use a stable reference width (1800px covers most dashboard layouts)
        const targetWidth = 1800;
        const availableWidth = window.innerWidth;

        // Calculate fit level
        let fitLevel = Math.floor((availableWidth / targetWidth) * 100);

        // CAP at 100% to avoid unwanted zoom-in on large screens
        if (fitLevel > 100) fitLevel = 100;

        // Apply
        applyZoom(fitLevel);
    });

    // Keyboard shortcuts: Ctrl+Plus, Ctrl+Minus, Ctrl+0
    document.addEventListener('keydown', (e) => {
        if (!e.ctrlKey && !e.metaKey) return;

        if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
            e.preventDefault();
            applyZoom(currentZoom + ZOOM_STEP);
        } else if (e.key === '-' || e.code === 'NumpadSubtract') {
            e.preventDefault();
            applyZoom(currentZoom - ZOOM_STEP);
        } else if (e.key === '0' || e.code === 'Numpad0') {
            e.preventDefault();
            applyZoom(ZOOM_DEFAULT);
        }
    });
}

// ============================================================
//  CHART DOWNLOAD BUTTONS
// ============================================================
function setupChartDownloads() {
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.chart-download-btn');
        if (!btn) return;
        const chart = btn.dataset.chart;
        if (chart === 'scen-compare-table') { exportScenCompareTable(); return; }
        if (!lastResult) return;
        buildAndExportChart(chart);
    });
}

function exportScenCompareTable() {
    if (!appData) return;

    const scenAId = $('#compare-scen-a')?.value;
    const scenBId = $('#compare-scen-b')?.value;
    const scenA = (scenAId && scenAId !== '__baseline__') ? getScenario(scenAId) : null;
    const scenB = (scenBId && scenBId !== '__baseline__') ? getScenario(scenBId) : null;
    const nameA = scenA ? scenA.name : 'Baseline';
    const nameB = scenB ? scenB.name : 'Baseline';

    const filters = getActiveFilters();
    const newComA = scenA?.newCommesse || [];
    const newComB = scenB?.newCommesse || [];
    const extraKeys = new Set(newComA.map(c => c.key));
    const mergedNew = [...newComA];
    for (const c of newComB) { if (!extraKeys.has(c.key)) mergedNew.push(c); }
    const commesseForCalc = mergedNew.length ? [...appData.commesse, ...mergedNew] : appData.commesse;

    const resultA = computeScenario(commesseForCalc, appData.monthlyData, scenA || {}, filters);
    const resultB = computeScenario(commesseForCalc, appData.monthlyData, scenB || {}, filters);

    const mapA = new Map(resultA.commessaResults.map(c => [c.key, c]));
    const mapB = new Map(resultB.commessaResults.map(c => [c.key, c]));
    const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

    const rows = [];
    for (const key of allKeys) {
        const ca = mapA.get(key);
        const cb = mapB.get(key);
        const comm = ca || cb;
        rows.push({
            key,
            codice:      comm.codice || '—',
            nome:        comm.nome   || '—',
            typeA:       ca?.effectiveType || '—',
            typeB:       cb?.effectiveType || '—',
            probA:       ca?.effectiveProbabilita ?? null,
            probB:       cb?.effectiveProbabilita ?? null,
            margPercA:   ca?.effectiveMargine ?? null,
            margPercB:   cb?.effectiveMargine ?? null,
            vdpA:        ca?.scenVdpTot || 0,
            vdpB:        cb?.scenVdpTot || 0,
            margA:       ca?.scenMarTot || 0,
            margB:       cb?.scenMarTot || 0,
            deltaVdp:   (cb?.scenVdpTot || 0) - (ca?.scenVdpTot || 0),
            deltaMar:   (cb?.scenMarTot || 0) - (ca?.scenMarTot || 0),
            originalType: comm.type || 'Altro',
        });
    }

    // Apply same sort as the table
    const sortKey = scenCompareSortCol;
    const sortDir = scenCompareSortDir === 'asc' ? 1 : -1;
    if (sortKey) {
        rows.sort((a, b) => {
            let va = a[sortKey], vb = b[sortKey];
            if (va == null) va = sortDir === 1 ? Infinity : -Infinity;
            if (vb == null) vb = sortDir === 1 ? Infinity : -Infinity;
            if (typeof va === 'string') return va.localeCompare(vb) * sortDir;
            return (va - vb) * sortDir;
        });
    } else {
        rows.sort((a, b) => (a.codice || '').localeCompare(b.codice || ''));
    }

    // Subtotals per tipo effettivo di ciascuno scenario + grand total
    const subA = {};
    const subB = {};
    const grand = { vdpA: 0, vdpB: 0, margA: 0, margB: 0, deltaVdp: 0, deltaMar: 0 };
    for (const r of rows) {
        const tA = r.typeA || 'Altro'; const tB = r.typeB || 'Altro';
        if (!subA[tA]) subA[tA] = { vdp: 0, marg: 0 };
        if (!subB[tB]) subB[tB] = { vdp: 0, marg: 0 };
        subA[tA].vdp  += r.vdpA;  subA[tA].marg += r.margA;
        subB[tB].vdp  += r.vdpB;  subB[tB].marg += r.margB;
        grand.vdpA += r.vdpA; grand.vdpB += r.vdpB;
        grand.margA += r.margA; grand.margB += r.margB;
        grand.deltaVdp += r.deltaVdp; grand.deltaMar += r.deltaMar;
    }

    const fmtP = v => (v != null ? +(v * 100).toFixed(1) : null);
    const colVdpA   = `VDP ${nameA}`;
    const colVdpB   = `VDP ${nameB}`;
    const colMargA  = `Marg% ${nameA}`;
    const colMargB  = `Marg% ${nameB}`;

    const exRows = rows.map(r => ({
        'Codice':           r.codice,
        'Commessa':         r.nome,
        [`Tipo ${nameA}`]:  r.typeA,
        [`Tipo ${nameB}`]:  r.typeB,
        [`Prob% ${nameA}`]: fmtP(r.probA),
        [`Prob% ${nameB}`]: fmtP(r.probB),
        [colVdpA]:          Math.round(r.vdpA),
        [colVdpB]:          Math.round(r.vdpB),
        'Δ VDP':            Math.round(r.deltaVdp),
        [colMargA]:         fmtP(r.margPercA),
        [colMargB]:         fmtP(r.margPercB),
        'Δ Margine (€)':    Math.round(r.deltaMar),
        'Tipo originale':   r.originalType,
    }));

    // Footer rows con aggregazione per tipo effettivo di ciascuno scenario
    for (const t of ['Order Intake', 'Backlog']) {
        const sA = subA[t]; const sB = subB[t];
        if (!sA && !sB) continue;
        const vdpA = sA?.vdp || 0; const vdpB = sB?.vdp || 0;
        exRows.push({
            'Codice': '',
            'Commessa': `TOTALE ${t}`,
            [colVdpA]:       Math.round(vdpA),
            [colVdpB]:       Math.round(vdpB),
            'Δ VDP':         Math.round(vdpB - vdpA),
            'Δ Margine (€)': Math.round((sB?.marg || 0) - (sA?.marg || 0)),
        });
    }
    exRows.push({
        'Codice': '',
        'Commessa': 'TOTALE GENERALE',
        [colVdpA]:       Math.round(grand.vdpA),
        [colVdpB]:       Math.round(grand.vdpB),
        'Δ VDP':         Math.round(grand.deltaVdp),
        'Δ Margine (€)': Math.round(grand.deltaMar),
    });

    const filename = `Comparison_${nameA}_vs_${nameB}`.replace(/[^a-zA-Z0-9_\-]/g, '_');
    exportChartToExcel(filename, exRows);
}

function buildAndExportChart(chart) {
    const { monthly, commessaResults } = lastResult;

    // ── Dashboard ──────────────────────────────────────────────
    if (chart === 'vdp-monthly') {
        const rows = monthly.map(m => ({
            'Mese':               m.month,
            'Baseline (AOP)':     Math.round(m.baselineVDP),
            'Scenario (Actual)':  Math.round(m.scenarioActual),
            'Scenario (Remaining)': Math.round(m.scenarioRemaining),
            'Scenario (Totale)':  Math.round(m.scenarioVDP),
        }));
        exportChartToExcel('VDP_Mensile', rows);
        return;
    }

    if (chart === 'vdp-cumulative') {
        let cumBase = 0, cumActual = 0, cumTotal = 0;
        const rows = monthly.map(m => {
            cumBase   += m.baselineVDP;
            cumActual += m.scenarioActual;
            cumTotal  += m.scenarioVDP;
            return {
                'Mese':                    m.month,
                'Cumulato Baseline (AOP)': Math.round(cumBase),
                'Cumulato Scenario (Actual)': Math.round(cumActual),
                'Cumulato Scenario (Total)':  Math.round(cumTotal),
            };
        });
        exportChartToExcel('VDP_Cumulato', rows);
        return;
    }

    if (chart === 'margin-monthly') {
        const rows = monthly.map(m => ({
            'Mese':              m.month,
            'Margine Baseline':  Math.round(m.baselineMargine),
            'Margine Scenario':  Math.round(m.scenarioMargine),
            'Delta Margine':     Math.round(m.scenarioMargine - m.baselineMargine),
        }));
        exportChartToExcel('Margine_Mensile', rows);
        return;
    }

    if (chart === 'margin-cumulative') {
        let cumBase = 0, cumScen = 0;
        const rows = monthly.map(m => {
            cumBase += m.baselineMargine;
            cumScen += m.scenarioMargine;
            return {
                'Mese':                      m.month,
                'Cumulato Margine Baseline': Math.round(cumBase),
                'Cumulato Margine Scenario': Math.round(cumScen),
                'Delta Cumulato':            Math.round(cumScen - cumBase),
            };
        });
        exportChartToExcel('Margine_Cumulato', rows);
        return;
    }

    // ── Details Commessa ───────────────────────────────────────
    if (chart === 'details-vdp') {
        const rows = [];
        for (const comm of commessaResults) {
            for (const sm of (comm.scenarioMonths || [])) {
                if (!sm.vdp && !sm.margine) continue;
                rows.push({
                    'Mese':     sm.month,
                    'Codice':   comm.codice,
                    'Commessa': comm.nome,
                    'Settore':  comm.settore,
                    'Type':     comm.effectiveType || comm.type,
                    'VDP Scenario': Math.round(sm.vdp || 0),
                });
            }
        }
        exportChartToExcel('Details_VDP_per_Commessa', rows);
        return;
    }

    if (chart === 'details-mar') {
        const rows = [];
        for (const comm of commessaResults) {
            for (const sm of (comm.scenarioMonths || [])) {
                if (!sm.vdp && !sm.margine) continue;
                rows.push({
                    'Mese':     sm.month,
                    'Codice':   comm.codice,
                    'Commessa': comm.nome,
                    'Settore':  comm.settore,
                    'Type':     comm.effectiveType || comm.type,
                    'Margine Scenario': Math.round(sm.margine || 0),
                });
            }
        }
        exportChartToExcel('Details_Margine_per_Commessa', rows);
        return;
    }

    // ── Details Type ───────────────────────────────────────────
    if (chart === 'details-type-vdp') {
        const byTypeMonth = {};
        for (const comm of commessaResults) {
            const type = comm.effectiveType || comm.type || 'Backlog';
            for (const sm of (comm.scenarioMonths || [])) {
                const k = `${sm.month}|||${type}`;
                byTypeMonth[k] = (byTypeMonth[k] || 0) + (sm.vdp || 0);
            }
        }
        const rows = Object.entries(byTypeMonth)
            .map(([k, v]) => { const [mese, type] = k.split('|||'); return { 'Mese': mese, 'Type': type, 'VDP Scenario': Math.round(v) }; })
            .sort((a, b) => a['Mese'].localeCompare(b['Mese']) || a['Type'].localeCompare(b['Type']));
        exportChartToExcel('Details_Type_VDP', rows);
        return;
    }

    if (chart === 'details-type-mar') {
        const byTypeMonth = {};
        for (const comm of commessaResults) {
            const type = comm.effectiveType || comm.type || 'Backlog';
            for (const sm of (comm.scenarioMonths || [])) {
                const k = `${sm.month}|||${type}`;
                byTypeMonth[k] = (byTypeMonth[k] || 0) + (sm.margine || 0);
            }
        }
        const rows = Object.entries(byTypeMonth)
            .map(([k, v]) => { const [mese, type] = k.split('|||'); return { 'Mese': mese, 'Type': type, 'Margine Scenario': Math.round(v) }; })
            .sort((a, b) => a['Mese'].localeCompare(b['Mese']) || a['Type'].localeCompare(b['Type']));
        exportChartToExcel('Details_Type_Margine', rows);
        return;
    }

    // ── Comparison Annualità ───────────────────────────────────
    if (chart === 'vdp-yearly') {
        const yearBaseVdp = {}, yearScenVdp = {};
        for (const m of monthly) {
            const y = m.month.substring(0, 4);
            yearBaseVdp[y] = (yearBaseVdp[y] || 0) + m.baselineVDP;
            yearScenVdp[y] = (yearScenVdp[y] || 0) + m.scenarioVDP;
        }
        const years = [...new Set([...Object.keys(yearBaseVdp), ...Object.keys(yearScenVdp)])].sort();
        const rows = years.map(y => ({
            'Anno':           y,
            'VDP Baseline':   Math.round(yearBaseVdp[y] || 0),
            'VDP Scenario':   Math.round(yearScenVdp[y] || 0),
            'Delta VDP':      Math.round((yearScenVdp[y] || 0) - (yearBaseVdp[y] || 0)),
        }));
        exportChartToExcel('VDP_per_Anno', rows);
        return;
    }

    if (chart === 'margin-yearly') {
        const yearBaseMar = {}, yearScenMar = {};
        for (const m of monthly) {
            const y = m.month.substring(0, 4);
            yearBaseMar[y] = (yearBaseMar[y] || 0) + m.baselineMargine;
            yearScenMar[y] = (yearScenMar[y] || 0) + m.scenarioMargine;
        }
        const years = [...new Set([...Object.keys(yearBaseMar), ...Object.keys(yearScenMar)])].sort();
        const rows = years.map(y => ({
            'Anno':              y,
            'Margine Baseline':  Math.round(yearBaseMar[y] || 0),
            'Margine Scenario':  Math.round(yearScenMar[y] || 0),
            'Delta Margine':     Math.round((yearScenMar[y] || 0) - (yearBaseMar[y] || 0)),
        }));
        exportChartToExcel('Margine_per_Anno', rows);
        return;
    }

    if (chart === 'vdp-type') {
        const yearTypeVdp = {};
        for (const comm of commessaResults) {
            const type = comm.effectiveType || comm.type || 'Altro';
            for (const sm of (comm.scenarioMonths || [])) {
                const y = sm.month.substring(0, 4);
                if (!yearTypeVdp[y]) yearTypeVdp[y] = {};
                yearTypeVdp[y][type] = (yearTypeVdp[y][type] || 0) + (sm.actual || 0) + (sm.remaining || 0);
            }
        }
        const years = [...new Set(Object.keys(yearTypeVdp))].sort();
        const types = [...new Set(commessaResults.map(c => c.effectiveType || c.type || 'Altro'))].sort();
        const rows = years.flatMap(y => types.map(t => ({
            'Anno': y, 'Type': t, 'VDP Scenario': Math.round((yearTypeVdp[y] || {})[t] || 0),
        })));
        exportChartToExcel('VDP_Scenario_per_Tipo_Anno', rows);
        return;
    }

    if (chart === 'margin-type') {
        const yearTypeMar = {};
        for (const comm of commessaResults) {
            const type = comm.effectiveType || comm.type || 'Altro';
            for (const sm of (comm.scenarioMonths || [])) {
                const y = sm.month.substring(0, 4);
                if (!yearTypeMar[y]) yearTypeMar[y] = {};
                yearTypeMar[y][type] = (yearTypeMar[y][type] || 0) + (sm.margine || 0);
            }
        }
        const years = [...new Set(Object.keys(yearTypeMar))].sort();
        const types = [...new Set(commessaResults.map(c => c.effectiveType || c.type || 'Altro'))].sort();
        const rows = years.flatMap(y => types.map(t => ({
            'Anno': y, 'Type': t, 'Margine Scenario': Math.round((yearTypeMar[y] || {})[t] || 0),
        })));
        exportChartToExcel('Margine_Scenario_per_Tipo_Anno', rows);
        return;
    }

    if (chart === 'waterfall-vdp') {
        const sorted = [...commessaResults].sort((a, b) => b.deltaVdp - a.deltaVdp);
        const rows = [
            { 'Label': 'Baseline', 'VDP Baseline': Math.round(commessaResults.reduce((s, c) => s + c.baseVdpTot, 0)), 'VDP Scenario': '', 'Delta VDP': '' },
            ...sorted.map(c => ({
                'Label': `${c.codice} · ${c.nome}`,
                'VDP Baseline': Math.round(c.baseVdpTot),
                'VDP Scenario': Math.round(c.scenVdpTot),
                'Delta VDP': Math.round(c.deltaVdp),
            })),
            { 'Label': 'Scenario', 'VDP Baseline': '', 'VDP Scenario': Math.round(commessaResults.reduce((s, c) => s + c.scenVdpTot, 0)), 'Delta VDP': '' },
        ];
        exportChartToExcel('Waterfall_VDP_per_Commessa', rows);
        return;
    }

    if (chart === 'waterfall-mar') {
        const sorted = [...commessaResults].sort((a, b) => b.deltaMar - a.deltaMar);
        const rows = [
            { 'Label': 'Baseline', 'Margine Baseline': Math.round(commessaResults.reduce((s, c) => s + c.baseMarTot, 0)), 'Margine Scenario': '', 'Delta Margine': '' },
            ...sorted.map(c => ({
                'Label': `${c.codice} · ${c.nome}`,
                'Margine Baseline': Math.round(c.baseMarTot),
                'Margine Scenario': Math.round(c.scenMarTot),
                'Delta Margine': Math.round(c.deltaMar),
            })),
            { 'Label': 'Scenario', 'Margine Baseline': '', 'Margine Scenario': Math.round(commessaResults.reduce((s, c) => s + c.scenMarTot, 0)), 'Delta Margine': '' },
        ];
        exportChartToExcel('Waterfall_Margine_per_Commessa', rows);
        return;
    }

    // ── Type & Settore ─────────────────────────────────────────
    if (chart === 'type-comparison') {
        const types = [...new Set(['Backlog', 'Order Intake', ...commessaResults.map(c => c.effectiveType || c.type)])];
        const baseByType = {}, scenByType = {};
        for (const comm of commessaResults) {
            const bt = comm.type || 'Altro';
            const st = comm.effectiveType || comm.type || 'Altro';
            baseByType[bt] = (baseByType[bt] || 0) + comm.baseVdpTot;
            scenByType[st] = (scenByType[st] || 0) + comm.scenVdpTot;
        }
        const rows = types.map(t => ({
            'Type':          t,
            'VDP Baseline':  Math.round(baseByType[t] || 0),
            'VDP Scenario':  Math.round(scenByType[t] || 0),
            'Delta VDP':     Math.round((scenByType[t] || 0) - (baseByType[t] || 0)),
        }));
        exportChartToExcel('VDP_per_Tipo_Baseline_vs_Scenario', rows);
        return;
    }

    if (chart === 'type-changes') {
        const rows = commessaResults
            .filter(c => (c.effectiveType || c.type) !== c.type)
            .map(c => ({
                'Codice':        c.codice,
                'Commessa':      c.nome,
                'Settore':       c.settore,
                'Type Baseline': c.type,
                'Type Scenario': c.effectiveType || c.type,
                'VDP Scenario':  Math.round(c.scenVdpTot),
            }));
        exportChartToExcel('Commesse_Cambio_Type', rows);
        return;
    }

    if (chart === 'settore-type') {
        const settori = [...new Set(commessaResults.map(c => c.settore || '?'))].sort();
        const types   = [...new Set(commessaResults.map(c => c.effectiveType || c.type || 'Altro'))].sort();
        const settoreTypeVdp = {};
        for (const comm of commessaResults) {
            const s = comm.settore || '?';
            const t = comm.effectiveType || comm.type || 'Altro';
            if (!settoreTypeVdp[s]) settoreTypeVdp[s] = {};
            settoreTypeVdp[s][t] = (settoreTypeVdp[s][t] || 0) + comm.scenVdpTot;
        }
        const rows = settori.flatMap(s => types.map(t => ({
            'Settore': s, 'Type': t, 'VDP Scenario': Math.round((settoreTypeVdp[s] || {})[t] || 0),
        })));
        exportChartToExcel('VDP_per_Settore_Type', rows);
        return;
    }

    if (chart === 'settore-pie') {
        const settoreVdp = {};
        for (const comm of commessaResults) {
            const s = comm.settore || '?';
            settoreVdp[s] = (settoreVdp[s] || 0) + comm.scenVdpTot;
        }
        const total = Object.values(settoreVdp).reduce((a, b) => a + b, 0);
        const rows = Object.keys(settoreVdp).sort().map(s => ({
            'Settore':       s,
            'VDP Scenario':  Math.round(settoreVdp[s]),
            '% sul Totale':  total > 0 ? parseFloat((settoreVdp[s] / total * 100).toFixed(2)) : 0,
        }));
        exportChartToExcel('VDP_per_Settore', rows);
        return;
    }

    // ── Scostamenti per Commessa ───────────────────────────────
    if (chart === 'delta-vdp') {
        const rows = commessaResults
            .filter(c => c.deltaVdp !== 0 || c.baseVdpTot !== 0 || c.scenVdpTot !== 0)
            .sort((a, b) => b.deltaVdp - a.deltaVdp)
            .map(c => ({
                'Codice':          c.codice,
                'Commessa':        c.nome,
                'Settore':         c.settore,
                'Type':            c.effectiveType || c.type,
                'VDP Baseline':    Math.round(c.baseVdpTot),
                'VDP Scenario':    Math.round(c.scenVdpTot),
                'Delta VDP':       Math.round(c.deltaVdp),
            }));
        exportChartToExcel('Delta_VDP_per_Commessa', rows);
        return;
    }

    if (chart === 'delta-mar') {
        const rows = commessaResults
            .filter(c => c.deltaMar !== 0 || c.baseMarTot !== 0 || c.scenMarTot !== 0)
            .sort((a, b) => b.deltaMar - a.deltaMar)
            .map(c => ({
                'Codice':              c.codice,
                'Commessa':            c.nome,
                'Settore':             c.settore,
                'Type':                c.effectiveType || c.type,
                'Margine Baseline':    Math.round(c.baseMarTot),
                'Margine Scenario':    Math.round(c.scenMarTot),
                'Delta Margine':       Math.round(c.deltaMar),
            }));
        exportChartToExcel('Delta_Margine_per_Commessa', rows);
        return;
    }
}

// ============================================================
//  AUTO-UPDATER BANNER
// ============================================================
function setupUpdateBanner() {
    if (!window.updaterAPI) return;

    const banner       = $('#update-banner');
    const bannerLabel  = $('#update-banner-label');
    const bannerText   = $('#update-banner-text');
    const progressWrap = $('#update-progress-wrap');
    const progressFill = $('#update-progress-fill');
    const progressPct  = $('#update-progress-pct');
    const actions      = $('#update-actions');

    window.updaterAPI.onStart((version) => {
        bannerLabel.textContent = 'La tua app si sta aggiornando';
        bannerText.textContent  = `Scaricamento v${version}...`;
        progressFill.style.width = '0%';
        progressPct.textContent = '0%';
        progressWrap.classList.remove('hidden');
        actions.classList.add('hidden');
        banner.classList.remove('hidden');
    });

    window.updaterAPI.onProgress((percent) => {
        bannerLabel.textContent = 'La tua app si sta aggiornando';
        bannerText.textContent  = `Scaricamento in corso, potrebbe richiedere qualche minuto...`;
        progressFill.style.width = `${percent}%`;
        progressPct.textContent = `${percent}%`;
        progressWrap.classList.remove('hidden');
        actions.classList.add('hidden');
        banner.classList.remove('hidden');
    });

    window.updaterAPI.onReady(() => {
        bannerLabel.textContent = 'Aggiornamento pronto!';
        bannerText.textContent  = 'Clicca "Installa e riavvia" quando sei pronto (richiede ~2 minuti).';
        progressWrap.classList.add('hidden');
        actions.classList.remove('hidden');
        banner.classList.remove('hidden');
    });

    window.updaterAPI.onError?.((msg) => {
        bannerLabel.textContent = 'Errore aggiornamento';
        bannerText.textContent  = msg || 'Si è verificato un errore. Riavvia l\'app per riprovare.';
        progressWrap.classList.add('hidden');
        actions.classList.add('hidden');
        banner.classList.remove('hidden');
    });

    $('#btn-update-install')?.addEventListener('click', () => {
        openModal('update-confirm-modal');
    });

    $('#btn-update-confirm-ok')?.addEventListener('click', () => {
        closeModal('update-confirm-modal');
        window.updaterAPI.install();
    });

    $('#btn-update-confirm-cancel')?.addEventListener('click', () => {
        closeModal('update-confirm-modal');
    });

    $('#btn-update-later')?.addEventListener('click', () => {
        banner.classList.add('hidden');
    });
}
