/**
 * costUI.js — entry point UI del modulo costi.
 *
 * Si auto-attiva al DOMContentLoaded. Se WHATIF_COSTI_ENABLED è false,
 * fa nulla: l'app deve comportarsi identicamente alla versione pre-modulo.
 *
 * P8 v2: vista multi-commessa con card collassabili, integrata con i filtri
 * globali esistenti dell'app (settore, tipo, commessa). Il pannello costi
 * mostra una card per ciascuna commessa nel pool dei filtri (default
 * collassata) + una card aggregato finale sempre espansa con i totali.
 *
 * Lettura stato app:
 *   - Commesse e monthlyData → loadBaseline() da scenarioManager
 *   - Scenario attivo → letto dal DOM (#active-scenario-select.value)
 *   - Tutti gli scenari → listScenarios() da scenarioManager
 *   - Filtri attivi → letti dal DOM (#filter-settore, #filter-type, #filter-commessa)
 */

import * as XLSX from 'xlsx';
import { Chart, registerables } from 'chart.js';
import { WHATIF_COSTI_ENABLED } from './costFeatureFlag.js';
import './costAdminUI.js'; // side-effect: registra auto-init del pannello admin categorie
import {
    getCostCategories,
    getActiveCategories,
} from './costCategoriesStore.js';
import { COST_PROFILES, getProfileById } from './costProfili.js';
import { shiftMonth, monthsBetween } from './curveEngine.js';
import {
    computeCategoriaMensile,
    getCostsForCommessa,
} from './costEngine.js';
import { parseBIExport } from './biParser.js';
import { computeScenario } from '../scenarioEngine.js';
import {
    loadBaseline,
    listScenarios,
    getScenario,
    updateScenario,
    setCostiSnapshotProvider,
} from '../scenarioManager.js';
import { getCurrentRole } from '../syncManager.js';

// Chart.register è idempotente — main.js lo chiama già, lo richiamiamo qui per
// sicurezza nel caso costUI.js venga caricato prima/separatamente.
Chart.register(...registerables);

// ── Selettori DOM ──
const VDP_SUB_BLOCKS = [
    '#cost-subpanel-vdp-toolbar',
    '#tab-assumptions .global-sliders',
    '#cost-subpanel-vdp-table',
];
const COSTI_SUB_BLOCK = '#cost-subpanel-costi';

// ── Storage UI state (espansi/collassati) ──
const EXPANDED_KEY = 'whatif_cost_panel_expanded';
const HIDE_EMPTY_KEY = 'whatif_cost_hide_empty';

let _initialized = false;
let _currentSubpanel = 'vdp';
let _renderScheduled = false;

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function setHidden(el, hidden) {
    if (!el) return;
    el.classList.toggle('hidden', !!hidden);
}

function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

// useGrouping: 'always' forza il separatore migliaia anche per numeri tra 1.000 e 9.999
// (default 'min2' di it-IT lo applica solo da 10.000 in su)
const fmtNum = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: 'always' });
function formatCurrency(n) {
    if (!Number.isFinite(n)) return '0';
    return fmtNum.format(Math.round(n));
}

// ─────────────────────────────────────────────────────
// Storage state collapse/expand
// ─────────────────────────────────────────────────────

function loadExpanded() {
    try {
        const raw = localStorage.getItem(EXPANDED_KEY);
        if (!raw) return new Set();
        const arr = JSON.parse(raw);
        return new Set(Array.isArray(arr) ? arr : []);
    } catch {
        return new Set();
    }
}

function saveExpanded(set) {
    try {
        localStorage.setItem(EXPANDED_KEY, JSON.stringify(Array.from(set)));
    } catch { /* localStorage può fallire (quota), ignoro */ }
}

function isExpanded(commessaKey) {
    return loadExpanded().has(commessaKey);
}

function setExpandedState(commessaKey, expanded) {
    const set = loadExpanded();
    if (expanded) set.add(commessaKey);
    else set.delete(commessaKey);
    saveExpanded(set);
}

function loadHideEmpty() {
    try { return localStorage.getItem(HIDE_EMPTY_KEY) === '1'; } catch { return false; }
}
function saveHideEmpty(value) {
    try { localStorage.setItem(HIDE_EMPTY_KEY, value ? '1' : '0'); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// Sub-nav VDP / Costi
// ─────────────────────────────────────────────────────

function showSubpanel(which) {
    const showVdp = which === 'vdp';
    for (const sel of VDP_SUB_BLOCKS) {
        for (const el of $$(sel)) setHidden(el, !showVdp);
    }
    setHidden($(COSTI_SUB_BLOCK), showVdp);
    for (const btn of $$('#cost-sub-nav .cost-sub-tab-btn')) {
        btn.classList.toggle('active', btn.dataset.costSubtab === which);
    }
    _currentSubpanel = which;
    updateLockBanner();
    updateNoScenarioBanner();
    if (which === 'costi') scheduleRender();
}

/**
 * Aggiorna il banner globale "Scenario bloccato" nel tab Assumptions.
 * Visibile su entrambi i sub-tab (VDP e Costi) quando lo scenario corrente è locked.
 */
function updateLockBanner() {
    const banner = $('#cost-locked-banner-wrapper');
    if (!banner) return;
    const scenarioId = getActiveScenarioIdFromDOM();
    const scen = scenarioId ? getScenario(scenarioId) : null;
    setHidden(banner, !scen?.locked);
}

/**
 * Aggiorna il banner globale "Seleziona uno scenario..." nel tab Assumptions.
 * Quando attivo, nasconde entrambi i sub-pannelli VDP e Costi (UX coerente
 * su entrambi). Quando disattivo, ripristina la visibilità del sub-pannello
 * attivo via showSubpanel.
 */
function updateNoScenarioBanner() {
    const banner = $('#cost-noscen-banner');
    if (!banner) return;
    const scenarioId = getActiveScenarioIdFromDOM();
    const noScenario = !scenarioId;
    setHidden(banner, !noScenario);

    if (noScenario) {
        // Nascondi tutti i sub-pannelli (VDP + Costi)
        for (const sel of VDP_SUB_BLOCKS) {
            for (const el of $$(sel)) setHidden(el, true);
        }
        setHidden($(COSTI_SUB_BLOCK), true);
    } else {
        // Ripristina visibilità del sub-panel attivo (solo se inizializzato)
        if (_initialized) {
            const showVdp = _currentSubpanel === 'vdp';
            for (const sel of VDP_SUB_BLOCKS) {
                for (const el of $$(sel)) setHidden(el, !showVdp);
            }
            setHidden($(COSTI_SUB_BLOCK), showVdp);
        }
    }
}

function attachSubNavHandlers() {
    const nav = $('#cost-sub-nav');
    if (!nav) return;
    nav.addEventListener('click', (e) => {
        const btn = e.target.closest('.cost-sub-tab-btn');
        if (!btn) return;
        const which = btn.dataset.costSubtab;
        if (which !== 'vdp' && which !== 'costi') return;
        showSubpanel(which);
    });
}

// ─────────────────────────────────────────────────────
// Lettura stato app + filtri
// ─────────────────────────────────────────────────────

export function getActiveScenarioIdFromDOM() {
    const sel = $('#active-scenario-select');
    if (!sel) return null;
    const v = sel.value;
    // '__baseline__' è il placeholder dell'app per "nessuno scenario specifico"
    // (= modalità baseline ricavi pura, senza modifiche). Per il modulo costi
    // equivale a "nessuno scenario attivo".
    if (!v || v === '__baseline__') return null;
    return v;
}

export function getBaselineSafe() {
    try { return loadBaseline(); } catch { return null; }
}

/**
 * Ritorna true se l'utente corrente ha ruolo 'viewer' (sola lettura).
 * Nel modulo costi: viewer non può editare parametri, importare BI, fare reset.
 * Lettura grafici e tabelle resta consentita.
 */
function isViewerReadOnly() {
    try {
        return getCurrentRole() === 'viewer';
    } catch {
        return false;
    }
}

function getActiveChipValues(containerSel) {
    const container = $(containerSel);
    if (!container) return [];
    return $$('.filter-chip.active', container)
        .map(c => c.dataset.value)
        .filter(Boolean);
}

/**
 * Pool commesse "viste" dallo scenario corrente (ogni scenario vive di luce propria):
 *   - Scenario imported → chiavi di importedData (commesse del file scenario).
 *     Metadata da baseline.commesse se presente, altrimenti da scenario.newCommesse.
 *   - Scenario calculated → baseline.commesse + scenario.newCommesse (eventuali aggiunte).
 *
 * Restituisce array di oggetti commessa (key, codice, nome, type, settore,
 * probabilitaAOP, margineAOP, vdpTotale, ...). Da questo pool si applicano poi
 * i filtri globali (settore, tipo, commessa).
 */
export function getCommesseForScenario(scenario, baseline) {
    const baseCommesse = baseline?.commesse || [];
    const newCommesse = scenario?.newCommesse || [];
    const baseByKey = new Map(baseCommesse.map(c => [c.key, c]));
    const newByKey = new Map(newCommesse.map(c => [c.key, c]));

    if (scenario?.type === 'imported' && scenario.importedData) {
        const out = [];
        for (const key of Object.keys(scenario.importedData)) {
            const c = baseByKey.get(key) || newByKey.get(key);
            if (c) {
                out.push(c);
            } else {
                // Fallback estremo: deriva metadata minimi dalla key
                const [codice, nome] = key.split('|||');
                out.push({
                    key,
                    codice: codice || '',
                    nome: nome || '',
                    settore: '',
                    type: 'Order Intake',
                    probabilitaAOP: 0,
                    margineAOP: 0,
                    vdpTotale: 0,
                });
            }
        }
        return out;
    }

    // Calculated o senza importedData: unione baseline + newCommesse
    const seen = new Set();
    const out = [];
    for (const c of baseCommesse) { if (!seen.has(c.key)) { seen.add(c.key); out.push(c); } }
    for (const c of newCommesse)  { if (!seen.has(c.key)) { seen.add(c.key); out.push(c); } }
    return out;
}

/**
 * Mesi "sorgente" PRE-shift per il cold-start dei costi di una commessa,
 * normalizzati a {month, vdpAOP} per essere compatibili con deriveCommessaDates.
 * Le modifiche dell'inputs scenario (shift, ritardo, probabilità) si applicano
 * dinamicamente a valle, in computeCategoriaMensile.
 *   - Scenario imported con importedData[key] → mesi del file scenario
 *   - Altrimenti → mesi della baseline ricavi
 */
export function getDataSourceMonths(scenario, commessaKey, baseline) {
    if (scenario?.type === 'imported' && scenario.importedData?.[commessaKey]) {
        return scenario.importedData[commessaKey]
            .map(m => ({
                month: m.month,
                vdpAOP: (Number(m.actual) || 0) + (Number(m.remaining) || 0),
            }))
            .filter(m => m.vdpAOP > 0);
    }
    const bm = baseline?.monthlyData?.get?.(commessaKey) || [];
    return bm.map(m => ({ month: m.month, vdpAOP: Number(m.vdpAOP) || 0 }));
}

/**
 * Legge i filtri data globali (#filter-date-from / #filter-date-to).
 * Restituisce {from, to} con stringhe "YYYY-MM" (null se input vuoto).
 * Restituisce null se entrambi sono vuoti = nessun filtro applicato.
 */
export function getDateRangeFilter() {
    const fromEl = $('#filter-date-from');
    const toEl = $('#filter-date-to');
    const from = fromEl?.value?.trim() || '';
    const to = toEl?.value?.trim() || '';
    if (!from && !to) return null;
    return { from: from || null, to: to || null };
}

/** Verifica se un mese ("YYYY-MM") rientra nel range. */
export function inDateRange(month, range) {
    if (!range) return true;
    if (range.from && month < range.from) return false;
    if (range.to && month > range.to) return false;
    return true;
}

/** Shift corrente da inputs scenario per la commessa. 0 se assente o non numerico. */
function getCommessaShift(scenario, commessaKey) {
    const v = scenario?.inputs?.[commessaKey]?.shiftStart;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Legge i filtri globali (settori, tipi, commesse) e ritorna le commesse
 * filtrate. Coerente con la semantica di scenarioEngine.computeScenario:
 *   - Array vuoto in qualsiasi filtro = "no filtro applicato" su quella dimensione
 */
export function getFilteredCommesse(allCommesse) {
    const settori = getActiveChipValues('#filter-settore');
    const tipi = getActiveChipValues('#filter-type');
    const commesseKeys = getActiveChipValues('#filter-commessa');

    return allCommesse.filter(c => {
        if (settori.length && !settori.includes(c.settore)) return false;
        if (tipi.length && !tipi.includes(c.type)) return false;
        if (commesseKeys.length && !commesseKeys.includes(c.key)) return false;
        return true;
    });
}

// ─────────────────────────────────────────────────────
// Render — scheduling
// ─────────────────────────────────────────────────────

function scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
        _renderScheduled = false;
        renderCostiPanel();
    });
}

// ─────────────────────────────────────────────────────
// Helper — scala probabilità (replica logica scenarioEngine per il display)
// ─────────────────────────────────────────────────────

/**
 * Calcola la scala probabilità da applicare ai costi di una commessa OI.
 * Replica la stessa logica di costEngine.computeCategoriaMensile (e di
 * scenarioEngine.computeOrderIntake) per il breakdown AC/Futuro nel display.
 * Per Backlog → 1.
 */
