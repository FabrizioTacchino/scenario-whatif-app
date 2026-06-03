/**
 * analisiUI.js — tab "Analisi" con sub-nav per analisi multiple.
 *
 * Bottone 1: Costo Personale — Pianificato (da Risorse → Economics, costoProb)
 *            vs Modello (da Assunzioni Costi, categoria 'personale_diretto').
 *
 * Riusa funzioni esistenti:
 *   - resourceEngine.computeCommessaResources → costoProb pianificato
 *   - costi/costEngine.computeCategoriaMensile → costo modello per categoria
 *   - costi/costUI utility (filtri globali, getCommesseForScenario, ecc.)
 *
 * Tutto calcolato client-side al volo, niente schema Supabase.
 */

import * as XLSX from 'xlsx';
import { Chart } from 'chart.js';
import {
    getActiveScenarioIdFromDOM,
    getBaselineSafe,
    getCommesseForScenario,
    getDataSourceMonths,
    getDateRangeFilter,
    inDateRange,
    getFilteredCommesse,
} from '../costi/costUI.js';
import {
    computeCategoriaMensile,
    getCostsForCommessa,
} from '../costi/costEngine.js';
import { computeCommessaResources } from '../resourceEngine.js';
import { listScenarios, getScenario } from '../scenarioManager.js';

const HIDE_EMPTY_KEY = 'whatif_ana_hide_empty';
const PERSONALE_DIRETTO_ID = 'personale_diretto';

let _chart = null;
let _renderScheduled = false;
let _sortCol = 'commessa';   // 'commessa' | 'a' | 'b' | 'delta' | 'deltaPerc'
let _sortDir = 'asc';        // 'asc' | 'desc'

const fmtNum = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: 'always' });
const fmtPerc = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

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

function formatEuro(n) {
    if (!Number.isFinite(n)) return '€ 0';
    return `€ ${fmtNum.format(Math.round(n))}`;
}

function formatPerc(n) {
    if (!Number.isFinite(n)) return '—';
    return `${fmtPerc.format(n)}%`;
}

