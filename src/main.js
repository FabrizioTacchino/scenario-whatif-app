/**
 * main.js — Application bootstrap and controller
 */
import './style.css';
import { checkLicense, activateLicense } from './licenseManager.js';
import { parseExcel, parseImportedScenario, dateToMonth } from './dataLoader.js';
import { computeScenario, computeMultiScenario } from './scenarioEngine.js';
import {
    listScenarios, getScenario, createScenario, duplicateScenario,
    updateScenarioInput, deleteScenario,
    saveBaseline, loadBaseline, clearBaseline,
} from './scenarioManager.js';
import { exportToExcel, exportToCSV, exportToTemplate } from './exportManager.js';
import { Chart, registerables } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';

Chart.register(...registerables);

// ─── State ───
let appData = null;        // { commesse, monthlyData, allMonths, filters }
let activeScenarioId = null;
let comparedScenarioIds = null; // List of scenario IDs being compared
let lastResult = null;     // last computed scenario result
let charts = {};           // Chart.js instances

// ─── DOM refs ───
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Init ───
document.addEventListener('DOMContentLoaded', async () => {
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
        if (!file || !appData) return;

        try {
            const buf = await file.arrayBuffer();
            const { monthlyData: importedData, typeFromFile, inputOverrides } = parseImportedScenario(buf);

            // Create a new scenario of type 'imported'
            const name = file.name.replace(/\.[^/.]+$/, "") || 'Scenario Importato';
            const scen = createScenario(name, 'Importato da Excel', 'imported', importedData);

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

            activeScenarioId = scen.id;
            loadScenarioList();
            $('#active-scenario-select').value = scen.id;

            renderDashboard();
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
}

// ============================================================
//  FILTERS (toggle-chip based)
// ============================================================
function populateFilters() {
    const { filters, allMonths, commesse } = appData;

    // Settore chips
    const settoreContainer = $('#filter-settore');
    settoreContainer.innerHTML = '';
    for (const s of filters.settori) {
        const btn = document.createElement('button');
        btn.className = 'filter-chip';
        btn.dataset.value = s;
        btn.textContent = s;
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            filterSidebarCommesse();
            refreshDashboard();
        });
        settoreContainer.appendChild(btn);
    }

    // Type chips — already in HTML, just attach toggle events
    for (const chip of $$('#filter-type .filter-chip')) {
        chip.addEventListener('click', () => {
            chip.classList.toggle('active');
            filterSidebarCommesse();
            refreshDashboard();
        });
    }

    // Commessa chips - rendered in Sidebar
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
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            refreshDashboard();
        });
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
    // Date inputs still use change event
    for (const sel of ['#filter-date-from', '#filter-date-to']) {
        $(sel)?.addEventListener('change', () => refreshDashboard());
    }

    // Commessa Search
    $('#commessa-search')?.addEventListener('input', () => {
        filterSidebarCommesse();
    });

    $('#btn-reset-filters')?.addEventListener('click', () => {
        // Remove active class from all chips
        $$('.filter-chip.active').forEach(c => c.classList.remove('active'));

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
            if (!lastResult || tab === 'assumptions') return;
            Object.values(charts).forEach(c => c.destroy());
            charts = {};
            if (tab === 'dashboard') renderCharts(lastResult.monthly, lastResult.commessaResults);
            else if (tab === 'details')       renderDetailsCharts(lastResult.monthly, lastResult.commessaResults);
            else if (tab === 'analisi')       renderAnalisiCharts(lastResult.monthly, lastResult.commessaResults);
            else if (tab === 'commessa')      renderCommessaCharts(lastResult.commessaResults);
            else if (tab === 'type-settore')  renderTypoSettoreCharts(lastResult.monthly, lastResult.commessaResults);
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
        opt.textContent = s.name;
        sel.appendChild(opt);
    }

    if (activeScenarioId) {
        sel.value = activeScenarioId;
    }

    sel.addEventListener('change', () => {
        activeScenarioId = sel.value === '__baseline__' ? null : sel.value;
        renderDashboard();
        renderAssumptionsTable();
    });
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
        const scen = createScenario(name, notes);
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
        const dup = duplicateScenario(activeScenarioId);
        if (dup) {
            activeScenarioId = dup.id;
            loadScenarioList();
            $('#active-scenario-select').value = dup.id;
            comparedScenarioIds = null; // Exit comparison mode
            refreshDashboard();
            renderAssumptionsTable();
        }
    });

    $('#btn-delete-scenario')?.addEventListener('click', () => {
        if (!activeScenarioId) return;
        if (!confirm('Eliminare questo scenario?')) return;
        deleteScenario(activeScenarioId);
        activeScenarioId = null;
        loadScenarioList();
        comparedScenarioIds = null; // Exit comparison mode
        refreshDashboard();
        renderAssumptionsTable();
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
    } else {
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

    const filters = getActiveFilters();
    const scen = activeScenarioId ? getScenario(activeScenarioId) : null;
    const inputs = scen ? scen.inputs || {} : {};

    lastResult = computeScenario(appData.commesse, appData.monthlyData, scen || {}, filters);

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
            btn.addEventListener('click', () => {
                btn.classList.toggle('active');
                filterSidebarCommesse();
                refreshDashboard();
            });
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

function renderKPIs(kpis) {
    $('#kpi-val-vdp-base').textContent = formatEuro(kpis.totalBaseVDP);
    $('#kpi-val-vdp-scen').textContent = formatEuro(kpis.totalScenVDP);
    $('#kpi-val-margin-base').textContent = formatEuro(kpis.totalBaseMar);
    $('#kpi-val-margin-scen').textContent = formatEuro(kpis.totalScenMar);

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
    if (activeTab === 'commessa') {
        renderCommessaCharts(commessaResults);
        return;
    }
    if (activeTab === 'details') {
        renderDetailsCharts(monthly, commessaResults);
        return;
    }
    if (activeTab === 'analisi') {
        renderAnalisiCharts(monthly, commessaResults);
        return;
    }
    if (activeTab === 'type-settore') {
        renderTypoSettoreCharts(monthly, commessaResults);
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

}

// ============================================================
//  ANALISI TYPE & SETTORE CHARTS (tab: type-settore)
// ============================================================
function renderTypoSettoreCharts(monthly, commessaResults) {
    if (!commessaResults || !commessaResults.length) return;

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

    const yearlyXScale = {
        ...commonOpts.scales.x,
        offset: true,
        ticks: { ...commonOpts.scales.x.ticks, maxRotation: 0 },
    };
    const barLabelOpts = {
        anchor: 'end',
        align: 'top',
        formatter: (v) => v > 0 ? formatCompact(v) : '',
        font: { family: 'Inter', size: 10, weight: '600' },
        color: '#3a3f4a',
        clip: false,
    };
    const slimBar = { barPercentage: 0.5, categoryPercentage: 0.75, clip: false };

    const typeColors = {
        'Backlog':      { bg: chartColors.actual.bg,    border: chartColors.actual.border    },
        'Order Intake': { bg: chartColors.remaining.bg, border: chartColors.remaining.border },
    };
    const fallbackTypeColors = [
        { bg: 'rgba(251,191,36,0.75)', border: '#fbbf24' },
        { bg: 'rgba(248,113,113,0.75)', border: '#f87171' },
    ];

    // --- Chart 1: VDP per Tipo — Baseline vs Scenario (grouped bar) ---
    const allTypes = [...new Set(['Backlog', 'Order Intake', ...commessaResults.map(c => c.effectiveType || c.type)])];
    const baseByType = {};
    const scenByType = {};
    for (const comm of commessaResults) {
        const baseT = comm.type || 'Altro';
        const scenT = comm.effectiveType || comm.type || 'Altro';
        baseByType[baseT] = (baseByType[baseT] || 0) + comm.baseVdpTot;
        scenByType[scenT] = (scenByType[scenT] || 0) + comm.scenVdpTot;
    }
    let fallbackIdx = 0;
    const typeComparisonCanvas = $('#chart-type-comparison');
    if (typeComparisonCanvas) {
        charts.typeComparison = new Chart(typeComparisonCanvas, {
            type: 'bar',
            plugins: [ChartDataLabels],
            data: {
                labels: allTypes,
                datasets: [
                    {
                        label: 'Baseline',
                        data: allTypes.map(t => Math.round(baseByType[t] || 0)),
                        backgroundColor: chartColors.baseline.bg,
                        borderColor: chartColors.baseline.border,
                        borderWidth: 1,
                        ...slimBar,
                    },
                    {
                        label: 'Scenario',
                        data: allTypes.map(t => Math.round(scenByType[t] || 0)),
                        backgroundColor: chartColors.scenario.bg,
                        borderColor: chartColors.scenario.border,
                        borderWidth: 1,
                        ...slimBar,
                    },
                ],
            },
            options: {
                ...commonOpts,
                layout: { padding: { top: 24, left: 8, right: 8 } },
                scales: { ...commonOpts.scales, x: yearlyXScale },
                plugins: { ...commonOpts.plugins, datalabels: barLabelOpts },
            },
        });
    }

    // --- Chart 2: Commesse con cambio Type (horizontal bar) ---
    const truncate = (s, n) => s && s.length > n ? s.substring(0, n) + '…' : (s || '');
    const typeChanges = commessaResults.filter(c => (c.effectiveType || c.type) !== c.type);
    const wrapTypeChanges = document.getElementById('wrap-type-changes');

    // Ensure canvas is always present (never destroy it via innerHTML)
    if (wrapTypeChanges && !wrapTypeChanges.querySelector('#chart-type-changes')) {
        const cv = document.createElement('canvas');
        cv.id = 'chart-type-changes';
        wrapTypeChanges.innerHTML = '';
        wrapTypeChanges.appendChild(cv);
    }
    // Remove any previous no-data messages
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
            return (typeColors[et] || fallbackTypeColors[0]).bg;
        });
        const tcDirLabels = typeChanges.map(c => {
            const et = c.effectiveType || c.type;
            return et === 'Order Intake' ? '↑ OI' : '↓ BL';
        });
        fallbackIdx = 0;
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

    // --- Chart 3: VDP Scenario per Settore × Tipo (stacked bar) ---
    const settoriSet = new Set(commessaResults.map(c => c.settore || '?'));
    const settoriList = [...settoriSet].sort();
    const typeSetForChart = new Set(commessaResults.map(c => c.effectiveType || c.type || 'Altro'));
    const allTypesForChart = [...typeSetForChart].sort();
    const settoreTypeVdp = {}; // { settore: { type: vdp } }
    for (const comm of commessaResults) {
        const s = comm.settore || '?';
        const t = comm.effectiveType || comm.type || 'Altro';
        if (!settoreTypeVdp[s]) settoreTypeVdp[s] = {};
        settoreTypeVdp[s][t] = (settoreTypeVdp[s][t] || 0) + comm.scenVdpTot;
    }
    fallbackIdx = 0;
    const settoreTypeDatasets = allTypesForChart.map(type => {
        const col = typeColors[type] || fallbackTypeColors[fallbackIdx++ % fallbackTypeColors.length];
        return {
            label: type,
            data: settoriList.map(s => Math.round((settoreTypeVdp[s] || {})[type] || 0)),
            backgroundColor: col.bg,
            borderColor: col.border,
            borderWidth: 1,
            stack: 'scen',
            barPercentage: 0.5,
            categoryPercentage: 0.7,
            clip: false,
        };
    });
    const settoreTypeCanvas = $('#chart-settore-type');
    if (settoreTypeCanvas) {
        const stTotal = settoriList.flatMap(s => allTypesForChart.map(t => (settoreTypeVdp[s] || {})[t] || 0)).reduce((a, b) => a + b, 0);
        const stThreshold = stTotal / Math.max(settoriList.length * allTypesForChart.length, 1) * 0.15;
        charts.settoreType = new Chart(settoreTypeCanvas, {
            type: 'bar',
            plugins: [ChartDataLabels],
            data: { labels: settoriList, datasets: settoreTypeDatasets },
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
                        formatter: (v) => v > stThreshold ? formatCompact(v) : '',
                        font: { family: 'Inter', size: 10, weight: '700' },
                        color: '#3a3f4a',
                    },
                },
            },
        });
    }

    // --- Chart 4: VDP Scenario per Settore (doughnut) ---
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
                        formatter: (value, ctx) => {
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
//  ANALISI COMMESSA CHARTS
// ============================================================
function renderCommessaCharts(commessaResults) {
    if (!commessaResults || !commessaResults.length) return;

    const truncate = (s, n) => s && s.length > n ? s.substring(0, n) + '…' : (s || '');
    const commLabel = (c) => truncate(`${c.codice} · ${c.nome}`, 35);

    const posColor  = { bg: 'rgba(52,211,153,0.75)',  border: '#34d399' };
    const negColor  = { bg: 'rgba(248,113,113,0.75)', border: '#f87171' };
    const zeroColor = { bg: 'rgba(120,130,150,0.4)',  border: '#78828a' };

    function barColor(val, key) {
        if (val > 0) return key === 'bg' ? posColor.bg : posColor.border;
        if (val < 0) return key === 'bg' ? negColor.bg : negColor.border;
        return key === 'bg' ? zeroColor.bg : zeroColor.border;
    }

    const hBarOpts = (nItems) => ({
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        clip: false,
        layout: { padding: { top: 4, bottom: 4, right: 70 } },
        plugins: {
            legend: { display: false },
            tooltip: {
                backgroundColor: '#1a2340',
                borderColor: 'rgba(255,255,255,0.1)',
                borderWidth: 1,
                callbacks: {
                    label: (ctx) => {
                        const c = commessaResults.find(x => commLabel(x) === ctx.label);
                        if (!ctx.dataset._key) return formatEuro(ctx.parsed.x);
                        const key = ctx.dataset._key;
                        const base = key === 'vdp' ? c?.baseVdpTot : c?.baseMarTot;
                        const scen = key === 'vdp' ? c?.scenVdpTot : c?.scenMarTot;
                        return [
                            ` Delta: ${formatEuro(ctx.parsed.x)}`,
                            ` Baseline: ${formatEuro(base)}`,
                            ` Scenario: ${formatEuro(scen)}`,
                        ];
                    },
                },
            },
            datalabels: {
                anchor: 'end',
                align: (ctx) => ctx.dataset.data[ctx.dataIndex] >= 0 ? 'right' : 'left',
                formatter: (v) => v !== 0 ? formatCompact(v) : '',
                font: { family: 'Inter', size: 10, weight: '600' },
                color: '#3a3f4a',
                clip: false,
            },
        },
        scales: {
            x: {
                ticks: { color: '#5a6478', font: { size: 10 }, callback: (v) => formatCompact(v) },
                grid: { color: 'rgba(255,255,255,0.04)' },
            },
            y: {
                ticks: { color: '#8892a8', font: { family: 'Inter', size: 10 } },
                grid: { color: 'rgba(255,255,255,0.04)' },
            },
        },
    });

    // Altezza dinamica: 28px per voce + 80px di margine
    function setWrapHeight(wrapId, n) {
        const el = document.getElementById(wrapId);
        if (el) el.style.height = Math.max(320, n * 28 + 80) + 'px';
    }

    // ── Chart 1: Delta VDP ──────────────────────────────────────
    const byVdp = [...commessaResults].sort((a, b) => b.deltaVdp - a.deltaVdp);
    setWrapHeight('wrap-delta-vdp', byVdp.length);

    charts.deltaVdp = new Chart($('#chart-delta-vdp'), {
        type: 'bar',
        plugins: [ChartDataLabels],
        data: {
            labels: byVdp.map(commLabel),
            datasets: [{
                label: 'Δ VDP',
                _key: 'vdp',
                data: byVdp.map(c => Math.round(c.deltaVdp)),
                backgroundColor: byVdp.map(c => barColor(c.deltaVdp, 'bg')),
                borderColor:     byVdp.map(c => barColor(c.deltaVdp, 'border')),
                borderWidth: 1,
                barPercentage: 0.65,
                categoryPercentage: 0.85,
            }],
        },
        options: hBarOpts(byVdp.length),
    });

    // ── Chart 2: Delta Margine ──────────────────────────────────
    const byMar = [...commessaResults].sort((a, b) => b.deltaMar - a.deltaMar);
    setWrapHeight('wrap-delta-mar', byMar.length);

    charts.deltaMar = new Chart($('#chart-delta-mar'), {
        type: 'bar',
        plugins: [ChartDataLabels],
        data: {
            labels: byMar.map(commLabel),
            datasets: [{
                label: 'Δ Margine',
                _key: 'mar',
                data: byMar.map(c => Math.round(c.deltaMar)),
                backgroundColor: byMar.map(c => barColor(c.deltaMar, 'bg')),
                borderColor:     byMar.map(c => barColor(c.deltaMar, 'border')),
                borderWidth: 1,
                barPercentage: 0.65,
                categoryPercentage: 0.85,
            }],
        },
        options: hBarOpts(byMar.length),
    });
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

    for (const comm of appData.commesse) {
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

    // Update KPIs with first scenario
    if (results.length) {
        renderKPIs(results[0].result.kpis);
    }
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

    $('#btn-print')?.addEventListener('click', () => {
        // Switch to dashboard for printing
        $$('.tab-btn').forEach(b => b.classList.remove('active'));
        $$('.tab-panel').forEach(p => p.classList.remove('active'));
        $$('.tab-btn')[0].classList.add('active');
        $('#tab-dashboard').classList.add('active');
        setTimeout(() => window.print(), 300);
    });
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
//  AUTO-UPDATER BANNER
// ============================================================
function setupUpdateBanner() {
    if (!window.updaterAPI) return;

    const banner      = $('#update-banner');
    const bannerText  = $('#update-banner-text');
    const progressWrap = $('#update-progress-wrap');
    const progressFill = $('#update-progress-fill');
    const progressPct  = $('#update-progress-pct');
    const actions     = $('#update-actions');

    window.updaterAPI.onStart((version) => {
        bannerText.textContent = `Scaricamento aggiornamento v${version}...`;
        progressFill.style.width = '0%';
        progressPct.textContent = '0%';
        progressWrap.classList.remove('hidden');
        actions.classList.add('hidden');
        banner.classList.remove('hidden');
    });

    window.updaterAPI.onProgress((percent) => {
        bannerText.textContent = 'Scaricamento aggiornamento in corso...';
        progressFill.style.width = `${percent}%`;
        progressPct.textContent = `${percent}%`;
        progressWrap.classList.remove('hidden');
        actions.classList.add('hidden');
        banner.classList.remove('hidden');
    });

    window.updaterAPI.onReady(() => {
        bannerText.textContent = 'Aggiornamento pronto! Riavvia l\'app per installarlo.';
        progressWrap.classList.add('hidden');
        actions.classList.remove('hidden');
        banner.classList.remove('hidden');
    });

    $('#btn-update-install')?.addEventListener('click', () => {
        window.updaterAPI.install();
    });

    $('#btn-update-later')?.addEventListener('click', () => {
        banner.classList.add('hidden');
    });
}