function computeProbScale(scenario, commessa) {
    if (!commessa || commessa.type !== 'Order Intake') return 1;
    const inputs = scenario?.inputs?.[commessa.key] || {};
    const probAOP = commessa.probabilitaAOP != null ? commessa.probabilitaAOP : 1;
    let probNuova = probAOP;
    if (inputs.probabilita != null && inputs.probabilita !== '') {
        probNuova = Number(inputs.probabilita) / 100;
    }
    const probFile = inputs.probabilitaFile != null
        ? Number(inputs.probabilitaFile) / 100
        : (probAOP > 0 ? probAOP : 1);
    return probFile > 0 ? probNuova / probFile : probNuova;
}

// ─────────────────────────────────────────────────────
// Render — pannello principale
// ─────────────────────────────────────────────────────

const ORIGINE_LABEL = {
    scenario_corrente: 'da scenario',
    copiato_da_scenario: 'copiato',
    cold_start_margine: 'cold-start',
    bi_import: 'da BI',
    vuoto: 'vuoto',
};

const TYPE_LABEL = {
    'Order Intake': { short: 'OI', cls: 'badge-type-oi' },
    'Backlog': { short: 'BL', cls: 'badge-type-bl' },
};

function renderCostiPanel() {
    const container = $('#cost-commesse-container');
    const aggregato = $('#cost-aggregato-container');
    const empty = $('#cost-empty-state');
    const info = $('#cost-commessa-info');
    if (!container || !aggregato || !empty) return;

    // Cleanup grafici precedenti (i nuovi verranno creati al re-render delle card)
    destroyAllCharts();

    const scenarioId = getActiveScenarioIdFromDOM();
    setHidden($('#cost-no-scenario-warning'), !!scenarioId);

    if (!scenarioId) {
        // Banner globale "Seleziona uno scenario..." gestito da updateNoScenarioBanner.
        // Il sub-pannello Costi è già nascosto, quindi qui torno semplicemente.
        if (info) info.textContent = '';
        return;
    }

    const baseline = getBaselineSafe();
    if (!baseline) {
        empty.innerHTML = '<p>Nessuna baseline ricavi caricata. Importa il file Excel di baseline prima di gestire i costi.</p>';
        setHidden(empty, false);
        setHidden(container, true);
        setHidden(aggregato, true);
        if (info) info.textContent = '';
        return;
    }

    const scenario = getScenario(scenarioId);
    if (!scenario) {
        empty.innerHTML = '<p>Scenario non trovato.</p>';
        setHidden(empty, false);
        setHidden(container, true);
        setHidden(aggregato, true);
        if (info) info.textContent = '';
        return;
    }

    // Pool commesse "viste" dallo scenario (autonomia per-scenario)
    const allCommesse = getCommesseForScenario(scenario, baseline);
    const pool = getFilteredCommesse(allCommesse);
    const totalCommesse = allCommesse.length;
    const isFiltered = pool.length < totalCommesse;

    if (info) {
        info.textContent = isFiltered
            ? `${pool.length} commesse visualizzate su ${totalCommesse} (filtri attivi)`
            : `${pool.length} commesse visualizzate (nessun filtro)`;
    }

    if (pool.length === 0) {
        empty.innerHTML = '<p>Nessuna commessa nel pool dei filtri. Modifica i filtri laterali per ampliare la selezione.</p>';
        setHidden(empty, false);
        setHidden(container, true);
        setHidden(aggregato, true);
        return;
    }

    setHidden(empty, true);
    setHidden(container, false);
    setHidden(aggregato, false);

    // Banner lock (anche viewer è "lock effettivo" per disabilitare editing)
    const viewerRO = isViewerReadOnly();
    const isLocked = !!scenario.locked || viewerRO;
    // Banner globale del lock è gestito separatamente da updateLockBanner()
    // (visibile su entrambi i sub-tab Assunzioni VDP / Costi)

    const allScenarios = listScenarios();

    // Filtro data globale (Opzione B): se attivo, totali e grafico si limitano al range.
    // I parametri editabili (Data Inizio/Durata/Fine) restano invariati perché sono
    // intrinseci della categoria, non dipendono dal filtro display.
    const dateRange = getDateRangeFilter();

    // Pre-calcolo per ogni commessa: fallback chain + mensilizzati per ogni categoria
    // Useremo questi dati sia per le card singole che per l'aggregato finale.
    const perCommessa = pool.map(commessa => {
        // Mesi sorgente PRE-shift dello scenario (importedData se imported, baseline altrimenti)
        const sourceMonths = getDataSourceMonths(scenario, commessa.key, baseline);
        const fallback = getCostsForCommessa({
            scenario,
            commessaKey: commessa.key,
            commessa,
            baselineMonths: sourceMonths,
            allScenarios,
        });
        const virtualScenario = {
            ...scenario,
            costi: {
                ...(scenario.costi || {}),
                [commessa.key]: { categorie: fallback.categorie || {} },
            },
        };

        // Shift inputs corrente (per derivare cutoff AC post-shift)
        const shiftIn = getCommessaShift(scenario, commessa.key);

        // Per ogni categoria: mensilizzati + AC raw + futuro raw
        const perCategoria = {};
        let totAc = 0;
        let totFuturo = 0;
        let totGrand = 0;

        for (const catDef of getCostCategories()) {
            const cat = (fallback.categorie || {})[catDef.id];
            if (!cat) {
                perCategoria[catDef.id] = null;
                continue;
            }
            const mensiliFull = computeCategoriaMensile(virtualScenario, commessa.key, catDef.id, commessa);
            // Filtro data globale: se attivo, mostra solo i mesi nel range
            const mensili = dateRange
                ? mensiliFull.filter(m => inDateRange(m.mese, dateRange))
                : mensiliFull;
            const totMensili = mensili.reduce((s, m) => s + (m.valore || 0), 0);

            // Breakdown AC / Futuro nel range: cutoff AC post-shift della categoria.
            // I mesi <= cutoff sono "AC", > cutoff sono "futuro". Coerente con la pipeline:
            // in assenza di filtro, acPart e futuroPart equivalgono ai raw × probScale.
            // Cutoff AC = ultimo mese in cui esiste un valore AC storico (anche negativo:
            // sono storni/correzioni reali del BI, vanno classificati come AC, non futuro).
            let acCutoffRaw = '';
            for (const [m, v] of Object.entries(cat.acStorico || {})) {
                if (Number(v) !== 0 && m > acCutoffRaw) acCutoffRaw = m;
            }
            const acCutoff = acCutoffRaw ? shiftMonth(acCutoffRaw, shiftIn) : null;

            let acPart, futuroPart;
            if (!acCutoff) {
                // Niente AC storico → tutto è "futuro"
                acPart = 0;
                futuroPart = totMensili;
            } else {
                acPart = mensili
                    .filter(m => m.mese <= acCutoff)
                    .reduce((s, m) => s + (m.valore || 0), 0);
                futuroPart = totMensili - acPart;
            }

            perCategoria[catDef.id] = {
                cat,
                mensili,
                totMensili,
                acPart,
                futuroPart,
            };

            totAc += acPart;
            totFuturo += futuroPart;
            totGrand += totMensili;
        }

        return {
            commessa,
            fallback,
            perCategoria,
            totAc,
            totFuturo,
            totGrand,
        };
    });

    // ── Filtro "nascondi commesse vuote" (toggle in toolbar) ──
    const hideEmpty = loadHideEmpty();
    const perCommessaVisible = hideEmpty
        ? perCommessa.filter(d => (d.totAc || 0) !== 0 || (d.totFuturo || 0) !== 0)
        : perCommessa;
    const hiddenCount = perCommessa.length - perCommessaVisible.length;

    // Aggiorna stato toggle e contatore in toolbar
    const chk = $('#cost-chk-hide-empty');
    if (chk) chk.checked = hideEmpty;
    const counterEl = $('#cost-hide-empty-count');
    if (counterEl) {
        counterEl.textContent = hideEmpty && hiddenCount > 0
            ? `(${hiddenCount} nascost${hiddenCount === 1 ? 'a' : 'e'})`
            : '';
    }

    // ── Render card per ogni commessa ──
    container.innerHTML = '';
    for (const data of perCommessaVisible) {
        container.appendChild(renderCommessaCard(data, isLocked, scenario));
    }

    // ── Render card aggregato (sulle commesse visibili) ──
    renderAggregatoCard(aggregato, perCommessaVisible);
}

// ─────────────────────────────────────────────────────
// Grafici Chart.js (P10)
// ─────────────────────────────────────────────────────

/** Map commessaKey → Chart instance (per cleanup ordinato). */
const chartsByCommessa = new Map();

/** Distrugge il chart di una commessa specifica (o no-op se non esiste). */
function destroyChart(commessaKey) {
    const c = chartsByCommessa.get(commessaKey);
    if (c) {
        c.destroy();
        chartsByCommessa.delete(commessaKey);
    }
}

/** Distrugge tutti i chart attivi. Chiamato ad ogni re-render del pannello. */
function destroyAllCharts() {
    for (const c of chartsByCommessa.values()) {
        try { c.destroy(); } catch (e) { /* ignore */ }
    }
    chartsByCommessa.clear();
}

/** Palette colori per le 14 categorie (HSL distribuita). */
function getCategoryColor(idx, alpha = 1) {
    const h = (idx * (360 / 14)) % 360;
    return `hsla(${h}, 60%, 55%, ${alpha})`;
}

/** Calcola il mese di cutoff AC: ultimo mese con AC > 0 su tutte le categorie. */
function computeCutoffMese(perCategoria) {
    let cutoff = '';
    for (const cd of Object.values(perCategoria)) {
        if (!cd || !cd.cat) continue;
        for (const [m, v] of Object.entries(cd.cat.acStorico || {})) {
            if (Number(v) > 0 && m > cutoff) cutoff = m;
        }
    }
    return cutoff || null;
}

/**
 * Renderizza il grafico mensilizzato di una commessa nel canvas della card.
 * Modalità:
 *   - 'includi_ac' : stacked area, mesi AC + futuro, una serie per categoria
 *   - 'solo_futuro': stacked area, mesi > cutoff AC, una serie per categoria
 *   - 'totale'     : single line con somma di tutte le categorie per ogni mese
 */