function loadHideEmpty() {
    try { return localStorage.getItem(HIDE_EMPTY_KEY) === '1'; } catch { return false; }
}
function saveHideEmpty(v) {
    try { localStorage.setItem(HIDE_EMPTY_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// Calcolo dati
// ─────────────────────────────────────────────────────

/**
 * Per ogni commessa visibile nel pool dello scenario attivo, calcola:
 *   - A: costoProb dal piano risorse (somma mesi nel range)
 *   - B: costo personale_diretto dal modello costi (somma mesi nel range)
 *   - delta = B - A
 *   - deltaPerc = (B - A) / A * 100  (oppure null se A == 0)
 *
 * Restituisce { rows: [...], totals: {a, b, delta, deltaPerc}, scenario, dateRange }
 * Oppure { rows: [], reason: 'no-scenario' | 'no-baseline' | 'no-pool' }
 */
function computeAnalisiCostoPersonale() {
    const scenarioId = getActiveScenarioIdFromDOM();
    if (!scenarioId) return { rows: [], reason: 'no-scenario' };

    const baseline = getBaselineSafe();
    if (!baseline) return { rows: [], reason: 'no-baseline' };

    const scenario = getScenario(scenarioId);
    if (!scenario) return { rows: [], reason: 'no-scenario' };

    const allCommesse = getCommesseForScenario(scenario, baseline);
    const pool = getFilteredCommesse(allCommesse);
    if (pool.length === 0) return { rows: [], reason: 'no-pool', scenario };

    const dateRange = getDateRangeFilter();
    const allScenarios = listScenarios();

    const rows = [];
    let totA = 0, totB = 0;

    for (const commessa of pool) {
        // ── A: Costo Pianificato (Risorse → Economics, costoProb) ──
        // computeCommessaResources già applica probabilità della commessa.
        const byMonth = computeCommessaResources(commessa.codice, scenarioId, allCommesse);
        let costoPianificato = 0;
        for (const [mese, cell] of byMonth) {
            if (inDateRange(mese, dateRange)) {
                costoPianificato += cell.costoProb || 0;
            }
        }

        // ── B: Costo Personale Diretto (modello costi) ──
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
        let costoModello = 0;
        const cat = (fallback.categorie || {})[PERSONALE_DIRETTO_ID];
        if (cat) {
            const mensili = computeCategoriaMensile(virtualScenario, commessa.key, PERSONALE_DIRETTO_ID, commessa);
            for (const m of mensili) {
                if (inDateRange(m.mese, dateRange)) {
                    costoModello += m.valore || 0;
                }
            }
        }

        const delta = costoModello - costoPianificato;
        const deltaPerc = costoPianificato !== 0 ? (delta / costoPianificato) * 100 : null;

        rows.push({
            commessa,
            costoPianificato,
            costoModello,
            delta,
            deltaPerc,
        });
        totA += costoPianificato;
        totB += costoModello;
    }

    const totDelta = totB - totA;
    const totDeltaPerc = totA !== 0 ? (totDelta / totA) * 100 : null;

    return {
        rows,
        totals: { a: totA, b: totB, delta: totDelta, deltaPerc: totDeltaPerc },
        scenario,
        dateRange,
    };
}

// ─────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────

function deltaCellHtml(delta, deltaPerc) {
    // Convenzione: positivo = verde (success), negativo = rosso (danger)
    const cls = delta > 0 ? 'ana-delta-pos' : delta < 0 ? 'ana-delta-neg' : 'ana-delta-zero';
    const sign = delta > 0 ? '+' : '';
    const percText = deltaPerc == null ? '—' : `${sign}${fmtPerc.format(deltaPerc)}%`;
    const eurText = `${sign}${fmtNum.format(Math.round(delta))}`;
    return { cls, eurText, percText };
}

function renderKpis(totals) {
    const wrap = $('#ana-kpi-row');
    if (!wrap) return;
    if (!totals) {
        wrap.innerHTML = '';
        return;
    }
    const d = deltaCellHtml(totals.delta, totals.deltaPerc);
    wrap.innerHTML = `
        <div class="ana-kpi">
            <span class="ana-kpi-label">Costo Pianificato HR (A)</span>
            <span class="ana-kpi-val">${formatEuro(totals.a)}</span>
            <span class="ana-kpi-hint">Risorse → Economics (probabilizzato)</span>
        </div>
        <div class="ana-kpi">
            <span class="ana-kpi-label">Costo Personale Diretto (B)</span>
            <span class="ana-kpi-val">${formatEuro(totals.b)}</span>
            <span class="ana-kpi-hint">Assunzioni Costi → categoria personale</span>
        </div>
        <div class="ana-kpi ana-kpi-accent">
            <span class="ana-kpi-label">Delta (B − A)</span>
            <span class="ana-kpi-val ${d.cls}">€ ${d.eurText}</span>
            <span class="ana-kpi-hint ${d.cls}">${d.percText}</span>
        </div>
    `;
}

function renderTable(rows, totals) {
    const wrap = $('#ana-table-wrapper');
    if (!wrap) return;
    if (!rows || rows.length === 0) {
        wrap.innerHTML = '<p class="ana-empty-text">Nessuna commessa visibile con i filtri correnti.</p>';
        return;
    }

    const trs = rows.map(r => {
        const d = deltaCellHtml(r.delta, r.deltaPerc);
        return `
            <tr>
                <td class="ana-cell-commessa">${escapeHtml(r.commessa.codice)} — ${escapeHtml(r.commessa.nome)}</td>
                <td class="ana-num">${formatEuro(r.costoPianificato)}</td>
                <td class="ana-num">${formatEuro(r.costoModello)}</td>
                <td class="ana-num ${d.cls}">€ ${d.eurText}</td>
                <td class="ana-num ${d.cls}">${d.percText}</td>
            </tr>`;
    }).join('');

    const totD = totals ? deltaCellHtml(totals.delta, totals.deltaPerc) : null;
    const totRow = totals ? `
        <tr class="ana-totale-row">
            <td class="ana-cell-commessa">Totale (${rows.length} commess${rows.length === 1 ? 'a' : 'e'})</td>
            <td class="ana-num">${formatEuro(totals.a)}</td>
            <td class="ana-num">${formatEuro(totals.b)}</td>
            <td class="ana-num ${totD.cls}">€ ${totD.eurText}</td>
            <td class="ana-num ${totD.cls}">${totD.percText}</td>
        </tr>` : '';

    const th = (col, label, num = false) => {
        const active = _sortCol === col;
        const arrow = active ? (_sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        const cls = ['ana-th-sort'];
        if (num) cls.push('ana-num');
        if (active) cls.push('ana-th-active');
        return `<th class="${cls.join(' ')}" data-anasort="${col}">${label}${arrow}</th>`;
    };

    wrap.innerHTML = `
        <table class="ana-table">
            <thead>
                <tr>
                    ${th('commessa', 'Commessa')}
                    ${th('a', 'A — Pianificato HR (Risorse)', true)}
                    ${th('b', 'B — Personale Diretto (Costi)', true)}
                    ${th('delta', 'Delta (B − A)', true)}
                    ${th('deltaPerc', 'Delta %', true)}
                </tr>
            </thead>
            <tbody>${trs}</tbody>
            <tfoot>${totRow}</tfoot>
        </table>
    `;
}

/**
 * Ordina rows in-place secondo lo stato sort corrente.
 */
function sortRows(rows) {
    const valOf = (r) => {
        switch (_sortCol) {
            case 'commessa': return (r.commessa.codice || '').toLowerCase();
            case 'a':         return r.costoPianificato || 0;
            case 'b':         return r.costoModello || 0;
            case 'delta':     return r.delta || 0;
            case 'deltaPerc': return r.deltaPerc == null ? -Infinity : r.deltaPerc;
            default:          return 0;
        }
    };
    rows.sort((x, y) => {
        const vx = valOf(x), vy = valOf(y);
        const cmp = typeof vx === 'number' ? vx - vy : String(vx).localeCompare(String(vy));
        return _sortDir === 'asc' ? cmp : -cmp;
    });
}

function destroyChart() {
    if (_chart) {
        try { _chart.destroy(); } catch { /* ignore */ }
        _chart = null;
    }
}

function renderChart(rows) {
    const canvas = $('#ana-chart-canvas');
    if (!canvas) return;
    destroyChart();
    if (!rows || rows.length === 0) return;

    const labels = rows.map(r => `${r.commessa.codice}`);
    const dataA = rows.map(r => Math.round(r.costoPianificato));
    const dataB = rows.map(r => Math.round(r.costoModello));

    _chart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'A — Pianificato (Risorse)',
                    data: dataA,
                    backgroundColor: 'rgba(99, 140, 255, 0.65)',
                    borderColor: 'rgba(99, 140, 255, 1)',
                    borderWidth: 1,
                },
                {
                    label: 'B — Personale Diretto (Costi)',
                    data: dataB,
                    backgroundColor: 'rgba(16, 185, 129, 0.65)',
                    borderColor: 'rgba(16, 185, 129, 1)',
                    borderWidth: 1,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                y: { beginAtZero: true, ticks: { callback: (v) => fmtNum.format(v) } },
                x: { ticks: { autoSkip: false, maxRotation: 60, minRotation: 30 } },
            },
            plugins: {
                legend: { position: 'top' },
                tooltip: {
                    callbacks: { label: (ctx) => `${ctx.dataset.label}: ${formatEuro(ctx.parsed.y)}` },
                },
            },
        },
    });
}