function renderCommessaChart(card, commessaKey, perCategoria, mode = 'includi_ac') {
    destroyChart(commessaKey);
    const canvas = card?.querySelector('.cost-chart-canvas');
    if (!canvas) return;

    // Mesi unici sull'unione di tutte le categorie
    const monthSet = new Set();
    for (const cd of Object.values(perCategoria)) {
        if (!cd) continue;
        for (const m of cd.mensili) monthSet.add(m.mese);
    }
    let months = Array.from(monthSet).sort();

    // Filtro 'solo_futuro': escludi mesi <= cutoff AC
    if (mode === 'solo_futuro') {
        const cutoff = computeCutoffMese(perCategoria);
        if (cutoff) months = months.filter(m => m > cutoff);
    }
    if (months.length === 0) {
        // Niente da mostrare → distruggi e basta
        return;
    }

    // Build datasets (uno per categoria con almeno un valore non-zero)
    const datasets = [];
    let colorIdx = 0;
    for (const catDef of getCostCategories()) {
        const cd = perCategoria[catDef.id];
        if (!cd) continue;
        const valByMese = {};
        for (const m of cd.mensili) valByMese[m.mese] = m.valore;
        const data = months.map(m => Math.round(valByMese[m] || 0));
        if (data.every(v => v === 0)) continue;
        datasets.push({
            label: catDef.label,
            data,
            backgroundColor: getCategoryColor(colorIdx, 0.55),
            borderColor: getCategoryColor(colorIdx, 1),
            borderWidth: 1,
            fill: 'origin',
            tension: 0.2,
            pointRadius: 0,
            stack: 'cat',
        });
        colorIdx++;
    }

    let config;
    if (mode === 'totale') {
        const totals = months.map((_, i) => datasets.reduce((s, d) => s + (d.data[i] || 0), 0));
        config = {
            type: 'line',
            data: {
                labels: months,
                datasets: [{
                    label: 'Totale commessa',
                    data: totals,
                    backgroundColor: 'rgba(99, 140, 255, 0.18)',
                    borderColor: 'rgba(99, 140, 255, 1)',
                    borderWidth: 2,
                    fill: 'origin',
                    tension: 0.3,
                    pointRadius: 2,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    y: { beginAtZero: true, ticks: { callback: (v) => fmtNum.format(v) } },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: { label: (ctx) => `€ ${fmtNum.format(ctx.parsed.y)}` },
                    },
                },
            },
        };
    } else {
        config = {
            type: 'line',
            data: { labels: months, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    y: { stacked: true, beginAtZero: true,
                         ticks: { callback: (v) => fmtNum.format(v) } },
                    x: { stacked: true },
                },
                plugins: {
                    legend: { position: 'bottom',
                              labels: { boxWidth: 10, padding: 6, font: { size: 10 } } },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.dataset.label}: € ${fmtNum.format(ctx.parsed.y)}`,
                        },
                    },
                },
            },
        };
    }

    const chart = new Chart(canvas, config);
    chartsByCommessa.set(commessaKey, chart);
}

/**
 * Tabella mese × categoria per una commessa (P10b).
 * mode: 'mensile' (valori puri) o 'progressivo' (cumulati).
 * Riusa i mensili già filtrati per data globale (sono in perCategoria[id].mensili).
 */
function renderTabellaPerMese(perCategoria, mode) {
    // Mesi unione su tutte le categorie con dati
    const monthSet = new Set();
    for (const cd of Object.values(perCategoria)) {
        if (!cd) continue;
        for (const m of cd.mensili) monthSet.add(m.mese);
    }
    const mesi = Array.from(monthSet).sort();

    if (mesi.length === 0) {
        return `<p class="cost-view-empty">Nessun dato per il range filtri corrente.</p>`;
    }

    const headers = [
        '<th class="cost-month-cat-col">Categoria</th>',
        ...mesi.map(m => `<th class="num">${escapeHtml(formatMeseBreve(m))}</th>`),
        '<th class="num cost-month-total-col">Totale</th>',
    ].join('');

    // Per ogni categoria con dati
    const rows = getCostCategories().map(catDef => {
        const cd = perCategoria[catDef.id];
        if (!cd) return '';
        const valByMese = {};
        for (const m of cd.mensili) valByMese[m.mese] = m.valore;
        let cum = 0;
        const cellValues = mesi.map(m => {
            const v = valByMese[m] || 0;
            cum += v;
            return mode === 'progressivo' ? cum : v;
        });
        const totForRow = mode === 'progressivo'
            ? cellValues[cellValues.length - 1]
            : cellValues.reduce((s, c) => s + c, 0);
        const cellsHtml = cellValues.map(c => `<td class="num">${formatCurrency(c)}</td>`).join('');
        return `<tr>
            <td class="cost-month-cat-col">${escapeHtml(catDef.label)}</td>
            ${cellsHtml}
            <td class="num cost-month-total-col">${formatCurrency(totForRow)}</td>
        </tr>`;
    }).filter(Boolean).join('');

    // Riga totale per mese (somma categorie)
    let cumTot = 0;
    const totCells = mesi.map(m => {
        let s = 0;
        for (const cd of Object.values(perCategoria)) {
            if (!cd) continue;
            const found = cd.mensili.find(mm => mm.mese === m);
            if (found) s += (found.valore || 0);
        }
        cumTot += s;
        return mode === 'progressivo' ? cumTot : s;
    });
    const grandTotalMode = mode === 'progressivo'
        ? totCells[totCells.length - 1]
        : totCells.reduce((s, c) => s + c, 0);
    const totRow = `<tr class="cost-totale-row">
        <td class="cost-month-cat-col">Totale commessa</td>
        ${totCells.map(c => `<td class="num">${formatCurrency(c)}</td>`).join('')}
        <td class="num cost-month-total-col">${formatCurrency(grandTotalMode)}</td>
    </tr>`;

    return `
        <div class="cost-month-table-wrapper">
            <table class="cost-month-table">
                <thead><tr>${headers}</tr></thead>
                <tbody>${rows}</tbody>
                <tfoot>${totRow}</tfoot>
            </table>
        </div>
    `;
}

function renderCommessaCard(data, locked, scenario) {
    const { commessa, fallback, perCategoria, totAc, totFuturo, totGrand } = data;
    const shift = getCommessaShift(scenario, commessa.key);
    // È "materializzata" se lo scenario ha già scenario.costi[key].categorie con ≥1 entry.
    // In quel caso si può proporre il reset (= cancella la materializzazione, ritorna al cold-start fresh).
    const isMaterialized = !!(
        scenario?.costi?.[commessa.key]?.categorie &&
        Object.keys(scenario.costi[commessa.key].categorie).length > 0
    );
    const expanded = isExpanded(commessa.key);

    const card = document.createElement('div');
    card.className = 'cost-commessa-card' + (expanded ? ' expanded' : '');
    card.dataset.commessaKey = commessa.key;

    const typeMeta = TYPE_LABEL[commessa.type] || { short: commessa.type || '?', cls: 'badge-settore' };
    const origineShort = ORIGINE_LABEL[fallback.origine] || fallback.origine;

    // Header
    const header = document.createElement('div');
    header.className = 'cost-commessa-card-header';
    // R3+R4: Azzera (svuota i dati) + Suggerisci (rigenera da margine).
    // Azzera visibile solo se ci sono dati; Suggerisci sempre disponibile.
    const azzeraBtn = (isMaterialized && !locked)
        ? `<button type="button" class="cost-action-btn cost-azzera-btn" data-action="azzera" title="Azzera tutti i costi della commessa (cancella anche AC e remaining BI)">🗑 Azzera</button>`
        : '';
    const suggerisciBtn = !locked
        ? `<button type="button" class="cost-action-btn cost-suggerisci-btn" data-action="suggerisci" title="Genera costi suggeriti da margine + pesi/curve di default">✨ Suggerisci</button>`
        : '';
    header.innerHTML = `
        <span class="chevron">▶</span>
        <span class="codice">${escapeHtml(commessa.codice)}</span>
        <span class="nome">${escapeHtml(commessa.nome)}</span>
        <span class="header-badge ${typeMeta.cls}">${escapeHtml(typeMeta.short)}</span>
        ${commessa.settore ? `<span class="header-badge badge-settore">${escapeHtml(commessa.settore)}</span>` : ''}
        <span class="header-badge badge-origine">${escapeHtml(origineShort)}</span>
        <span class="totale">€ ${formatCurrency(totGrand)}</span>
        ${suggerisciBtn}
        ${azzeraBtn}
    `;
    header.addEventListener('click', (e) => {
        // Click sui pulsanti azione → non collassare la card
        if (e.target.closest('.cost-action-btn')) return;
        const nowExpanded = !card.classList.contains('expanded');
        card.classList.toggle('expanded', nowExpanded);
        const body = card.querySelector('.cost-commessa-card-body');
        if (body) setHidden(body, !nowExpanded);
        setExpandedState(commessa.key, nowExpanded);

        // Lifecycle del grafico: render al expand, distruggi al collapse
        if (nowExpanded) {
            requestAnimationFrame(() => {
                const ms = card.querySelector('.cost-chart-mode-select');
                renderCommessaChart(card, commessa.key, perCategoria, ms ? ms.value : 'includi_ac');
            });
        } else {
            destroyChart(commessa.key);
        }
    });
    // Handler Azzera
    const azzeraEl = header.querySelector('[data-action="azzera"]');
    if (azzeraEl) {
        azzeraEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const ok = window.confirm(
                `Azzerare gli importi della commessa "${commessa.codice} — ${commessa.nome}"?\n\n` +
                `Verranno azzerati gli AC storici e gli importi futuri (= 0).\n` +
                `Date di inizio/fine, durata e curva resteranno invariate.\n\n` +
                `Per ripristinare gli importi: importa BI o usa "Suggerisci" per rigenerare da margine.`
            );
            if (!ok) return;
            azzeraCommessaCosts(commessa.key);
        });
    }
    // Handler Suggerisci
    const suggerisciEl = header.querySelector('[data-action="suggerisci"]');
    if (suggerisciEl) {
        suggerisciEl.addEventListener('click', (e) => {
            e.stopPropagation();
            if (isMaterialized) {
                const ok = window.confirm(
                    `Generare suggerimento costi per "${commessa.codice} — ${commessa.nome}"?\n\n` +
                    `⚠ I dati attuali della commessa saranno SOSTITUITI con valori calcolati da:\n` +
                    `  • Costo totale = VDP × (1 - margine)\n` +
                    `  • Distribuiti per categoria con pesi e curve di default\n\n` +
                    `Eventuali AC importati e modifiche manuali saranno persi.`
                );
                if (!ok) return;
            }
            suggerisciCommessaCosts(commessa.key);
        });
    }

    // Body (tabella categorie + selettore vista + grafico/tabella mensile/progressivo)
    const body = document.createElement('div');
    body.className = 'cost-commessa-card-body' + (expanded ? '' : ' hidden');
    body.innerHTML = `
        ${renderCategoriaTable(perCategoria, totAc, totFuturo, totGrand, locked, shift)}
        <div class="cost-view-selector">
            <button type="button" data-view="grafico" class="active">Grafico</button>
            <button type="button" data-view="tabella-mensile">Tabella Mensile</button>
            <button type="button" data-view="tabella-progressivo">Tabella Progressivo</button>
        </div>
        <div class="cost-view-container">
            <div class="cost-view-grafico">
                <div class="cost-chart-container">
                    <div class="cost-chart-toolbar">
                        <label class="cost-chart-mode-label">Vista grafico:</label>
                        <select class="cost-chart-mode-select">
                            <option value="includi_ac">Includi AC (stacked)</option>
                            <option value="solo_futuro">Solo futuro (stacked)</option>
                            <option value="totale">Totale commessa</option>
                        </select>
                    </div>
                    <div class="cost-chart-canvas-wrapper">
                        <canvas class="cost-chart-canvas"></canvas>
                    </div>
                </div>
            </div>
            <div class="cost-view-tabella-mensile hidden">
                ${renderTabellaPerMese(perCategoria, 'mensile')}
            </div>
            <div class="cost-view-tabella-progressivo hidden">
                ${renderTabellaPerMese(perCategoria, 'progressivo')}
            </div>
        </div>
    `;

    card.appendChild(header);
    card.appendChild(body);

    // Listener cambio modalità grafico
    const modeSel = body.querySelector('.cost-chart-mode-select');
    if (modeSel) {
        modeSel.addEventListener('change', () => {
            renderCommessaChart(card, commessa.key, perCategoria, modeSel.value);
        });
    }

    // Listener selettore vista (Grafico / Tabella Mensile / Tabella Progressivo)
    const viewSel = body.querySelector('.cost-view-selector');
    if (viewSel) {
        viewSel.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-view]');
            if (!btn) return;
            const view = btn.dataset.view;
            // Stato pulsanti
            for (const b of viewSel.querySelectorAll('button')) {
                b.classList.toggle('active', b.dataset.view === view);
            }
            // Mostra il container appropriato
            const container = body.querySelector('.cost-view-container');
            for (const child of container.children) {
                child.classList.toggle('hidden', !child.classList.contains(`cost-view-${view}`));
            }
            // Lifecycle chart: ricreato solo per vista grafico, distrutto altrimenti
            if (view === 'grafico') {
                requestAnimationFrame(() => {
                    const m = modeSel ? modeSel.value : 'includi_ac';
                    renderCommessaChart(card, commessa.key, perCategoria, m);
                });
            } else {
                destroyChart(commessa.key);
            }
        });
    }

    // Render iniziale del grafico se la card è già espansa al primo paint
    // (es. stato persistito in localStorage). Defer in rAF per assicurare che
    // il canvas abbia dimensioni > 0 (Chart.js richiede dimensioni reali).
    if (expanded) {
        requestAnimationFrame(() => {
            const m = modeSel ? modeSel.value : 'includi_ac';
            renderCommessaChart(card, commessa.key, perCategoria, m);
        });
    }

    return card;
}

function renderCurvaSelect(catId, currentValue, disabled) {
    const opts = COST_PROFILES.map(p => {
        const sel = p.id === currentValue ? ' selected' : '';
        return `<option value="${p.id}"${sel}>${escapeHtml(p.label)}</option>`;
    }).join('');
    return `<select data-cat="${escapeHtml(catId)}" data-field="tipoCurva"${disabled ? ' disabled' : ''}>${opts}</select>`;
}

function renderCategoriaTable(perCategoria, totAc, totFuturo, totGrand, locked, shift) {
    const dis = locked ? ' disabled' : '';
    const rows = getCostCategories().map(catDef => {
        const cd = perCategoria[catDef.id];
        if (!cd) {
            // Categoria assente nei dati → riga read-only "— nessun dato —"
            return `<tr>
                <td>${escapeHtml(catDef.label)}</td>
                <td colspan="4" class="cost-cat-empty">— nessun dato —</td>
                <td class="num cost-cat-empty">—</td>
                <td class="num cost-cat-empty">—</td>
                <td class="num cost-cat-empty">—</td>
            </tr>`;
        }
        // Date EFFETTIVE post-shift mostrate all'utente. cat.dataInizio salvata
        // è la data PRE-shift (per coerenza con la pipeline). Quando l'utente
        // edita le date, applyEdit smonta lo shift al salvataggio.
        const baseInizio = cd.cat.dataInizio || '';
        const baseFine = cd.cat.dataFine || '';
        const dataInizio = baseInizio ? shiftMonth(baseInizio, shift) : '';
        const dataFine = baseFine ? shiftMonth(baseFine, shift) : '';
        const durata = (cd.cat.durata != null ? cd.cat.durata : '');
        const curva = cd.cat.tipoCurva || 'uniforme';
        const importoFuturo = Number(cd.cat.importoFuturo) || 0;

        return `<tr>
            <td>${escapeHtml(catDef.label)}</td>
            <td><input type="month" data-cat="${escapeHtml(catDef.id)}" data-field="dataInizio" value="${escapeHtml(dataInizio)}"${dis}/></td>
            <td><input type="number" min="1" step="1" data-cat="${escapeHtml(catDef.id)}" data-field="durata" value="${durata}"${dis}/></td>
            <td><input type="month" data-cat="${escapeHtml(catDef.id)}" data-field="dataFine" value="${escapeHtml(dataFine)}"${dis}/></td>
            <td>${renderCurvaSelect(catDef.id, curva, locked)}</td>
            <td class="num">${formatCurrency(cd.acPart)}</td>
            <td><input type="text" inputmode="numeric" data-cat="${escapeHtml(catDef.id)}" data-field="importoFuturo" class="num cost-num-input" value="${formatCurrency(importoFuturo)}"${dis}/></td>
            <td class="num">${formatCurrency(cd.totMensili)}</td>
        </tr>`;
    }).join('');

    return `
        <table class="cost-categoria-table">
            <thead>
                <tr>
                    <th>Categoria</th>
                    <th>Data Inizio</th>
                    <th>Durata</th>
                    <th>Data Fine</th>
                    <th>Curva</th>
                    <th class="num">AC storico</th>
                    <th class="num">Importo Futuro</th>
                    <th class="num">Totale</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr class="cost-totale-row">
                    <td colspan="5">Totale commessa</td>
                    <td class="num">${formatCurrency(totAc)}</td>
                    <td class="num">${formatCurrency(totFuturo)}</td>
                    <td class="num">${formatCurrency(totGrand)}</td>
                </tr>
            </tfoot>
        </table>
    `;
}

function renderAggregatoCard(aggregatoEl, perCommessa) {
    // Aggrega per categoria su tutte le commesse: oltre ad AC/futuro/totali,
    // sommiamo i mensili ({mese, valore}) per riusare le viste Grafico/Mensile/Progressivo
    // identiche a quelle delle card singole.
    const aggrPerCat = {};
    let grandTotAc = 0;
    let grandTotFuturo = 0;
    let grandTot = 0;

    for (const catDef of getCostCategories()) {
        let ac = 0, futuro = 0, tot = 0;
        let hasData = false;
        const mesiMap = new Map(); // mese → valore aggregato
        for (const data of perCommessa) {
            const cd = data.perCategoria[catDef.id];
            if (!cd) continue;
            hasData = true;
            ac += cd.acPart;
            futuro += cd.futuroPart;
            tot += cd.totMensili;
            for (const m of cd.mensili || []) {
                mesiMap.set(m.mese, (mesiMap.get(m.mese) || 0) + (m.valore || 0));
            }
        }
        const mensili = Array.from(mesiMap.entries())
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([mese, valore]) => ({ mese, valore }));
        aggrPerCat[catDef.id] = { ac, futuro, tot, hasData, mensili };
        grandTotAc += ac;
        grandTotFuturo += futuro;
        grandTot += tot;
    }

    // perCategoriaAggregato in formato compatibile con renderCommessaChart e renderTabellaPerMese
    const perCategoriaAggregato = {};
    for (const catDef of getCostCategories()) {
        const a = aggrPerCat[catDef.id];
        if (!a.hasData) continue;
        perCategoriaAggregato[catDef.id] = { mensili: a.mensili };
    }

    const rows = getCostCategories().map(catDef => {
        const a = aggrPerCat[catDef.id];
        if (!a.hasData) {
            return `<tr>
                <td>${escapeHtml(catDef.label)}</td>
                <td class="num cost-cat-empty">—</td>
                <td class="num cost-cat-empty">—</td>
                <td class="num cost-cat-empty">—</td>
            </tr>`;
        }
        return `<tr>
            <td>${escapeHtml(catDef.label)}</td>
            <td class="num">${formatCurrency(a.ac)}</td>
            <td class="num">${formatCurrency(a.futuro)}</td>
            <td class="num">${formatCurrency(a.tot)}</td>
        </tr>`;
    }).join('');

    aggregatoEl.innerHTML = `
        <div class="cost-aggregato-header">
            <span class="titolo">📊 Totale aggregato — ${perCommessa.length} commess${perCommessa.length === 1 ? 'a' : 'e'}</span>
            <span class="totale">€ ${formatCurrency(grandTot)}</span>
        </div>
        <div class="cost-aggregato-body">
            <table class="cost-categoria-table">
                <thead>
                    <tr>
                        <th>Categoria</th>
                        <th class="num">AC storico</th>
                        <th class="num">Importo Futuro</th>
                        <th class="num">Totale</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr class="cost-totale-row">
                        <td>Totale complessivo</td>
                        <td class="num">${formatCurrency(grandTotAc)}</td>
                        <td class="num">${formatCurrency(grandTotFuturo)}</td>
                        <td class="num">${formatCurrency(grandTot)}</td>
                    </tr>
                </tfoot>
            </table>
            <div class="cost-view-selector">
                <button type="button" data-view="grafico" class="active">Grafico</button>
                <button type="button" data-view="tabella-mensile">Tabella Mensile</button>
                <button type="button" data-view="tabella-progressivo">Tabella Progressivo</button>
            </div>
            <div class="cost-view-container">
                <div class="cost-view-grafico">
                    <div class="cost-chart-container">
                        <div class="cost-chart-toolbar">
                            <label class="cost-chart-mode-label">Vista grafico:</label>
                            <select class="cost-chart-mode-select">
                                <option value="includi_ac">Includi AC (stacked)</option>
                                <option value="solo_futuro">Solo futuro (stacked)</option>
                                <option value="totale">Totale aggregato</option>
                            </select>
                        </div>
                        <div class="cost-chart-canvas-wrapper">
                            <canvas class="cost-chart-canvas"></canvas>
                        </div>
                    </div>
                </div>
                <div class="cost-view-tabella-mensile hidden">
                    ${renderTabellaPerMese(perCategoriaAggregato, 'mensile')}
                </div>
                <div class="cost-view-tabella-progressivo hidden">
                    ${renderTabellaPerMese(perCategoriaAggregato, 'progressivo')}
                </div>
            </div>
        </div>
    `;

    // Listener cambio modalità grafico
    const modeSel = aggregatoEl.querySelector('.cost-chart-mode-select');
    if (modeSel) {
        modeSel.addEventListener('change', () => {
            renderCommessaChart(aggregatoEl, '__aggregato__', perCategoriaAggregato, modeSel.value);
        });
    }

    // Listener selettore vista
    const viewSel = aggregatoEl.querySelector('.cost-view-selector');
    if (viewSel) {
        viewSel.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-view]');
            if (!btn) return;
            const view = btn.dataset.view;
            for (const b of viewSel.querySelectorAll('button')) {
                b.classList.toggle('active', b.dataset.view === view);
            }
            const container = aggregatoEl.querySelector('.cost-view-container');
            for (const child of container.children) {
                child.classList.toggle('hidden', !child.classList.contains(`cost-view-${view}`));
            }
            if (view === 'grafico') {
                requestAnimationFrame(() => {
                    const m = modeSel ? modeSel.value : 'includi_ac';
                    renderCommessaChart(aggregatoEl, '__aggregato__', perCategoriaAggregato, m);
                });
            } else {
                destroyChart('__aggregato__');
            }
        });
    }

    // Render iniziale: la card aggregato è sempre espansa
    requestAnimationFrame(() => {
        const m = modeSel ? modeSel.value : 'includi_ac';
        renderCommessaChart(aggregatoEl, '__aggregato__', perCategoriaAggregato, m);
    });
}

// ─────────────────────────────────────────────────────
// Editing parametri (P9)
// ─────────────────────────────────────────────────────

const VALID_CURVE_IDS = new Set(COST_PROFILES.map(p => p.id));

/**
 * Materializza i costi di una commessa nello scenario salvato, copiando
 * la struttura derivata dal fallback chain (cold-start o copia). Usato alla
 * prima modifica utente su una commessa che non ha ancora dati nello scenario.
 * Ritorna lo scenario aggiornato, o null se non modificabile (locked / non trovato).
 */
function materializeCommessaCosts(scenarioId, commessaKey, commessa, baselineMonths) {
    const scen = getScenario(scenarioId);
    if (!scen) return null;
    const existingCat = scen.costi?.[commessaKey]?.categorie;
    if (existingCat && Object.keys(existingCat).length > 0) return scen;

    const fallback = getCostsForCommessa({
        scenario: scen,
        commessaKey,
        commessa,
        baselineMonths,
        allScenarios: listScenarios(),
    });
    if (!fallback.categorie || Object.keys(fallback.categorie).length === 0) {
        return scen; // niente da materializzare (Backlog vuoto)
    }
    const newCosti = { ...(scen.costi || {}) };
    newCosti[commessaKey] = { categorie: fallback.categorie };
    return updateScenario(scenarioId, { costi: newCosti });
}

/**
 * Applica una modifica di un parametro categoria.
 * Gestisce coerenza dataInizio/durata/dataFine, valida e salva.
 */
function applyEdit(commessaKey, catId, field, rawValue) {
    if (isViewerReadOnly()) return; // viewer non può editare
    const scenarioId = getActiveScenarioIdFromDOM();
    if (!scenarioId) return;
    const scenario = getScenario(scenarioId);
    if (!scenario || scenario.locked) return;

    const baseline = getBaselineSafe();
    if (!baseline) return;

    // Pool commesse "viste" dallo scenario (gestisce commesse extra di scenari imported
    // non presenti nella baseline iniziale)
    const allCommesse = getCommesseForScenario(scenario, baseline);
    const commessa = allCommesse.find(c => c.key === commessaKey);
    if (!commessa) return;

    // Mesi sorgente PRE-shift dello scenario (importedData se imported, baseline
    // altrimenti). Stessa logica del render — fondamentale che la materializzazione
    // alla prima edit usi le DATE CORRETTE dello scenario, non quelle baseline.
    const sourceMonths = getDataSourceMonths(scenario, commessaKey, baseline);

    // Materializza la commessa se non già nello scenario
    let scen = materializeCommessaCosts(scenarioId, commessaKey, commessa, sourceMonths);
    if (!scen) return; // locked o non trovato
    if (scen.locked) return;

    const currentCat = scen.costi?.[commessaKey]?.categorie?.[catId];
    if (!currentCat) {
        // Categoria non presente nei dati materializzati (es. peso 0 senza BI).
        // In P9 non gestiamo la creazione da zero: re-render e ritorna.
        scheduleRender();
        return;
    }

    const updated = { ...currentCat };
    let valid = true;

    // Le date in UI sono "effettive" (post-shift). Smonto lo shift dell'inputs
    // corrente per salvare la data PRE-shift in cat.dataInizio/dataFine
    // (coerenza con la pipeline computeCategoriaMensile che riapplica lo shift).
    const shiftIn = getCommessaShift(scen, commessaKey);

    if (field === 'dataInizio') {
        if (!rawValue) { valid = false; }
        else {
            const baseInizio = shiftIn ? shiftMonth(rawValue, -shiftIn) : rawValue;
            updated.dataInizio = baseInizio;
            const dur = Number(updated.durata);
            if (Number.isFinite(dur) && dur >= 1) {
                updated.dataFine = shiftMonth(baseInizio, dur - 1);
            }
        }
    } else if (field === 'durata') {
        const dur = Math.max(1, Math.round(Number(rawValue) || 0));
        if (!Number.isFinite(dur) || dur < 1) { valid = false; }
        else {
            updated.durata = dur;
            if (updated.dataInizio) {
                updated.dataFine = shiftMonth(updated.dataInizio, dur - 1);
            }
        }
    } else if (field === 'dataFine') {
        if (!rawValue) { valid = false; }
        else {
            const baseFine = shiftIn ? shiftMonth(rawValue, -shiftIn) : rawValue;
            if (updated.dataInizio && baseFine < updated.dataInizio) {
                valid = false; // dataFine non può essere prima di dataInizio
            } else {
                updated.dataFine = baseFine;
                if (updated.dataInizio) {
                    updated.durata = monthsBetween(updated.dataInizio, baseFine);
                }
            }
        }
    } else if (field === 'tipoCurva') {
        if (!VALID_CURVE_IDS.has(rawValue)) { valid = false; }
        else { updated.tipoCurva = rawValue; }
    } else if (field === 'importoFuturo') {
        const v = Number(rawValue);
        if (!Number.isFinite(v) || v < 0) { valid = false; }
        else { updated.importoFuturo = v; }
    } else {
        return; // field sconosciuto
    }

    if (!valid) {
        // Ripristino UI con i valori salvati
        scheduleRender();
        return;
    }

    // R0: campi che governano la curva — se modificati, "scollego" remainingStorico
    // (i valori puntuali del BI vengono sostituiti dalla curva rigenerata)
    const fieldsThatBreakDistribution = new Set(['durata', 'dataFine', 'tipoCurva', 'importoFuturo']);
    if (fieldsThatBreakDistribution.has(field)) {
        const hadRemainingStorico = currentCat.remainingStorico
            && Object.keys(currentCat.remainingStorico).length > 0;
        if (hadRemainingStorico) {
            const ok = window.confirm(
                `Questa categoria ha una distribuzione mensile importata dal BI.\n\n` +
                `Modificando ${field} la distribuzione verrà sostituita da una curva generata ` +
                `(${updated.tipoCurva || 'curva'}). I valori mensili puntuali del BI saranno persi.\n\n` +
                `Vuoi continuare?`
            );
            if (!ok) {
                scheduleRender();
                return;
            }
        }
        updated.remainingStorico = {}; // scollego
    }

    // Marca origine come "manuale" per tracciare modifiche utente
    updated.origine = 'manuale';

    const newCosti = {
        ...scen.costi,
        [commessaKey]: {
            ...scen.costi[commessaKey],
            categorie: {
                ...scen.costi[commessaKey].categorie,
                [catId]: updated,
            },
        },
    };
    updateScenario(scenarioId, { costi: newCosti });
    scheduleRender();
}

/**
 * R3 — Azzera: azzera gli importi monetari delle categorie di una commessa,
 * MANTENENDO la struttura (dataInizio/durata/dataFine/curva).
 * Per ogni categoria: AC storico = {}, remainingStorico = {}, importoFuturo = 0.
 * Le date e la curva restano visibili nella tabella.
 * Per ripristinare gli importi: import BI o pulsante "Suggerisci".
 */
function azzeraCommessaCosts(commessaKey) {
    if (isViewerReadOnly()) return;
    const scenarioId = getActiveScenarioIdFromDOM();
    if (!scenarioId) return;
    const scen = getScenario(scenarioId);
    if (!scen || scen.locked) return;
    const existing = scen.costi?.[commessaKey];
    if (!existing || !existing.categorie || Object.keys(existing.categorie).length === 0) {
        scheduleRender();
        return;
    }
    // Per ogni categoria: azzero gli importi ma mantengo date, durata, curva
    const newCategorie = {};
    for (const [catId, cat] of Object.entries(existing.categorie)) {
        newCategorie[catId] = {
            ...cat,
            acStorico: {},
            remainingStorico: {},
            importoFuturo: 0,
            origine: 'manuale',
        };
    }
    const newCosti = { ...scen.costi };
    newCosti[commessaKey] = { ...existing, categorie: newCategorie };
    updateScenario(scenarioId, { costi: newCosti });
    scheduleRender();
}

/**
 * R4 — Suggerisci: rigenera i costi della commessa da cold-start margine.
 * Costo totale = VDP × (1 - margineAOP), distribuito per categoria con pesi
 * e curve di default. Equivalente al vecchio comportamento del pulsante Reset.
 * Sovrascrive eventuali dati esistenti (AC inclusi) → conferma chiesta a monte.
 */
function suggerisciCommessaCosts(commessaKey) {
    if (isViewerReadOnly()) return;
    const scenarioId = getActiveScenarioIdFromDOM();
    if (!scenarioId) return;
    const scen = getScenario(scenarioId);
    if (!scen || scen.locked) return;

    const baseline = getBaselineSafe();
    if (!baseline) return;
    const allCommesse = getCommesseForScenario(scen, baseline);
    const commessa = allCommesse.find(c => c.key === commessaKey);
    if (!commessa) return;
    const sourceMonths = getDataSourceMonths(scen, commessaKey, baseline);

    // Forza il cold-start: cancella prima i dati esistenti, poi materializza tramite
    // la fallback chain (per scenari imported = direttamente cold-start margine,
    // per calculated = scenario precedente o cold-start margine).
    const tempCosti = { ...(scen.costi || {}) };
    delete tempCosti[commessaKey];
    const tempScenario = { ...scen, costi: tempCosti };

    const fallback = getCostsForCommessa({
        scenario: tempScenario,
        commessaKey,
        commessa,
        baselineMonths: sourceMonths,
        allScenarios: listScenarios(),
    });
    if (!fallback.categorie || Object.keys(fallback.categorie).length === 0) {
        alert(
            `Impossibile generare suggerimento per "${commessa.codice} — ${commessa.nome}".\n\n` +
            `Possibili cause: VDP totale = 0, margine ≥ 100%, date commessa non valide.`
        );
        return;
    }

    const newCosti = { ...(scen.costi || {}) };
    newCosti[commessaKey] = { categorie: fallback.categorie };
    updateScenario(scenarioId, { costi: newCosti });
    scheduleRender();
}

/**
 * Parsing di un numero in formato italiano (separatore migliaia "." e/o decimale ",").
 * Tollerante: rimuove anche spazi, simboli "€" e segni stranieri. Ritorna 0 se non parseable.
 */
function parseFormattedNumber(s) {
    if (s == null) return 0;
    const cleaned = String(s).replace(/[.\s€]/g, '').replace(',', '.');
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
}

function attachEditHandler() {
    const container = $('#cost-commesse-container');
    if (!container) return;
    container.addEventListener('change', (e) => {
        const input = e.target.closest('input, select');
        if (!input) return;
        if (input.disabled) return;
        // Input numerici formattati: gestiti da focusin/focusout, non da change
        // (altrimenti il valore con separatori verrebbe parsato male in applyEdit)
        if (input.classList.contains('cost-num-input')) return;
        const card = input.closest('.cost-commessa-card');
        if (!card) return;
        const commessaKey = card.dataset.commessaKey;
        const catId = input.dataset.cat;
        const field = input.dataset.field;
        if (!commessaKey || !catId || !field) return;
        applyEdit(commessaKey, catId, field, input.value);
    });
    // Focusin su input numerico: rimuove i separatori per facilitare la digitazione
    container.addEventListener('focusin', (e) => {
        const input = e.target.closest('input.cost-num-input');
        if (!input || input.disabled) return;
        const raw = parseFormattedNumber(input.value);
        input.value = raw === 0 ? '' : String(raw);
        setTimeout(() => { try { input.select(); } catch { /* ignore */ } }, 0);
    });
    // Focusout su input numerico: parse + riformatta + applyEdit con valore raw
    container.addEventListener('focusout', (e) => {
        const input = e.target.closest('input.cost-num-input');
        if (!input || input.disabled) return;
        const num = parseFormattedNumber(input.value);
        input.value = formatCurrency(num);
        const card = input.closest('.cost-commessa-card');
        if (!card) return;
        const commessaKey = card.dataset.commessaKey;
        const catId = input.dataset.cat;
        const field = input.dataset.field;
        if (!commessaKey || !catId || !field) return;
        applyEdit(commessaKey, catId, field, String(num));
    });
    // Evita che il click sull'input/select propaghi al header (causerebbe collapse)
    container.addEventListener('click', (e) => {
        const interactive = e.target.closest('input, select');
        if (interactive) e.stopPropagation();
    }, true);
}

// ─────────────────────────────────────────────────────
// Import BI — pulsante + dialog match commesse (P11)
// ─────────────────────────────────────────────────────

/** Stato del flusso import in corso (null se nessun import attivo). */
let _importState = null;

/**
 * Apre il file picker per l'import BI. Esegue parsing e mostra il modal di
 * conferma con tabella di match commesse.
 */
function startBIImport() {
    if (isViewerReadOnly()) {
        alert('Modalità sola lettura: non hai i permessi per importare dati BI.');
        return;
    }
    const scenarioId = getActiveScenarioIdFromDOM();
    if (!scenarioId) {
        alert('Seleziona uno scenario attivo prima di importare i costi.');
        return;
    }
    const scen = getScenario(scenarioId);
    if (!scen) return;
    if (scen.locked) {
        alert('Scenario bloccato. Sbloccalo dal menu scenari prima di importare dati BI.');
        return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.style.display = 'none';
    input.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            const buf = await file.arrayBuffer();
            const result = parseBIExport(buf, { fileName: file.name });
            openImportModal(result, scenarioId);
        } catch (err) {
            console.error('[costi] Errore parsing BI:', err);
            alert('Errore durante il parsing del file BI:\n\n' + err.message);
        }
    });
    document.body.appendChild(input);
    input.click();
    // cleanup deferred
    setTimeout(() => input.remove(), 1000);
}

/** Apre il modal con la tabella di match. */
function openImportModal(parseResult, scenarioId) {
    const modal = $('#cost-import-modal');
    if (!modal) return;

    const baseline = getBaselineSafe();
    const allCommesse = baseline?.commesse || [];

    // Costruisce le righe di selezione: una per ogni commessa nel BI.
    // Match per codice (case-insensitive trim).
    const rows = parseResult.commesse.map(biC => {
        const upperBI = biC.codice.toUpperCase();
        const suggested = allCommesse.find(ac => (ac.codice || '').toUpperCase().trim() === upperBI) || null;
        return {
            codiceBI: biC.codice,
            nomeBI: biC.nome,
            mesi: biC.mesi,
            suggestedKey: suggested?.key || null,
            suggestedLabel: suggested ? `${suggested.codice} — ${suggested.nome}` : null,
            // Default: importa se match trovato; default override = suggerita
            selected: !!suggested,
            overrideKey: suggested?.key || '',
        };
    });

    _importState = {
        scenarioId,
        parseResult,
        rows,
        allCommesse,
    };

    renderImportModal();
    setHidden(modal, false);
}

function renderImportModal() {
    if (!_importState) return;
    const { parseResult, rows, allCommesse } = _importState;

    // Summary
    const summary = $('#cost-import-summary');
    if (summary) {
        const matched = rows.filter(r => r.suggestedKey).length;
        const unmatched = rows.length - matched;
        summary.innerHTML = `
            File: <strong>${escapeHtml(parseResult.meta.fileName || '(sconosciuto)')}</strong>
            &middot; ${rows.length} commesse trovate
            &middot; ${matched} con match codice
            ${unmatched > 0 ? `&middot; <span style="color:#b75200;">${unmatched} senza match</span>` : ''}
            ${parseResult.meta.cutoffMese ? `&middot; cutoff AC: <strong>${escapeHtml(parseResult.meta.cutoffMese)}</strong>` : ''}
            &middot; ${parseResult.meta.stats.righeImportate} righe utili (${parseResult.meta.stats.righeIgnorateCategoria} RIS ignorate)
        `;
    }

    // Warnings
    const warnings = $('#cost-import-warnings');
    if (warnings) {
        warnings.innerHTML = '';
        for (const w of parseResult.warnings || []) {
            const div = document.createElement('div');
            div.className = 'warning-item';
            div.textContent = w;
            warnings.appendChild(div);
        }
    }

    // Tabella righe + datalist condiviso per l'autocomplete del campo override
    const tbody = $('#cost-import-tbody');
    if (tbody) {
        // Mappe label↔key per il lookup veloce nel listener input
        const labelOf = (c) => `${c.codice} — ${c.nome}`;
        const labelToKey = new Map(allCommesse.map(c => [labelOf(c), c.key]));
        const keyToLabel = new Map(allCommesse.map(c => [c.key, labelOf(c)]));
        // Salvo per riuso nel listener delegato (per il match dell'utente)
        _importState.labelToKey = labelToKey;

        // Datalist condiviso da tutti gli input. Lo creo (o aggiorno) come fratello del modal.
        let datalist = $('#cost-import-datalist');
        if (!datalist) {
            datalist = document.createElement('datalist');
            datalist.id = 'cost-import-datalist';
            document.body.appendChild(datalist);
        }
        datalist.innerHTML = allCommesse
            .map(c => `<option value="${escapeHtml(labelOf(c))}"></option>`)
            .join('');

        tbody.innerHTML = '';
        rows.forEach((r, idx) => {
            const tr = document.createElement('tr');
            if (!r.suggestedKey) tr.classList.add('cost-import-row-warn');
            const initialLabel = r.overrideKey ? (keyToLabel.get(r.overrideKey) || '') : '';
            tr.innerHTML = `
                <td class="cost-import-td-check">
                    <input type="checkbox" data-idx="${idx}" data-action="toggle-import" ${r.selected ? 'checked' : ''}/>
                </td>
                <td><code>${escapeHtml(r.codiceBI)}</code></td>
                <td>${escapeHtml(r.nomeBI)}</td>
                <td class="${r.suggestedKey ? 'cost-import-suggested-ok' : 'cost-import-suggested-none'}">
                    ${r.suggestedKey ? escapeHtml(r.suggestedLabel) : '⚠ nessuna corrispondenza'}
                </td>
                <td>
                    <input type="text"
                           class="cost-import-override"
                           list="cost-import-datalist"
                           data-idx="${idx}"
                           data-action="change-override"
                           placeholder="Digita codice o nome…"
                           value="${escapeHtml(initialLabel)}" />
                </td>
            `;
            tbody.appendChild(tr);
        });

        // Listener delegato (input + change). Uso 'input' per reagire anche
        // alla selezione da datalist (in alcuni browser non emette 'change').
        const handleEdit = (e) => {
            const t = e.target;
            const idx = Number(t.dataset.idx);
            if (!Number.isFinite(idx) || !_importState) return;
            const row = _importState.rows[idx];
            if (!row) return;
            if (t.dataset.action === 'toggle-import') {
                row.selected = !!t.checked;
            } else if (t.dataset.action === 'change-override') {
                const lbl = (t.value || '').trim();
                const key = _importState.labelToKey.get(lbl) || '';
                row.overrideKey = key;
                // Se l'utente ha scelto una commessa valida → segna selected
                if (key) row.selected = true;
                // Visual feedback: se il testo non è vuoto e non corrisponde a una
                // commessa valida, evidenzio l'input in arancio.
                if (lbl && !key) t.classList.add('cost-import-override-invalid');
                else t.classList.remove('cost-import-override-invalid');
            }
            updateImportCounter();
        };
        tbody.oninput = handleEdit;
        tbody.onchange = handleEdit;
    }

    updateImportCounter();
}

function updateImportCounter() {
    const counter = $('#cost-import-counter');
    if (!counter || !_importState) return;
    const total = _importState.rows.length;
    const sel = _importState.rows.filter(r => r.selected && r.overrideKey).length;
    const noOverride = _importState.rows.filter(r => r.selected && !r.overrideKey).length;
    let txt = `${sel} di ${total} commesse selezionate`;
    if (noOverride > 0) {
        txt += ` &middot; <span style="color:#b75200;">${noOverride} selezionate senza override (verranno ignorate)</span>`;
    }
    counter.innerHTML = txt;
}

function closeImportModal() {
    const modal = $('#cost-import-modal');
    setHidden(modal, true);
    _importState = null;
}

/**
 * Mostra un modal interattivo "Estendi/Comprimi" per una commessa con costi
 * rimanenti oltre la data fine commessa (§7.4). Ritorna una promise che
 * risolve a 'estendi' | 'comprimi' | 'cancel'.
 */
function askExtendOrCompress({ codice, nome, dataFineCommessa, lastRemMonth }) {
    return new Promise((resolve) => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = `
            <div class="modal cost-extend-modal" style="z-index: 1200;">
                <div class="modal-backdrop"></div>
                <div class="modal-content modal-sm" style="max-width: 520px;">
                    <div class="modal-header">
                        <h3>Costi oltre data fine commessa</h3>
                    </div>
                    <div class="modal-body">
                        <p>La commessa <strong>${escapeHtml(codice)} — ${escapeHtml(nome)}</strong> ha costi rimanenti che vanno oltre la data fine prevista nello scenario.</p>
                        <ul style="margin: 8px 0 16px 20px; font-size: 13px; line-height: 1.5;">
                            <li>Data fine commessa nello scenario: <strong>${escapeHtml(dataFineCommessa)}</strong></li>
                            <li>Ultimo mese con Remaining &gt; 0 nel file BI: <strong>${escapeHtml(lastRemMonth)}</strong></li>
                        </ul>
                        <p style="font-size: 13px; line-height: 1.5;">
                            <strong>Estendi orizzonte costi</strong>: i costi proseguono fino a ${escapeHtml(lastRemMonth)}. Il VDP della commessa rimane invariato (orizzonte costi ≠ orizzonte ricavi).<br/><br/>
                            <strong>Comprimi entro data fine</strong>: il totale viene preservato ma redistribuito sulla curva nel range fino a ${escapeHtml(dataFineCommessa)}.
                        </p>
                    </div>
                    <div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--border);flex-wrap:wrap;">
                        <button class="btn btn-ghost btn-sm" data-action="cancel">Salta questa commessa</button>
                        <button class="btn btn-outline btn-sm" data-action="comprimi">Comprimi entro data fine</button>
                        <button class="btn btn-primary btn-sm" data-action="estendi">Estendi orizzonte costi</button>
                    </div>
                </div>
            </div>
        `;
        const modal = wrapper.firstElementChild;
        document.body.appendChild(modal);
        const onClick = (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            modal.remove();
            resolve(btn.dataset.action);
        };
        modal.addEventListener('click', onClick);
    });
}

/**
 * Costruisce la struttura `categorie` da scrivere in scenario.costi[targetKey]
 * a partire dai mesi BI di una commessa. Applica la modalità scelta dall'utente
 * (estendi / comprimi / as-is) per le categorie con Remaining oltre dataFineCommessa.
 */
function buildCommessaCostsFromBI(itemMesi, mode, dataFineCommessa) {
    // Raggruppa per categoriaId
    const byCat = {};
    for (const m of itemMesi) {
        if (!byCat[m.categoriaId]) byCat[m.categoriaId] = [];
        byCat[m.categoriaId].push(m);
    }

    const categorie = {};
    for (const [catId, mesi] of Object.entries(byCat)) {
        const catDef = getCostCategories().find(c => c.id === catId);
        const defaultCurva = catDef?.curvaDefault || 'uniforme';

        const acStorico = {};
        const remainingStorico = {}; // R0: distribuzione puntuale dal BI (preservata)
        let baselineCostoSum = 0;

        for (const m of mesi) {
            // AC e Remaining: salviamo i mesi con valore non-zero, anche negativo
            // (storni/correzioni reali del BI). Filtrare per > 0 farebbe perdere dati.
            if (m.ac && m.ac !== 0) acStorico[m.mese] = m.ac;
            if (m.remaining && m.remaining !== 0) remainingStorico[m.mese] = m.remaining;
            if (m.baselineCosto && m.baselineCosto !== 0) baselineCostoSum += m.baselineCosto;
        }

        // R1: dataInizio/dataFine derivate dall'unione AC + Remaining (mesi reali della categoria)
        const acMonths = Object.keys(acStorico);
        const remMonths = Object.keys(remainingStorico);
        const allMonths = [...new Set([...acMonths, ...remMonths])].sort();

        // R1: cutoffMese = ultimo mese con AC presente, anche negativo (null se categoria senza AC)
        let cutoffMese = null;
        for (const m of acMonths) {
            if (acStorico[m] !== 0 && (!cutoffMese || m > cutoffMese)) cutoffMese = m;
        }

        if (allMonths.length === 0) {
            // Categoria senza dati né AC né Remaining (skip o struttura vuota)
            categorie[catId] = {
                dataInizio: null,
                durata: 0,
                dataFine: null,
                cutoffMese: null,
                tipoCurva: defaultCurva,
                importoFuturo: 0,
                acStorico,
                remainingStorico: {},
                baselineCostoOriginale: baselineCostoSum || null,
                origine: 'bi_import',
            };
            continue;
        }

        let dataInizio = allMonths[0];
        let dataFine = allMonths[allMonths.length - 1];
        const importoFuturo = Object.values(remainingStorico).reduce((s, v) => s + v, 0);

        // Applica modalità di compressione (estendi non richiede aggiustamenti).
        // Compress → distribuzione puntuale "scollegata" perché valori oltre
        // dataFineCommessa devono essere ridistribuiti.
        let preservaDistribuzione = true;
        if (mode === 'comprimi' && dataFineCommessa && dataFine > dataFineCommessa) {
            dataFine = dataFineCommessa;
            if (dataInizio > dataFineCommessa) dataInizio = dataFineCommessa;
            preservaDistribuzione = false;
        }

        const durata = monthsBetween(dataInizio, dataFine);

        categorie[catId] = {
            dataInizio,
            durata,
            dataFine,
            cutoffMese, // R1: ultimo mese AC della categoria (null se no AC)
            tipoCurva: defaultCurva,
            importoFuturo,
            acStorico,
            remainingStorico: preservaDistribuzione ? remainingStorico : {},
            baselineCostoOriginale: baselineCostoSum || null,
            origine: 'bi_import',
        };
    }

    return { categorie };
}

/**
 * Calcola la "data fine" effettiva della commessa nello scenario corrente.
 * = ultimo mese con valore > 0 nei mesi sorgente (importedData per imported,
 * baseline per calculated). Pre-shift dell'inputs.
 */
function computeCommessaDataFineFromScenario(scenario, commessaKey, baseline) {
    const sourceMonths = getDataSourceMonths(scenario, commessaKey, baseline);
    if (sourceMonths.length === 0) return null;
    let max = sourceMonths[0].month;
    for (const m of sourceMonths) {
        if (m.month > max) max = m.month;
    }
    return max;
}

async function executeImport() {
    if (!_importState) return;
    const { scenarioId, parseResult, rows } = _importState;
    const toImport = rows.filter(r => r.selected && r.overrideKey);
    if (toImport.length === 0) {
        alert('Nessuna commessa selezionata con override valido. Seleziona almeno una commessa per importare.');
        return;
    }

    const scen = getScenario(scenarioId);
    if (!scen) { alert('Scenario non trovato.'); closeImportModal(); return; }
    if (scen.locked) { alert('Scenario bloccato. Sblocca prima di importare.'); closeImportModal(); return; }

    const baseline = getBaselineSafe();
    if (!baseline) { alert('Baseline ricavi non disponibile.'); return; }

    const newCosti = { ...(scen.costi || {}) };
    const importatedKeys = [];

    for (const item of toImport) {
        const targetKey = item.overrideKey;
        const dataFineCommessa = computeCommessaDataFineFromScenario(scen, targetKey, baseline);

        // Trova lastRemainingMonth tra TUTTE le categorie del file BI per questa commessa
        let lastRemMonth = '';
        for (const m of item.mesi) {
            if (m.remaining && m.remaining > 0 && m.mese > lastRemMonth) lastRemMonth = m.mese;
        }

        let mode = 'as-is';
        if (lastRemMonth && dataFineCommessa && lastRemMonth > dataFineCommessa) {
            // Conflict → chiedi all'utente
            mode = await askExtendOrCompress({
                codice: item.codiceBI,
                nome: item.nomeBI,
                dataFineCommessa,
                lastRemMonth,
            });
            if (mode === 'cancel') continue; // skip questa commessa
        }

        // Costruisci struttura e sovrascrivi (§7.5)
        const built = buildCommessaCostsFromBI(item.mesi, mode, dataFineCommessa);
        newCosti[targetKey] = {
            categorie: built.categorie,
        };
        importatedKeys.push(targetKey);
    }

    if (importatedKeys.length === 0) {
        alert('Nessuna commessa importata.');
        closeImportModal();
        return;
    }

    // Aggiorna bilImportMeta (dataImport, cutoff, file, commesse)
    const newBilImportMeta = {
        dataImport: new Date().toISOString(),
        cutoffMese: parseResult.meta.cutoffMese || null,
        userEmail: scen.bilImportMeta?.userEmail || null,
        commesseImportate: importatedKeys,
        fileName: parseResult.meta.fileName || null,
    };

    updateScenario(scenarioId, {
        costi: newCosti,
        bilImportMeta: newBilImportMeta,
    });

    closeImportModal();
    scheduleRender();
    alert(`Import completato: ${importatedKeys.length} commesse aggiornate.`);
}

function confirmImport() {
    // Async-safe wrapper: avvia il flusso senza bloccare il listener
    executeImport().catch(err => {
        console.error('[costi] Errore durante import:', err);
        alert('Errore durante l\'import: ' + err.message);
    });
}

function attachImportHandlers() {
    $('#cost-btn-import-bi')?.addEventListener('click', startBIImport);
    $('#cost-import-close')?.addEventListener('click', closeImportModal);
    $('#cost-import-cancel')?.addEventListener('click', closeImportModal);
    $('#cost-import-confirm')?.addEventListener('click', confirmImport);
    // Click sul backdrop chiude
    $('#cost-import-modal .modal-backdrop')?.addEventListener('click', closeImportModal);

    // Seleziona tutto / Deseleziona tutto: toggle batch su tutte le righe
    // (rispetta i constraint: deseleziona tutte; seleziona solo quelle con
    // override valido — quelle senza override non si possono importare).
    $('#cost-import-select-all')?.addEventListener('click', () => {
        if (!_importState) return;
        for (const row of _importState.rows) {
            if (row.overrideKey) row.selected = true;
        }
        renderImportModal();
    });
    $('#cost-import-deselect-all')?.addEventListener('click', () => {
        if (!_importState) return;
        for (const row of _importState.rows) row.selected = false;
        renderImportModal();
    });
}

// ─────────────────────────────────────────────────────
// Toolbar handlers (espandi/collassa tutto)
// ─────────────────────────────────────────────────────

/**
 * Azzera tutti i costi di TUTTE le commesse dello scenario corrente.
 * Azione distruttiva: imposta scenario.costi = {} (azzera completamente).
 * Tutti i totali vanno a 0, righe mostrano "— nessun dato —".
 * Per ripristinare: importa BI o usa Suggerisci sulle singole commesse.
 */
function azzeraTuttiCostiScenario() {
    if (isViewerReadOnly()) return;
    const scenarioId = getActiveScenarioIdFromDOM();
    if (!scenarioId) {
        alert('Nessuno scenario attivo selezionato.');
        return;
    }
    const scen = getScenario(scenarioId);
    if (!scen) return;
    if (scen.locked) {
        alert('Scenario bloccato. Sbloccalo prima di azzerare i costi.');
        return;
    }
    const baseline = getBaselineSafe();
    if (!baseline) {
        alert('Baseline non disponibile.');
        return;
    }
    // Pool commesse "viste" dallo scenario (non solo quelle già materializzate)
    const allCommesse = getCommesseForScenario(scen, baseline);
    if (allCommesse.length === 0) {
        alert('Nessuna commessa nel pool dello scenario.');
        return;
    }
    const numCommesseConDati = allCommesse.length;
    const ok1 = window.confirm(
        `🚨 ATTENZIONE — Azione distruttiva\n\n` +
        `Stai per AZZERARE gli importi di TUTTE le commesse dello scenario "${scen.name}".\n\n` +
        `${numCommesseConDati} commesse hanno attualmente dati costi:\n` +
        `  • AC storici (importati da BI) → AZZERATI\n` +
        `  • Distribuzione mensile puntuale BI → AZZERATA\n` +
        `  • Importi futuri di tutte le categorie → 0\n\n` +
        `Date di inizio/fine, durata e curva resteranno invariate.\n` +
        `L'operazione NON è reversibile via UI (salvo backup precedente).\n\n` +
        `Sei sicuro di voler procedere?`
    );
    if (!ok1) return;
    // Doppia conferma per sicurezza
    const ok2 = window.confirm(
        `Ultima conferma: vuoi davvero azzerare ${numCommesseConDati} commesse?\n\n` +
        `Click OK per procedere, Annulla per uscire.`
    );
    if (!ok2) return;

    // Per ogni commessa del POOL (anche non-materializzate, derivate da cold-start),
    // recupero la struttura corrente e azzero gli importi mantenendo date/curve.
    const allScenarios = listScenarios();
    const newCosti = {};
    for (const commessa of allCommesse) {
        const sourceMonths = getDataSourceMonths(scen, commessa.key, baseline);
        const fallback = getCostsForCommessa({
            scenario: scen,
            commessaKey: commessa.key,
            commessa,
            baselineMonths: sourceMonths,
            allScenarios,
        });
        if (!fallback.categorie || Object.keys(fallback.categorie).length === 0) {
            // Commessa senza struttura → salvo categorie vuote
            newCosti[commessa.key] = { categorie: {} };
            continue;
        }
        const newCategorie = {};
        for (const [catId, cat] of Object.entries(fallback.categorie)) {
            newCategorie[catId] = {
                ...cat,
                acStorico: {},
                remainingStorico: {},
                importoFuturo: 0,
                origine: 'manuale',
            };
        }
        newCosti[commessa.key] = { categorie: newCategorie };
    }
    updateScenario(scenarioId, { costi: newCosti });
    scheduleRender();
    alert(`Importi di ${numCommesseConDati} commesse azzerati (date e curve mantenute). Per ripristinare gli importi: importa BI o usa "Suggerisci" sulle singole commesse.`);
}

function attachToolbarHandlers() {
    $('#cost-btn-azzera-tutto')?.addEventListener('click', azzeraTuttiCostiScenario);
    $('#cost-chk-hide-empty')?.addEventListener('change', (e) => {
        saveHideEmpty(!!e.target.checked);
        scheduleRender();
    });
    $('#cost-btn-expand-all')?.addEventListener('click', () => {
        const cards = $$('#cost-commesse-container .cost-commessa-card');
        const set = loadExpanded();
        for (const card of cards) {
            card.classList.add('expanded');
            const body = card.querySelector('.cost-commessa-card-body');
            if (body) setHidden(body, false);
            if (card.dataset.commessaKey) set.add(card.dataset.commessaKey);
        }
        saveExpanded(set);
        // Re-render globale per ricreare grafici con dimensioni corrette
        scheduleRender();
    });
    $('#cost-btn-collapse-all')?.addEventListener('click', () => {
        const cards = $$('#cost-commesse-container .cost-commessa-card');
        const set = loadExpanded();
        for (const card of cards) {
            card.classList.remove('expanded');
            const body = card.querySelector('.cost-commessa-card-body');
            if (body) setHidden(body, true);
            if (card.dataset.commessaKey) set.delete(card.dataset.commessaKey);
        }
        saveExpanded(set);
        // Distruggi tutti i grafici (cards collapsed)
        destroyAllCharts();
    });
}