function render() {
    const result = computeAnalisiCostoPersonale();

    const empty = $('#ana-costo-personale-empty');
    const content = $('#ana-costo-personale-content');

    if (result.reason === 'no-scenario') {
        if (empty) {
            empty.innerHTML = '<p>Seleziona uno scenario attivo per visualizzare il confronto.</p>';
            setHidden(empty, false);
        }
        setHidden(content, true);
        destroyChart();
        return;
    }
    if (result.reason === 'no-baseline') {
        if (empty) {
            empty.innerHTML = '<p>Nessuna baseline ricavi caricata.</p>';
            setHidden(empty, false);
        }
        setHidden(content, true);
        destroyChart();
        return;
    }

    setHidden(empty, true);
    setHidden(content, false);

    let rows = result.rows;
    const hideEmpty = loadHideEmpty();
    if (hideEmpty) rows = rows.filter(r => r.costoPianificato !== 0 || r.costoModello !== 0);

    // Sync stato checkbox + counter
    const chk = $('#ana-chk-hide-empty');
    if (chk) chk.checked = hideEmpty;

    // Ordina in base allo stato sort corrente
    sortRows(rows);

    // Riconfigura totali post-filtro per coerenza con la riga totale e KPI
    let totA = 0, totB = 0;
    for (const r of rows) { totA += r.costoPianificato; totB += r.costoModello; }
    const totDelta = totB - totA;
    const totDeltaPerc = totA !== 0 ? (totDelta / totA) * 100 : null;
    const totals = { a: totA, b: totB, delta: totDelta, deltaPerc: totDeltaPerc };

    renderKpis(totals);
    renderChart(rows);
    renderTable(rows, totals);
}

function scheduleRender() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
        _renderScheduled = false;
        try { render(); } catch (err) { console.error('[analisiUI] render error:', err); }
    });
}

function isAnalisiTabActive() {
    return $('#tab-analisi-multi')?.classList.contains('active') === true;
}

// ─────────────────────────────────────────────────────
// Export Excel
// ─────────────────────────────────────────────────────