// ─────────────────────────────────────────────────────
// Watcher per re-render (filtri, scenario)
// ─────────────────────────────────────────────────────

function attachActiveScenarioWatcher() {
    const sel = $('#active-scenario-select');
    if (!sel) return;
    sel.addEventListener('change', () => {
        updateLockBanner();
        updateNoScenarioBanner();
        if (_currentSubpanel === 'costi') scheduleRender();
    });
    // Click sul tab Assumptions: aggiorna banner (es. dopo lock/unlock da gestione scenari)
    $('.tab-btn[data-tab="assumptions"]')?.addEventListener('click', () => {
        // Defer per assicurare che il pannello sia attivo
        requestAnimationFrame(() => {
            updateLockBanner();
            updateNoScenarioBanner();
        });
    });
}

/**
 * Trigger re-render unificato per i due punti di ingresso del modulo costi
 * (sub-tab Costi dentro Assumptions, e tab principale Comparison Costi).
 */
function maybeRerenderCosti() {
    if (_currentSubpanel === 'costi') scheduleRender();
    if (isCostiComparativoActive()) renderCostiComparativoContent();
}

function attachFilterWatchers() {
    // Osservo i 3 contenitori dei filtri globali per cambi della classe `.active`
    // sui chip. Passive observation, niente impatto sui listener esistenti.
    const observer = new MutationObserver(() => {
        maybeRerenderCosti();
    });
    for (const sel of ['#filter-settore', '#filter-type', '#filter-commessa']) {
        const c = $(sel);
        if (c) {
            observer.observe(c, {
                attributes: true,
                subtree: true,
                attributeFilter: ['class'],
            });
        }
    }

    // Filtri data: cattura modifiche utente diretto (change) + modifiche
    // programmatiche da pulsanti shortcut anno / reset filtri (click + defer rAF).
    for (const sel of ['#filter-date-from', '#filter-date-to']) {
        const el = $(sel);
        if (el) {
            el.addEventListener('change', () => maybeRerenderCosti());
        }
    }
    const deferredRerender = () => {
        requestAnimationFrame(() => maybeRerenderCosti());
    };
    $('#btn-reset-filters')?.addEventListener('click', deferredRerender);
    for (const btn of $$('.btn-year-shortcut')) {
        btn.addEventListener('click', deferredRerender);
    }
}

// ─────────────────────────────────────────────────────
// Snapshot costi al lock (P16)
// ─────────────────────────────────────────────────────

/**
 * Genera lo snapshot costi mensilizzato per uno scenario.
 * Chiamato da scenarioManager.lockScenario PRIMA di settare locked=true,
 * così i valori catturati riflettono lo stato esatto al momento del lock.
 *
 * Output: { [commessaKey]: { [categoriaId]: { [mese]: valore } } }
 * Ritorna null se non ci sono dati (no baseline, no commesse).
 *
 * IMPORTANTE: lavora su una "copia di lavoro" dello scenario forzando
 * locked=false e costiSnapshot=null per evitare di entrare nel bypass
 * di computeCategoriaMensile (che ritornerebbe lo snapshot precedente).
 */
function generateCostiSnapshot(scenarioRaw) {
    if (!scenarioRaw) return null;
    const baseline = getBaselineSafe();
    if (!baseline) return null;

    const allScenarios = listScenarios();
    const allCommesse = getCommesseForScenario(scenarioRaw, baseline);

    const snapshot = {};
    for (const commessa of allCommesse) {
        const sourceMonths = getDataSourceMonths(scenarioRaw, commessa.key, baseline);
        const fallback = getCostsForCommessa({
            scenario: scenarioRaw,
            commessaKey: commessa.key,
            commessa,
            baselineMonths: sourceMonths,
            allScenarios,
        });
        const cats = fallback.categorie || {};
        if (Object.keys(cats).length === 0) continue;

        // Scenario "virtuale" pre-lock per il calcolo mensile
        const virtualScenario = {
            ...scenarioRaw,
            locked: false,
            costiSnapshot: null,
            costi: {
                ...(scenarioRaw.costi || {}),
                [commessa.key]: { categorie: cats },
            },
        };

        const commessaSnap = {};
        for (const catDef of getCostCategories()) {
            if (!cats[catDef.id]) continue;
            const mensili = computeCategoriaMensile(virtualScenario, commessa.key, catDef.id, commessa);
            if (!mensili.length) continue;
            const catSnap = {};
            for (const m of mensili) {
                catSnap[m.mese] = m.valore;
            }
            commessaSnap[catDef.id] = catSnap;
        }
        if (Object.keys(commessaSnap).length > 0) {
            snapshot[commessa.key] = commessaSnap;
        }
    }

    return Object.keys(snapshot).length > 0 ? snapshot : null;
}