function exportExcel() {
    const result = computeAnalisiCostoPersonale();
    if (!result.rows || result.rows.length === 0) {
        alert('Nessun dato da esportare con i filtri correnti.');
        return;
    }
    let rows = result.rows;
    if (loadHideEmpty()) rows = rows.filter(r => r.costoPianificato !== 0 || r.costoModello !== 0);

    const aoa = [
        ['Commessa Codice', 'Commessa Nome', 'A — Pianificato (€)', 'B — Personale Diretto (€)', 'Delta (€)', 'Delta %'],
        ...rows.map(r => [
            r.commessa.codice,
            r.commessa.nome,
            Math.round(r.costoPianificato),
            Math.round(r.costoModello),
            Math.round(r.delta),
            r.deltaPerc == null ? '' : Number(r.deltaPerc.toFixed(2)),
        ]),
    ];
    let totA = 0, totB = 0;
    for (const r of rows) { totA += r.costoPianificato; totB += r.costoModello; }
    const totDelta = totB - totA;
    const totDeltaPerc = totA !== 0 ? Number(((totDelta / totA) * 100).toFixed(2)) : '';
    aoa.push(['', 'TOTALE', Math.round(totA), Math.round(totB), Math.round(totDelta), totDeltaPerc]);

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Costo Personale');

    const scenName = result.scenario?.name || 'scenario';
    const stamp = new Date().toISOString().slice(0, 10);
    const safeName = scenName.replace(/[^\w-]+/g, '_').slice(0, 40);
    XLSX.writeFile(wb, `Analisi_CostoPersonale_${safeName}_${stamp}.xlsx`);
}

// ─────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────

function attachListeners() {
    // Click su tab principale "Analisi" → render
    document.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.tab-btn[data-tab="analisi-multi"]');
        if (tabBtn) {
            requestAnimationFrame(() => scheduleRender());
        }
    }, true);

    // Sub-nav (per ora un solo bottone, ma struttura pronta per estensioni)
    document.addEventListener('click', (e) => {
        const subBtn = e.target.closest('.ana-sub-btn');
        if (!subBtn) return;
        const subnav = subBtn.closest('.ana-sub-nav');
        if (!subnav) return;
        for (const b of subnav.querySelectorAll('.ana-sub-btn')) {
            b.classList.toggle('active', b === subBtn);
        }
        const target = subBtn.dataset.anatab;
        const content = subBtn.closest('#tab-analisi-multi')?.querySelector('.ana-content');
        if (content) {
            for (const p of content.querySelectorAll('.ana-tab-panel')) {
                p.classList.toggle('active', p.id === `ana-tab-${target}`);
            }
        }
        scheduleRender();
    });

    // Toggle nascondi commesse vuote
    $('#ana-chk-hide-empty')?.addEventListener('change', (e) => {
        saveHideEmpty(!!e.target.checked);
        scheduleRender();
    });

    // Export Excel
    $('#btn-ana-export-excel')?.addEventListener('click', exportExcel);

    // Cambio scenario attivo
    $('#active-scenario-select')?.addEventListener('change', () => {
        if (isAnalisiTabActive()) scheduleRender();
    });

    // Filtri data globali (input month "DA"/"A")
    $('#filter-date-from')?.addEventListener('change', () => {
        if (isAnalisiTabActive()) scheduleRender();
    });
    $('#filter-date-to')?.addEventListener('change', () => {
        if (isAnalisiTabActive()) scheduleRender();
    });

    // Filtri chip (settore, tipo, commessa) e bottone reset filtri.
    // Usiamo click delegato perché i chip possono essere ricreati dinamicamente.
    document.addEventListener('click', (e) => {
        const chip = e.target.closest('#filter-settore .filter-chip, #filter-type .filter-chip, #filter-commessa .filter-chip, #btn-reset-filters');
        if (!chip) return;
        if (isAnalisiTabActive()) requestAnimationFrame(() => scheduleRender());
    });

    // Shortcut anno (.btn-year-shortcut: settano programmaticamente i filter-date-*).
    // L'evento "change" su input non scatta se il valore viene impostato via JS,
    // quindi dobbiamo intercettare il click sui bottoni.
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-year-shortcut');
        if (!btn) return;
        if (isAnalisiTabActive()) requestAnimationFrame(() => scheduleRender());
    });

    // Click su header tabella → sort
    document.addEventListener('click', (e) => {
        const th = e.target.closest('.ana-table th.ana-th-sort');
        if (!th) return;
        const col = th.dataset.anasort;
        if (!col) return;
        if (_sortCol === col) {
            _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            _sortCol = col;
            _sortDir = (col === 'commessa') ? 'asc' : 'desc';
        }
        scheduleRender();
    });

    // Eventi custom esistenti che indicano cambiamenti dati
    window.addEventListener('whatif:scenariosOrderChanged', () => {
        if (isAnalisiTabActive()) scheduleRender();
    });
    window.addEventListener('whatif:costCategoriesChanged', () => {
        if (isAnalisiTabActive()) scheduleRender();
    });
}

// ─────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachListeners, { once: true });
    } else {
        attachListeners();
    }
}