// ─────────────────────────────────────────────────────
// Tab principale "Costi" comparativo (P13 — vuoto, P14 popolato)
// ─────────────────────────────────────────────────────

function isCostiComparativoActive() {
    return $('#tab-costi-comparativo')?.classList.contains('active') === true;
}

function renderCostiComparativo() {
    const scenarioId = getActiveScenarioIdFromDOM();
    const scenario = scenarioId ? getScenario(scenarioId) : null;

    // Etichetta scenario attuale
    const labelAttuale = $('#costi-comp-scen-attuale');
    if (labelAttuale) {
        labelAttuale.textContent = scenario?.name || '— nessuno scenario attivo —';
    }

    // Popola dropdown confronto (tutti gli scenari ≠ attivo)
    const sel = $('#costi-comp-confronto-select');
    if (sel) {
        const allScenarios = listScenarios();
        const candidates = allScenarios.filter(s => s.id !== scenarioId);
        const previous = sel.value;
        sel.innerHTML = '<option value="">— seleziona scenario di confronto —</option>';
        for (const s of candidates) {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = s.name + (s.locked ? ' 🔒' : '');
            sel.appendChild(opt);
        }
        // Mantieni selezione precedente se ancora valida
        if (previous && candidates.some(s => s.id === previous)) {
            sel.value = previous;
        }
    }

    renderCostiComparativoContent();
}

/**
 * Calcola i dati aggregati del Conto Economico comparativo (P14).
 *
 * Pool commesse = unione delle commesse "viste" dai due scenari, filtrato dai
 * filtri globali (settore, tipo, commessa). Una commessa presente in uno solo
 * dei due scenari ha 0 nell'altro.
 *
 * @returns {{
 *   mesi: string[],              // tutti i mesi nel range filtri data
 *   categorie: Array<{id, label}>,
 *   attualeByCat: Object<catId, Object<mese, num>>,
 *   confrontoByCat: Object<catId, Object<mese, num>>,
 *   vdpAttuale: Object<mese, num>,
 *   vdpConfronto: Object<mese, num>,
 * }}
 */
function computeCostiComparativo(scenAttuale, scenConfronto, baseline) {
    const dateRange = getDateRangeFilter();
    const settori = getActiveChipValues('#filter-settore');
    const tipi = getActiveChipValues('#filter-type');
    const commesseChip = getActiveChipValues('#filter-commessa');

    const passFilters = (c) => {
        if (settori.length && !settori.includes(c.settore)) return false;
        if (tipi.length && !tipi.includes(c.type)) return false;
        if (commesseChip.length && !commesseChip.includes(c.key)) return false;
        return true;
    };

    // Pool commesse di ciascuno scenario, filtrato
    const commesseAttuale = getCommesseForScenario(scenAttuale, baseline).filter(passFilters);
    const commesseConfronto = getCommesseForScenario(scenConfronto, baseline).filter(passFilters);

    const allScenarios = listScenarios();

    // Aggregazione costi per scenario
    const aggregaScenario = (scen, commesse) => {
        const result = {};       // catId → mese → somma
        for (const commessa of commesse) {
            const sourceMonths = getDataSourceMonths(scen, commessa.key, baseline);
            const fallback = getCostsForCommessa({
                scenario: scen,
                commessaKey: commessa.key,
                commessa,
                baselineMonths: sourceMonths,
                allScenarios,
            });
            const cats = fallback.categorie || {};
            if (Object.keys(cats).length === 0) continue;
            const virtualScenario = {
                ...scen,
                costi: { ...(scen.costi || {}), [commessa.key]: { categorie: cats } },
            };
            for (const catDef of getCostCategories()) {
                if (!cats[catDef.id]) continue;
                const mensili = computeCategoriaMensile(virtualScenario, commessa.key, catDef.id, commessa);
                if (!result[catDef.id]) result[catDef.id] = {};
                for (const m of mensili) {
                    if (!inDateRange(m.mese, dateRange)) continue;
                    result[catDef.id][m.mese] = (result[catDef.id][m.mese] || 0) + (m.valore || 0);
                }
            }
        }
        return result;
    };

    const attualeByCat = aggregaScenario(scenAttuale, commesseAttuale);
    const confrontoByCat = aggregaScenario(scenConfronto, commesseConfronto);

    // VDP mensile per ogni scenario (riusa computeScenario esistente).
    // Filtri passati come previsto da scenarioEngine: settori/types/commesse + dateFrom/dateTo.
    const filtersForCompute = {
        settori,
        types: tipi,
        commesse: commesseChip,
        dateFrom: dateRange?.from || null,
        dateTo: dateRange?.to || null,
    };
    const computeVdpMap = (scen) => {
        try {
            const result = computeScenario(baseline.commesse || [], baseline.monthlyData, scen || {}, filtersForCompute);
            const map = {};
            for (const m of (result?.monthly || [])) {
                map[m.month] = m.scenarioVDP || 0;
            }
            return map;
        } catch (err) {
            console.warn('[costi] computeScenario failed for VDP aggregation:', err);
            return {};
        }
    };
    const vdpAttuale = computeVdpMap(scenAttuale);
    const vdpConfronto = computeVdpMap(scenConfronto);

    // Mesi: unione di tutti i mesi presenti nei dati (costi + VDP)
    const mesiSet = new Set();
    for (const cat of Object.values(attualeByCat)) for (const m of Object.keys(cat)) mesiSet.add(m);
    for (const cat of Object.values(confrontoByCat)) for (const m of Object.keys(cat)) mesiSet.add(m);
    for (const m of Object.keys(vdpAttuale)) mesiSet.add(m);
    for (const m of Object.keys(vdpConfronto)) mesiSet.add(m);
    const mesi = Array.from(mesiSet).sort();

    return {
        mesi,
        categorie: getCostCategories().map(c => ({ id: c.id, label: c.label })),
        attualeByCat,
        confrontoByCat,
        vdpAttuale,
        vdpConfronto,
    };
}

/** Formatta "YYYY-MM" come "MMM YY" (es. "2026-09" → "set 26"). */
const _MESI_BREVE = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];
function formatMeseBreve(yyyymm) {
    if (!yyyymm) return '';
    const [y, m] = yyyymm.split('-').map(Number);
    if (!_MESI_BREVE[m - 1]) return yyyymm;
    return `${_MESI_BREVE[m - 1]} ${String(y).slice(-2)}`;
}

/** Cella numerica con classe color per delta positivo/negativo. */
function deltaCell(val, asDelta = false) {
    const v = Math.round(Number(val) || 0);
    if (!asDelta) return `<td class="num">${formatCurrency(v)}</td>`;
    const cls = v > 0 ? 'delta-pos' : v < 0 ? 'delta-neg' : 'delta-zero';
    return `<td class="num ${cls}">${formatCurrency(v)}</td>`;
}

/** Costruisce HTML della tabella Conto Economico comparativo. */
function buildCostiComparativoTable(data, scenAttuale, scenConfronto) {
    const { mesi, categorie, attualeByCat, confrontoByCat, vdpAttuale, vdpConfronto } = data;

    if (mesi.length === 0) {
        return `<p style="padding:32px;text-align:center;color:var(--text-muted,#888);">
            Nessun dato disponibile per il range filtri corrente.
        </p>`;
    }

    // Etichette scenari
    const labelAtt = scenAttuale?.name || 'Scenario Attuale';
    const labelConf = scenConfronto?.name || 'Scenario di Confronto';

    // Cumulato per progressivo
    const cumAttuale = {};
    const cumConfronto = {};
    const cumVdpAttuale = {};
    const cumVdpConfronto = {};
    let runAttuale = {};
    let runConfronto = {};
    let runVdpA = 0;
    let runVdpC = 0;
    for (const mese of mesi) {
        // Per categoria
        for (const cat of categorie) {
            const aV = attualeByCat[cat.id]?.[mese] || 0;
            const cV = confrontoByCat[cat.id]?.[mese] || 0;
            runAttuale[cat.id] = (runAttuale[cat.id] || 0) + aV;
            runConfronto[cat.id] = (runConfronto[cat.id] || 0) + cV;
            if (!cumAttuale[cat.id]) cumAttuale[cat.id] = {};
            if (!cumConfronto[cat.id]) cumConfronto[cat.id] = {};
            cumAttuale[cat.id][mese] = runAttuale[cat.id];
            cumConfronto[cat.id][mese] = runConfronto[cat.id];
        }
        runVdpA += vdpAttuale[mese] || 0;
        runVdpC += vdpConfronto[mese] || 0;
        cumVdpAttuale[mese] = runVdpA;
        cumVdpConfronto[mese] = runVdpC;
    }

    // Header riga 1: super-headers (Mese + Progressivo per ciascun mese)
    const superHeaders = [
        '<th class="costi-comp-cat-col" rowspan="2">Categoria</th>',
        ...mesi.flatMap(m => {
            const lbl = formatMeseBreve(m);
            return [
                `<th class="costi-comp-mese-group" colspan="3">${escapeHtml(lbl)} mese</th>`,
                `<th class="costi-comp-prog-group" colspan="3">${escapeHtml(lbl)} progressivo</th>`,
            ];
        }),
    ].join('');

    // Header riga 2: sub-headers (Confronto | Attuale | Differenza × 2)
    const subHeaders = mesi.map(() =>
        `<th>${escapeHtml(labelConf)}</th>` +
        `<th>${escapeHtml(labelAtt)}</th>` +
        `<th>Δ</th>` +
        `<th>${escapeHtml(labelConf)}</th>` +
        `<th>${escapeHtml(labelAtt)}</th>` +
        `<th>Δ</th>`
    ).join('');

    // Riga RICAVO ACT (VDP)
    const ricavoRow = `
        <tr class="costi-comp-ricavo-row">
            <td class="costi-comp-cat-col">RICAVO (VDP)</td>
            ${mesi.flatMap(m => {
                const a = vdpAttuale[m] || 0;
                const c = vdpConfronto[m] || 0;
                const ca = cumVdpAttuale[m] || 0;
                const cc = cumVdpConfronto[m] || 0;
                return [
                    deltaCell(c),
                    deltaCell(a),
                    deltaCell(a - c, true),
                    deltaCell(cc),
                    deltaCell(ca),
                    deltaCell(ca - cc, true),
                ];
            }).join('')}
        </tr>
    `;

    // Righe categorie
    const totAttuale = {};
    const totConfronto = {};
    let runTotA = 0;
    let runTotC = 0;
    for (const m of mesi) {
        let sumA = 0, sumC = 0;
        for (const cat of categorie) {
            sumA += attualeByCat[cat.id]?.[m] || 0;
            sumC += confrontoByCat[cat.id]?.[m] || 0;
        }
        totAttuale[m] = sumA;
        totConfronto[m] = sumC;
    }

    const categoriaRows = categorie.map(cat => {
        // Skippa categorie con valori tutti zero (per ridurre rumore)
        const hasData = mesi.some(m =>
            (attualeByCat[cat.id]?.[m] || 0) !== 0 ||
            (confrontoByCat[cat.id]?.[m] || 0) !== 0
        );
        if (!hasData) return '';
        const cells = mesi.flatMap(m => {
            const a = attualeByCat[cat.id]?.[m] || 0;
            const c = confrontoByCat[cat.id]?.[m] || 0;
            const ca = cumAttuale[cat.id]?.[m] || 0;
            const cc = cumConfronto[cat.id]?.[m] || 0;
            return [
                deltaCell(c),
                deltaCell(a),
                deltaCell(a - c, true),
                deltaCell(cc),
                deltaCell(ca),
                deltaCell(ca - cc, true),
            ];
        }).join('');
        return `<tr>
            <td class="costi-comp-cat-col">${escapeHtml(cat.label)}</td>
            ${cells}
        </tr>`;
    }).filter(Boolean).join('');

    // Riga totale
    let runCumA = 0, runCumC = 0;
    const totaleRow = `
        <tr class="costi-comp-totale-row">
            <td class="costi-comp-cat-col">Totale costi</td>
            ${mesi.flatMap(m => {
                const a = totAttuale[m];
                const c = totConfronto[m];
                runCumA += a;
                runCumC += c;
                return [
                    deltaCell(c),
                    deltaCell(a),
                    deltaCell(a - c, true),
                    deltaCell(runCumC),
                    deltaCell(runCumA),
                    deltaCell(runCumA - runCumC, true),
                ];
            }).join('')}
        </tr>
    `;

    return `
        <div class="costi-comp-table-wrapper">
            <table class="costi-comp-table">
                <thead>
                    <tr>${superHeaders}</tr>
                    <tr>${subHeaders}</tr>
                </thead>
                <tbody>
                    ${ricavoRow}
                    ${categoriaRows}
                    ${totaleRow}
                </tbody>
            </table>
        </div>
    `;
}

function renderCostiComparativoContent() {
    const empty = $('#costi-comp-empty-state');
    const content = $('#costi-comp-content');
    const sel = $('#costi-comp-confronto-select');
    const confrontoId = sel?.value || '';

    if (!confrontoId) {
        setHidden(empty, false);
        setHidden(content, true);
        return;
    }
    setHidden(empty, true);
    setHidden(content, false);

    const scenarioId = getActiveScenarioIdFromDOM();
    const scenAttuale = scenarioId ? getScenario(scenarioId) : null;
    const scenConfronto = getScenario(confrontoId);
    const baseline = getBaselineSafe();

    if (!scenAttuale) {
        content.innerHTML = `<p style="padding:32px;text-align:center;color:var(--text-muted,#888);">
            Nessuno scenario attivo selezionato.</p>`;
        return;
    }
    if (!scenConfronto) {
        content.innerHTML = `<p style="padding:32px;text-align:center;color:var(--text-muted,#888);">
            Scenario di confronto non trovato.</p>`;
        return;
    }
    if (!baseline) {
        content.innerHTML = `<p style="padding:32px;text-align:center;color:var(--text-muted,#888);">
            Baseline ricavi non disponibile.</p>`;
        return;
    }

    const data = computeCostiComparativo(scenAttuale, scenConfronto, baseline);
    content.innerHTML = buildCostiComparativoTable(data, scenAttuale, scenConfronto);
}

/**
 * Esporta il Conto Economico comparativo in formato Excel (.xlsx) con stessa
 * struttura della tabella UI: super-header mese/progressivo, sub-header
 * Confronto/Attuale/Δ, riga RICAVO, righe categorie con dati, riga totale.
 */
function exportCostiComparativo() {
    const sel = $('#costi-comp-confronto-select');
    const confrontoId = sel?.value || '';
    if (!confrontoId) {
        alert('Seleziona uno scenario di confronto prima di esportare.');
        return;
    }
    const scenarioId = getActiveScenarioIdFromDOM();
    const scenAttuale = scenarioId ? getScenario(scenarioId) : null;
    const scenConfronto = getScenario(confrontoId);
    const baseline = getBaselineSafe();
    if (!scenAttuale || !scenConfronto || !baseline) {
        alert('Dati non disponibili per l\'export.');
        return;
    }

    const data = computeCostiComparativo(scenAttuale, scenConfronto, baseline);
    if (data.mesi.length === 0) {
        alert('Nessun dato da esportare per il range filtri corrente.');
        return;
    }

    const labelAtt = scenAttuale.name || 'Attuale';
    const labelConf = scenConfronto.name || 'Confronto';

    // Riga 1: super-header (Mese / Progressivo per ciascun mese, merged 3 colonne)
    const row1 = [''];
    for (const m of data.mesi) {
        const lbl = formatMeseBreve(m);
        row1.push(`${lbl} mese`, '', '', `${lbl} progressivo`, '', '');
    }
    // Riga 2: sub-header
    const row2 = ['Categoria'];
    for (let i = 0; i < data.mesi.length; i++) {
        row2.push(labelConf, labelAtt, 'Δ', labelConf, labelAtt, 'Δ');
    }

    // Riga RICAVO (VDP)
    let runVdpA = 0, runVdpC = 0;
    const ricavoRow = ['RICAVO (VDP)'];
    for (const m of data.mesi) {
        const a = data.vdpAttuale[m] || 0;
        const c = data.vdpConfronto[m] || 0;
        runVdpA += a;
        runVdpC += c;
        ricavoRow.push(c, a, a - c, runVdpC, runVdpA, runVdpA - runVdpC);
    }

    // Cumulati per categoria
    const cumA = {};
    const cumC = {};
    for (const cat of data.categorie) {
        cumA[cat.id] = {};
        cumC[cat.id] = {};
        let runA = 0, runC = 0;
        for (const m of data.mesi) {
            runA += data.attualeByCat[cat.id]?.[m] || 0;
            runC += data.confrontoByCat[cat.id]?.[m] || 0;
            cumA[cat.id][m] = runA;
            cumC[cat.id][m] = runC;
        }
    }

    // Righe categorie (skip categorie con tutto a zero)
    const catRows = [];
    for (const cat of data.categorie) {
        const hasData = data.mesi.some(m =>
            (data.attualeByCat[cat.id]?.[m] || 0) !== 0 ||
            (data.confrontoByCat[cat.id]?.[m] || 0) !== 0
        );
        if (!hasData) continue;
        const row = [cat.label];
        for (const m of data.mesi) {
            const a = data.attualeByCat[cat.id]?.[m] || 0;
            const c = data.confrontoByCat[cat.id]?.[m] || 0;
            const ca = cumA[cat.id][m];
            const cc = cumC[cat.id][m];
            row.push(c, a, a - c, cc, ca, ca - cc);
        }
        catRows.push(row);
    }

    // Riga totale
    let runTotA = 0, runTotC = 0;
    const totaleRow = ['Totale costi'];
    for (const m of data.mesi) {
        let sumA = 0, sumC = 0;
        for (const cat of data.categorie) {
            sumA += data.attualeByCat[cat.id]?.[m] || 0;
            sumC += data.confrontoByCat[cat.id]?.[m] || 0;
        }
        runTotA += sumA;
        runTotC += sumC;
        totaleRow.push(sumC, sumA, sumA - sumC, runTotC, runTotA, runTotA - runTotC);
    }

    const aoa = [row1, row2, ricavoRow, ...catRows, totaleRow];

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Merge super-header (3 colonne per "Mese", 3 colonne per "Progressivo")
    const merges = [];
    for (let i = 0; i < data.mesi.length; i++) {
        const startCol = 1 + i * 6;
        merges.push({ s: { r: 0, c: startCol }, e: { r: 0, c: startCol + 2 } });
        merges.push({ s: { r: 0, c: startCol + 3 }, e: { r: 0, c: startCol + 5 } });
    }
    ws['!merges'] = merges;

    // Larghezze colonne: prima 32 caratteri per categoria, 14 per ogni colonna numerica
    const cols = [{ wch: 32 }];
    for (let i = 0; i < data.mesi.length * 6; i++) cols.push({ wch: 14 });
    ws['!cols'] = cols;

    // Freeze: prima colonna + prime due righe (header)
    ws['!freeze'] = { xSplit: 1, ySplit: 2 };

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Conto Economico');

    // Nome file pulito
    const safe = (s) => String(s || '').replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 40);
    const today = new Date().toISOString().slice(0, 10);
    const fileName = `ConfrontoCosti_${safe(scenAttuale.name)}_vs_${safe(scenConfronto.name)}_${today}.xlsx`;

    XLSX.writeFile(wb, fileName);
}

function attachCostiComparativoTab() {
    const btn = $('#tab-btn-costi-comparativo');
    if (!btn) return;
    setHidden(btn, false);

    // Defer dopo il listener di setupTabs() di main.js (che attiva il pannello)
    btn.addEventListener('click', () => {
        requestAnimationFrame(() => {
            if (isCostiComparativoActive()) renderCostiComparativo();
        });
    });

    // Re-render al cambio scenario attivo (solo se il tab è attivo)
    $('#active-scenario-select')?.addEventListener('change', () => {
        if (isCostiComparativoActive()) renderCostiComparativo();
    });

    // Re-render del content al cambio dropdown confronto
    $('#costi-comp-confronto-select')?.addEventListener('change', () => {
        renderCostiComparativoContent();
    });

    // Pulsante export Excel
    $('#costi-comp-export-btn')?.addEventListener('click', () => {
        try {
            exportCostiComparativo();
        } catch (err) {
            console.error('[costi] export error:', err);
            alert('Errore durante l\'export: ' + err.message);
        }
    });
}

// ─────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────

export function initCostiUI() {
    if (_initialized) return;
    if (!WHATIF_COSTI_ENABLED) return;

    const nav = $('#cost-sub-nav');
    if (!nav) return;

    _initialized = true;
    setHidden(nav, false);
    attachSubNavHandlers();
    attachToolbarHandlers();
    attachActiveScenarioWatcher();
    attachFilterWatchers();
    attachEditHandler();
    attachImportHandlers();
    attachCostiComparativoTab();

    // Registra il provider per generare lo snapshot costi al lock scenario.
    // scenarioManager lo invocherà dentro lockScenario(); su unlock il snapshot
    // viene cancellato automaticamente.
    setCostiSnapshotProvider(generateCostiSnapshot);

    // Re-render quando l'admin modifica le categorie (P19)
    window.addEventListener('whatif:costCategoriesChanged', () => {
        if (_currentSubpanel === 'costi') scheduleRender();
        if (isCostiComparativoActive()) renderCostiComparativoContent();
    });

    showSubpanel('vdp');
    // Inizializza banner all'avvio (nasconde sub-pannelli se nessuno scenario)
    updateLockBanner();
    updateNoScenarioBanner();
}

// ── Auto-attivazione al caricamento del DOM ──
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initCostiUI, { once: true });
    } else {
        initCostiUI();
    }
}
