/**
 * resourceUI.js — Interfaccia utente del modulo risorse
 * Inizializzato da main.js — non interferisce con il modulo esistente.
 */

import * as XLSX from 'xlsx';
import {
    listPersone, getPersona, savePersona, deletePersona,
    listAllocazioni, getAllocazione, saveAllocazione, deleteAllocazione,
    copyAllocazioniScenario, deleteAllocazioniScenario,
    importPersoneFromRows, importAllocazioniFromRows,
    getMonthsInRange, isMonthInRange,
    formatYM, formatEuro, excelSerialToYM, checkWarnings, addMonths,
    listRuoli, saveRuolo, deleteRuolo, syncRuoliFromPersone, renameRuolo,
} from './resourceManager.js';
import {
    computeResourceMatrix,
    computeSaturationSummary,
    computeCommessaResources,
    computeResourceKpis,
    computeCostoPersonaleTotale,
    computeCostoPersonaleMensile,
} from './resourceEngine.js';
import { trackDeletion } from './syncManager.js';
import { Chart } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';

// ─── Focus fix for Electron after native dialogs ────────────
function _restoreFocus() {
    const fix = () => {
        if (window.electronAPI?.focusWindow) window.electronAPI.focusWindow();
        const tmp = document.createElement('input');
        tmp.style.cssText = 'position:fixed;top:-100px;left:-100px;opacity:0;width:1px;height:1px;';
        document.body.appendChild(tmp);
        tmp.focus();
        requestAnimationFrame(() => { tmp.blur(); tmp.remove(); });
    };
    setTimeout(fix, 100);
    setTimeout(fix, 300);
}

// ─── Context (provided by main.js) ──────────────────────────
let _ctx = null;

/** Deriva lo stato attivo dalla dataTermine rispetto al mese corrente */
function _isPersonaAttiva(p) {
    if (!p) return false;
    if (!p.dataTermine) return true;
    const oggi = new Date().toISOString().slice(0, 7);
    return p.dataTermine.slice(0, 7) >= oggi;
}

// ─── Internal state ──────────────────────────────────────────
let _currentSubTab = 'persone';
let _selectedPersonaId = null;
let _personaSearch = '';
let _editingPersonaId = null;
let _editingAllocId = null;
let _allocScenario = '__current__';
let _allocPersonaSearch = '';   // text search persona in Pianificazione
let _personaSortCol = 'cognome';
let _personaSortDir = 'asc';    // 'asc' | 'desc'
let _pianifSortCol = 'persona';
let _pianifSortDir = 'asc';
let _ruoliSortCol = 'codice';
let _ruoliSortDir = 'asc';
let _capacityPersonaId = '';    // filtro persona in Capacity
let _capacitySortCol = 'persona'; // 'persona' | 'ruolo'
let _capacitySortDir = 'asc';
let _resFilterAlloc = 'all'; // 'all' | 'con' | 'senza'
let _personaStatusFilter = null; // null | 'attive' | 'scadenza' | 'cessate'
let _capacityCharts = {};   // Chart.js instances for capacity tab
let _importData = null;
let _importTipo = 'persone';

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// ─── INIT ────────────────────────────────────────────────────

export function initResourceModule(ctx) {
    _ctx = ctx;
    _setupSubTabs();
    _setupModals();
    _injectDuplicateCheckbox();
    document.addEventListener('click', e => {
        if (e.target.closest('#btn-res-export-excel')) _exportRisorse();
    });
}

export function renderResourceTab() {
    _renderSubTab(_currentSubTab);
}

/** Chiamato da main.js dopo duplicazione scenario */
export function onScenarioDuplicated(newId, sourceId) {
    const chk = $('#chk-copy-allocazioni');
    if (chk?.checked && newId && sourceId) {
        const n = copyAllocazioniScenario(sourceId, newId);
        if (n > 0) _showToast(`Copiate ${n} allocazioni al nuovo scenario`);
    }
    if (chk) chk.checked = false;
}

function _resolveScenarioId() {
    if (_allocScenario === '__current__') return _ctx.getActiveScenarioId();
    if (_allocScenario === '__baseline__') return null;
    return _allocScenario || _ctx.getActiveScenarioId();
}

/** Commesse selezionate nella sidebar ([] = tutte) */
function _resolveSelectedCommesse() {
    return _ctx.getSelectedCommesse ? _ctx.getSelectedCommesse() : [];
}

/** Badge HTML che mostra il filtro commessa attivo dalla sidebar */
function _sidebarCommessaBadge(selectedCodes, commesse) {
    if (!selectedCodes.length) return `<span class="res-sidebar-badge res-sidebar-badge--all">Tutte le commesse</span>`;
    const names = selectedCodes.map(cod => {
        const c = commesse.find(x => x.codice === cod);
        return c ? `<span class="res-sidebar-chip" title="${c.nome}">${cod}</span>` : `<span class="res-sidebar-chip">${cod}</span>`;
    });
    return `<span class="res-sidebar-badge">${names.join('')}</span>`;
}

// ─── SUB-TABS ────────────────────────────────────────────────

function _setupSubTabs() {
    document.addEventListener('click', e => {
        const btn = e.target.closest('.res-sub-btn');
        if (!btn || !btn.dataset.restab) return;
        _currentSubTab = btn.dataset.restab;
        $$('.res-sub-btn').forEach(b => b.classList.toggle('active', b.dataset.restab === _currentSubTab));
        $$('.res-tab-panel').forEach(p => p.classList.toggle('active', p.id === `res-tab-${_currentSubTab}`));
        _renderSubTab(_currentSubTab);
    });
}

function _renderSubTab(tab) {
    if (tab === 'ruoli')         _renderRuoli();
    else if (tab === 'persone')       _renderPersone();
    else if (tab === 'pianificazione') _renderPianificazione();
    else if (tab === 'commesse') _renderCommesseRisorse();
    else if (tab === 'capacity') _renderCapacity();
}

// ─── RUOLI TAB ──────────────────────────────────────────────

function _renderRuoli() {
    const panel = $('#res-tab-ruoli');
    if (!panel) return;

    // Auto-sync roles from existing persone on first render
    syncRuoliFromPersone();

    const persone = listPersone();

    // Count persone per ruolo
    const countPerRuolo = {};
    for (const p of persone) {
        const r = (p.ruolo || '').trim().toLowerCase();
        if (r) countPerRuolo[r] = (countPerRuolo[r] || 0) + 1;
    }

    // Sort
    const ruoli = listRuoli().sort((a, b) => {
        let va, vb;
        switch (_ruoliSortCol) {
            case 'codice': va = a.codice || ''; vb = b.codice || ''; break;
            case 'nome': va = a.nome || ''; vb = b.nome || ''; break;
            case 'tipo': va = a.tipo || ''; vb = b.tipo || ''; break;
            case 'costo': return _ruoliSortDir === 'asc' ? (a.costoMedio || 0) - (b.costoMedio || 0) : (b.costoMedio || 0) - (a.costoMedio || 0);
            case 'persone': {
                const ca = countPerRuolo[a.nome.toLowerCase()] || 0;
                const cb = countPerRuolo[b.nome.toLowerCase()] || 0;
                return _ruoliSortDir === 'asc' ? ca - cb : cb - ca;
            }
            default: va = a.codice || ''; vb = b.codice || '';
        }
        const cmp = String(va).localeCompare(String(vb));
        return _ruoliSortDir === 'asc' ? cmp : -cmp;
    });
    const sortIcon = (col) => _ruoliSortCol === col ? (_ruoliSortDir === 'asc' ? ' ▲' : ' ▼') : '';

    const necessari = ruoli.filter(r => (r.tipo || 'necessario') === 'necessario').length;
    const opzionali = ruoli.length - necessari;

    panel.innerHTML = `
        <div class="res-toolbar">
            <div style="font-size:13px;color:var(--text-muted);">${ruoli.length} ruoli (${necessari} necessari, ${opzionali} opzionali)</div>
            <div class="res-toolbar-right">
                <button id="btn-res-sync-ruoli" class="btn btn-outline btn-sm" title="Importa ruoli dalle persone esistenti">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    Sincronizza da Persone
                </button>
            </div>
        </div>

        <div class="res-ruoli-add-row">
            <input type="text" id="res-ruolo-new-codice" class="res-search-input" placeholder="Codice (es. 01A)" style="flex:0 0 100px;max-width:100px;" />
            <input type="text" id="res-ruolo-new-nome" class="res-search-input" placeholder="Nome ruolo..." style="flex:2;" />
            <select id="res-ruolo-new-tipo" class="res-search-input" style="flex:0 0 130px;max-width:130px;">
                <option value="necessario">Necessario</option>
                <option value="opzionale">Opzionale</option>
            </select>
            <input type="number" id="res-ruolo-new-costo" class="res-search-input" placeholder="Costo medio/mese" min="0" step="100" style="flex:1;max-width:160px;" />
            <button id="btn-res-add-ruolo" class="btn btn-primary btn-sm">Aggiungi Ruolo</button>
        </div>
        <div id="res-ruolo-error" style="color:var(--danger);font-size:12px;margin:4px 0 8px;min-height:16px;"></div>

        ${ruoli.length === 0 ? `
            <div class="res-empty-state" style="padding:40px 0;">
                <h3>Nessun ruolo definito</h3>
                <p>Aggiungi ruoli manualmente oppure clicca "Sincronizza da Persone" per importarli automaticamente.</p>
            </div>
        ` : `
        <div class="table-container">
            <table class="res-table">
                <thead><tr>
                    <th class="res-ruoli-sort" style="width:80px;cursor:pointer;" data-sort="codice">Codice${sortIcon('codice')}</th>
                    <th class="res-ruoli-sort" style="cursor:pointer;" data-sort="nome">Ruolo${sortIcon('nome')}</th>
                    <th class="res-ruoli-sort" style="width:110px;cursor:pointer;" data-sort="tipo">Tipo${sortIcon('tipo')}</th>
                    <th class="res-ruoli-sort col-num" style="cursor:pointer;" data-sort="costo">Costo Medio/Mese${sortIcon('costo')}</th>
                    <th class="res-ruoli-sort col-num" style="cursor:pointer;" data-sort="persone">Persone${sortIcon('persone')}</th>
                    <th style="width:80px;"></th>
                </tr></thead>
                <tbody>
                    ${ruoli.map(r => {
                        const count = countPerRuolo[r.nome.toLowerCase()] || 0;
                        const costoFmt = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: true }).format(Math.round(r.costoMedio)) + ' €';
                        const tipo = r.tipo || 'necessario';
                        return `
                        <tr data-ruolo-id="${r.id}" data-old-nome="${r.nome}" data-costo-raw="${r.costoMedio}">
                            <td>
                                <input type="text" class="res-ruolo-edit-codice" value="${r.codice || ''}" style="border:none;background:transparent;font-size:13px;width:100%;color:var(--text-muted);font-weight:600;" placeholder="—" />
                            </td>
                            <td>
                                <input type="text" class="res-ruolo-edit-nome" value="${r.nome}" style="border:none;background:transparent;font-size:13px;width:100%;color:var(--text);" />
                            </td>
                            <td>
                                <select class="res-ruolo-edit-tipo" style="border:none;background:transparent;font-size:12px;color:var(--text);cursor:pointer;">
                                    <option value="necessario" ${tipo === 'necessario' ? 'selected' : ''}>Necessario</option>
                                    <option value="opzionale" ${tipo === 'opzionale' ? 'selected' : ''}>Opzionale</option>
                                </select>
                            </td>
                            <td class="col-num">
                                <span class="res-ruolo-costo-display" style="cursor:pointer;font-size:13px;" title="Clicca per modificare">${costoFmt}</span>
                                <input type="number" class="res-ruolo-edit-costo" value="${r.costoMedio}" min="0" step="100" style="display:none;border:1px solid var(--border);background:var(--bg-2);font-size:13px;width:110px;text-align:right;color:var(--text);border-radius:4px;padding:2px 4px;" />
                            </td>
                            <td class="col-num">${count}</td>
                            <td style="text-align:right;">
                                <button class="btn btn-ghost btn-xs btn-save-ruolo" title="Salva modifiche">💾</button>
                                <button class="btn btn-ghost btn-xs btn-apply-costo-ruolo" title="Applica costo a tutte le persone con questo ruolo" ${count === 0 ? 'disabled style="opacity:.4;cursor:not-allowed;"' : ''}>💰</button>
                                <button class="btn btn-ghost btn-xs btn-delete-ruolo" title="Elimina ruolo" ${count > 0 ? 'disabled style="opacity:.4;cursor:not-allowed;"' : ''}>🗑</button>
                            </td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`}
    `;

    // Events
    $('#btn-res-add-ruolo')?.addEventListener('click', () => {
        const codice = $('#res-ruolo-new-codice')?.value.trim();
        const nome = $('#res-ruolo-new-nome')?.value.trim();
        const tipo = $('#res-ruolo-new-tipo')?.value || 'necessario';
        const costo = Number($('#res-ruolo-new-costo')?.value) || 0;
        const errEl = $('#res-ruolo-error');
        if (!nome) { errEl.textContent = 'Inserisci il nome del ruolo.'; return; }
        const result = saveRuolo({ nome, codice, tipo, costoMedio: costo });
        if (result?.error) { errEl.textContent = result.error; return; }
        _renderRuoli();
    });

    $('#btn-res-sync-ruoli')?.addEventListener('click', () => {
        const added = syncRuoliFromPersone();
        if (added > 0) {
            _renderRuoli();
            _showToast(`${added} ruoli importati dalle persone`);
        } else {
            _showToast('Nessun nuovo ruolo da importare');
        }
    });

    panel.querySelectorAll('.btn-save-ruolo').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = tr.dataset.ruoloId;
            const oldNome = tr.dataset.oldNome;
            const codice = tr.querySelector('.res-ruolo-edit-codice').value.trim();
            const nome = tr.querySelector('.res-ruolo-edit-nome').value.trim();
            const tipo = tr.querySelector('.res-ruolo-edit-tipo').value;
            const costoMedio = Number(tr.querySelector('.res-ruolo-edit-costo').value) || 0;
            if (!nome) return;
            // Se il nome è cambiato, rinomina anche le persone
            if (nome !== oldNome) {
                const updated = renameRuolo(id, nome);
                if (updated > 0) alert(`Ruolo rinominato: ${updated} person${updated === 1 ? 'a aggiornata' : 'e aggiornate'}.`);
            }
            saveRuolo({ id, codice, tipo, costoMedio });
            _renderRuoli();
        });
    });

    panel.querySelectorAll('.btn-delete-ruolo').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = tr.dataset.ruoloId;
            if (!confirm('Eliminare questo ruolo?')) { _restoreFocus(); return; }
            deleteRuolo(id);
            _renderRuoli();
        });
    });

    // Apply cost to all persone with this role
    panel.querySelectorAll('.btn-apply-costo-ruolo').forEach(btn => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = tr.dataset.ruoloId;
            const nome = tr.querySelector('.res-ruolo-edit-nome').value.trim();
            const costoMedio = Number(tr.querySelector('.res-ruolo-edit-costo').value) || 0;
            const personeRuolo = listPersone().filter(p => p.ruolo?.toLowerCase() === nome.toLowerCase());
            if (!personeRuolo.length) return;
            if (!confirm(`Aggiornare il costo di ${personeRuolo.length} person${personeRuolo.length === 1 ? 'a' : 'e'} con ruolo "${nome}" a ${formatEuro(costoMedio)}?`)) return;
            for (const p of personeRuolo) {
                savePersona({ id: p.id, costoMedioMese: costoMedio }, 'aggiornamento_costo_ruolo');
            }
            alert(`${personeRuolo.length} person${personeRuolo.length === 1 ? 'a aggiornata' : 'e aggiornate'}.`);
            _renderRuoli();
        });
    });

    // Sort columns
    panel.querySelectorAll('.res-ruoli-sort').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (_ruoliSortCol === col) {
                _ruoliSortDir = _ruoliSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _ruoliSortCol = col;
                _ruoliSortDir = 'asc';
            }
            _renderRuoli();
        });
    });

    // Click-to-edit on cost display
    panel.querySelectorAll('.res-ruolo-costo-display').forEach(span => {
        span.addEventListener('click', () => {
            const input = span.nextElementSibling;
            span.style.display = 'none';
            input.style.display = '';
            input.focus();
            input.select();
        });
    });
    panel.querySelectorAll('.res-ruolo-edit-costo').forEach(input => {
        input.addEventListener('blur', () => {
            const span = input.previousElementSibling;
            span.textContent = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: true }).format(Math.round(Number(input.value) || 0)) + ' €';
            input.style.display = 'none';
            span.style.display = '';
        });
    });
}

// ─── PERSONE TAB ─────────────────────────────────────────────

function _renderPersone() {
    const panel = $('#res-tab-persone');
    if (!panel) return;

    const persone = listPersone();
    const q = _personaSearch.toLowerCase();
    let filtered = q
        ? persone.filter(p => `${p.cognome} ${p.nome} ${p.ruolo || ''} ${p.bu || ''}`.toLowerCase().includes(q))
        : persone;

    // Apply status filter from KPI clicks
    const _meseOggi = new Date().toISOString().slice(0, 7);
    if (_personaStatusFilter === 'attive') {
        filtered = filtered.filter(p => !p.dataTermine || p.dataTermine.slice(0, 7) >= _meseOggi);
    } else if (_personaStatusFilter === 'scadenza') {
        filtered = filtered.filter(p => p.dataTermine && p.dataTermine.slice(0, 7) >= _meseOggi);
    } else if (_personaStatusFilter === 'cessate') {
        filtered = filtered.filter(p => p.dataTermine && p.dataTermine.slice(0, 7) < _meseOggi);
    } else if (_personaStatusFilter === 'ingresso') {
        filtered = filtered.filter(p => p.statoAssunzione === 'in_ingresso' && p.dataAssunzione?.slice(0, 7) > _meseOggi);
    } else if (_personaStatusFilter === 'ricercare') {
        filtered = filtered.filter(p => p.statoAssunzione === 'da_ricercare' && p.dataAssunzione?.slice(0, 7) > _meseOggi);
    }

    const scenarioId = _ctx.getActiveScenarioId();
    const allocCounts = {};
    listAllocazioni({ scenarioId }).forEach(a => { allocCounts[a.personaId] = (allocCounts[a.personaId] || 0) + 1; });

    // KPI persone
    const meseCorrente = new Date().toISOString().slice(0, 7);
    const totale = persone.length;
    const cessate = persone.filter(p => p.dataTermine && p.dataTermine.slice(0, 7) < meseCorrente).length;
    const inScadenza = persone.filter(p => p.dataTermine && p.dataTermine.slice(0, 7) >= meseCorrente).length;
    const numIngresso = persone.filter(p => p.statoAssunzione === 'in_ingresso' && p.dataAssunzione?.slice(0, 7) > meseCorrente).length;
    const numRicercare = persone.filter(p => p.statoAssunzione === 'da_ricercare' && p.dataAssunzione?.slice(0, 7) > meseCorrente).length;
    const attive = totale - cessate;
    const prossimaScadenza = persone
        .filter(p => p.dataTermine && p.dataTermine.slice(0, 7) >= meseCorrente)
        .map(p => p.dataTermine.slice(0, 7))
        .sort()[0] || null;

    // ── Sort ──────────────────────────────────────────────────
    const sortVal = (p) => {
        switch (_personaSortCol) {
            case 'cognome':   return `${p.cognome} ${p.nome}`.toLowerCase();
            case 'ruolo':     return (p.ruolo || '').toLowerCase();
            case 'bu':        return (p.bu || '').toLowerCase();
            case 'contratto': return (p.tipoContratto || '').toLowerCase();
            case 'costo':       return p.costoMedioMese || 0;
            case 'comm':        return allocCounts[p.id] || 0;
            case 'stato':       return _isPersonaAttiva(p) ? 0 : 1;
            case 'assunzione':  return p.dataAssunzione || '';
            case 'termine':     return p.dataTermine || '';
            default:            return '';
        }
    };
    const sorted = [...filtered].sort((a, b) => {
        const va = sortVal(a), vb = sortVal(b);
        const cmp = typeof va === 'number' ? va - vb : va.localeCompare(vb);
        return _personaSortDir === 'asc' ? cmp : -cmp;
    });

    const thSort = (col, label, cls = '') => {
        const active = _personaSortCol === col;
        const arrow = active ? (_personaSortDir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<th class="res-th-sort${active ? ' res-th-active' : ''}${cls ? ' '+cls : ''}" data-sort="${col}">${label}${arrow}</th>`;
    };

    panel.innerHTML = `
        <div class="res-toolbar">
            <div class="res-search-wrap">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input type="text" id="res-persona-search" class="res-search-input" placeholder="Cerca per nome, ruolo, BU..." value="${_personaSearch}" />
            </div>
            <div class="res-toolbar-right">
                <button id="btn-res-add-persona" class="btn btn-primary btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Aggiungi Persona
                </button>
                <button id="btn-res-import-persone" class="btn btn-outline btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Importa Excel
                </button>
            </div>
        </div>

        ${persone.length === 0 ? _emptyState(
            'Nessuna persona inserita',
            'Aggiungi persone manualmente oppure importa un file Excel per iniziare.',
            'btn-res-add-persona'
        ) : `
        <div class="res-capacity-kpis" style="margin-bottom:12px;">
            <div class="res-kpi-mini res-kpi-clickable${_personaStatusFilter === null ? ' res-kpi-selected' : ''}" data-status-filter="">
                <span class="res-kpi-label">Persone totali</span>
                <span class="res-kpi-val">${totale}</span>
            </div>
            <div class="res-kpi-mini accent res-kpi-clickable${_personaStatusFilter === 'attive' ? ' res-kpi-selected' : ''}" data-status-filter="attive">
                <span class="res-kpi-label">Attive</span>
                <span class="res-kpi-val">${attive}</span>
            </div>
            <div class="res-kpi-mini ${inScadenza > 0 ? 'warning' : ''} res-kpi-clickable${_personaStatusFilter === 'scadenza' ? ' res-kpi-selected' : ''}" data-status-filter="scadenza">
                <span class="res-kpi-label">In scadenza</span>
                <span class="res-kpi-val">${inScadenza}</span>
            </div>
            <div class="res-kpi-mini res-kpi-clickable${_personaStatusFilter === 'cessate' ? ' res-kpi-selected' : ''}" data-status-filter="cessate">
                <span class="res-kpi-label">Cessate</span>
                <span class="res-kpi-val">${cessate}</span>
            </div>
            ${numIngresso > 0 ? `<div class="res-kpi-mini res-kpi-clickable${_personaStatusFilter === 'ingresso' ? ' res-kpi-selected' : ''}" data-status-filter="ingresso" style="border-left:2px solid #3b82f6;">
                <span class="res-kpi-label">In ingresso</span>
                <span class="res-kpi-val" style="color:#3b82f6;">${numIngresso}</span>
            </div>` : ''}
            ${numRicercare > 0 ? `<div class="res-kpi-mini res-kpi-clickable${_personaStatusFilter === 'ricercare' ? ' res-kpi-selected' : ''}" data-status-filter="ricercare" style="border-left:2px solid #f59e0b;">
                <span class="res-kpi-label">Da ricercare</span>
                <span class="res-kpi-val" style="color:#f59e0b;">${numRicercare}</span>
            </div>` : ''}
            ${prossimaScadenza ? `<div class="res-kpi-mini warning">
                <span class="res-kpi-label">Prossima scadenza</span>
                <span class="res-kpi-val">${formatYM(prossimaScadenza)}</span>
            </div>` : ''}
        </div>
        <div class="res-count-bar">
            <span>${filtered.length} di ${persone.length} ${persone.length === 1 ? 'persona' : 'persone'}</span>
        </div>
        <div class="table-container">
            <table class="res-table">
                <thead><tr>
                    ${thSort('cognome', 'Cognome e Nome')}
                    ${thSort('ruolo', 'Ruolo')}
                    ${thSort('bu', 'BU / CDC')}
                    ${thSort('contratto', 'Contratto')}
                    ${thSort('assunzione', 'Data Inizio')}
                    ${thSort('termine', 'Data Fine')}
                    ${thSort('costo', 'Costo/Mese', 'col-num')}
                    ${thSort('comm', 'Comm.', 'col-num')}
                    ${thSort('stato', 'Stato')}
                    <th class="col-actions"></th>
                </tr></thead>
                <tbody>
                    ${sorted.map(p => `
                        <tr class="res-persona-row${_selectedPersonaId === p.id ? ' selected' : ''}" data-persona-id="${p.id}">
                            <td>
                                <div class="res-person-name">${p.cognome} ${p.nome}</div>
                                ${p.codiceFiscale ? `<div class="res-person-cf">${p.codiceFiscale}</div>` : ''}
                            </td>
                            <td>${p.ruolo || '<span class="text-muted">—</span>'}</td>
                            <td>
                                ${p.bu ? `<span class="res-badge bu">${p.bu}</span>` : ''}
                                ${p.cdc ? `<div class="res-cdc-text">${p.cdc}</div>` : ''}
                            </td>
                            <td><span class="res-badge contratto">${p.tipoContratto || '—'}</span></td>
                            <td>${p.dataAssunzione ? formatYM(p.dataAssunzione) : '<span class="text-muted">—</span>'}</td>
                            <td>${p.dataTermine
                                ? `<span class="${p.dataTermine <= new Date().toISOString().slice(0,7) ? 'res-badge-cessato' : ''}">${formatYM(p.dataTermine)}</span>`
                                : '<span class="text-muted">—</span>'}</td>
                            <td class="col-num">${p.costoMedioMese ? formatEuro(p.costoMedioMese) : '<span class="res-warn-inline">—</span>'}</td>
                            <td class="col-num">${allocCounts[p.id]
                                ? `<span class="res-badge count">${allocCounts[p.id]}</span>`
                                : '<span class="text-muted">—</span>'}</td>
                            <td>
                                ${(() => {
                                    const oggi = new Date().toISOString().slice(0, 7);
                                    const da = p.dataAssunzione?.slice(0, 7);
                                    if (da && da > oggi && p.statoAssunzione === 'in_ingresso') return '<span class="res-badge-ingresso">In ingresso</span>';
                                    if (da && da > oggi && p.statoAssunzione === 'da_ricercare') return '<span class="res-badge-ricerca">Da ricercare</span>';
                                    if (da && da > oggi) return '<span class="res-badge-ingresso">Futura</span>';
                                    if (!_isPersonaAttiva(p)) return '<span class="res-status-dot inactive"></span> Inattiva';
                                    return '<span class="res-status-dot active"></span> Attiva';
                                })()}
                            </td>
                            <td class="col-actions">
                                <button class="btn btn-ghost btn-xs btn-edit-persona" data-id="${p.id}" title="Modifica">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                </button>
                                <button class="btn btn-danger btn-xs btn-delete-persona" data-id="${p.id}" title="Elimina">
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                </button>
                            </td>
                        </tr>
                        ${_selectedPersonaId === p.id ? `
                            <tr class="res-detail-row">
                                <td colspan="10">${_buildPersonaDetail(p, scenarioId)}</td>
                            </tr>
                        ` : ''}
                    `).join('')}
                </tbody>
            </table>
        </div>`}
    `;

    // Events — use event delegation where possible
    $('#res-persona-search')?.addEventListener('input', e => {
        const pos = e.target.selectionStart;
        _personaSearch = e.target.value;
        _renderPersone();
        const inp = $('#res-persona-search');
        if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    });
    $('#btn-res-add-persona')?.addEventListener('click', () => _openPersonaModal(null));
    $('#btn-res-import-persone')?.addEventListener('click', () => _openImportModal('persone'));

    // KPI status filter clicks
    panel.querySelectorAll('.res-kpi-clickable').forEach(el => {
        el.addEventListener('click', () => {
            const val = el.dataset.statusFilter || null;
            _personaStatusFilter = (_personaStatusFilter === val) ? null : val;
            _renderPersone();
        });
    });

    panel.querySelectorAll('.res-th-sort').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (_personaSortCol === col) {
                _personaSortDir = _personaSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _personaSortCol = col;
                _personaSortDir = 'asc';
            }
            _renderPersone();
        });
    });

    panel.querySelectorAll('.res-persona-row').forEach(row => {
        row.addEventListener('click', e => {
            if (e.target.closest('.col-actions')) return;
            const id = row.dataset.personaId;
            _selectedPersonaId = _selectedPersonaId === id ? null : id;
            _renderPersone();
        });
    });
    panel.querySelectorAll('.btn-edit-persona').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); _openPersonaModal(btn.dataset.id); });
    });
    panel.querySelectorAll('.btn-delete-persona').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const p = getPersona(btn.dataset.id);
            if (!p) return;
            if (!confirm(`Eliminare ${p.cognome} ${p.nome}?\nVerranno eliminate anche tutte le sue allocazioni.`)) { _restoreFocus(); return; }
            if (_selectedPersonaId === btn.dataset.id) _selectedPersonaId = null;
            trackDeletion('persona', btn.dataset.id);
            deletePersona(btn.dataset.id);
            _renderPersone();
        });
    });
    panel.querySelectorAll('.btn-add-alloc-from-person').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); _openAllocModal(null, btn.dataset.personaId); });
    });
    panel.querySelectorAll('.btn-edit-alloc').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); _openAllocModal(btn.dataset.id, null); });
    });
    panel.querySelectorAll('.btn-delete-alloc').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            if (!confirm('Eliminare questa allocazione?')) { _restoreFocus(); return; }
            trackDeletion('allocazione', btn.dataset.id);
            deleteAllocazione(btn.dataset.id);
            _renderPersone();
        });
    });
}

function _buildPersonaDetail(persona, scenarioId) {
    const allocazioni = listAllocazioni({ personaId: persona.id, scenarioId });
    const commesse = _ctx.getCommesse();
    const satBar = _buildSaturationBar(persona.id, allocazioni);

    const rows = allocazioni.map(a => {
        const c = commesse.find(x => x.codice === a.codiceCommessa);
        const costoMese = (persona.costoMedioMese || 0) * a.percentuale / 100;
        return `
            <tr>
                <td>
                    <span class="res-commessa-code">${a.codiceCommessa}</span>
                    ${c ? `<span class="res-commessa-nome"> ${c.nome}</span>` : ''}
                    ${c?.tipo ? `<span class="res-badge tipo-${(c.tipo||'').toLowerCase().replace(' ','-')}">${c.tipo}</span>` : ''}
                </td>
                <td class="col-num"><span class="res-perc-badge ${a.percentuale===100?'full':a.percentuale>=50?'half':'low'}">${a.percentuale}%</span></td>
                <td>${_fmtDateCell(a.dataInizio, a.aggancioInizio, _effDates(a).di)}</td>
                <td>${_fmtDateCell(a.dataFine, a.aggancioFine, _effDates(a).df)}</td>
                <td class="col-num">${costoMese ? formatEuro(costoMese) : '—'}</td>
                <td><span class="res-origine-badge origem-${a.origine||'manuale'}">${a.origine || 'manuale'}</span></td>
                <td class="col-actions">
                    <button class="btn btn-ghost btn-xs btn-edit-alloc" data-id="${a.id}" title="Modifica">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                    </button>
                    <button class="btn btn-danger btn-xs btn-delete-alloc" data-id="${a.id}" title="Elimina">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    return `
        <div class="res-persona-detail">
            <div class="res-detail-header">
                <div class="res-detail-title">
                    <strong>${persona.cognome} ${persona.nome}</strong>
                    ${persona.ruolo ? `<span class="text-muted"> — ${persona.ruolo}</span>` : ''}
                    ${persona.bu ? `<span class="res-badge bu">${persona.bu}</span>` : ''}
                    ${persona.societa ? `<span class="text-muted" style="font-size:11px"> ${persona.societa}</span>` : ''}
                </div>
                <button class="btn btn-primary btn-sm btn-add-alloc-from-person" data-persona-id="${persona.id}">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Aggiungi Allocazione
                </button>
            </div>

            ${allocazioni.length === 0
                ? `<p class="res-detail-empty">Nessuna allocazione in questo scenario.</p>`
                : `<div class="table-container" style="margin-top:8px">
                    <table class="res-table res-table-sm">
                        <thead><tr>
                            <th>Commessa</th>
                            <th class="col-num">%</th>
                            <th>Da</th>
                            <th>A</th>
                            <th class="col-num">Costo/Mese</th>
                            <th>Origine</th>
                            <th class="col-actions"></th>
                        </tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>`
            }
            ${satBar}
        </div>
    `;
}

function _buildSaturationBar(personaId, allocazioni) {
    if (!allocazioni.length) return '';
    const monthSet = new Set();
    allocazioni.forEach(a => { if (a.dataInizio && a.dataFine) getMonthsInRange(a.dataInizio, a.dataFine).forEach(m => monthSet.add(m)); });
    const months = [...monthSet].sort();
    if (!months.length) return '';

    const cells = months.map(mese => {
        const tot = allocazioni
            .filter(a => a.dataInizio && a.dataFine && isMonthInRange(mese, a.dataInizio, a.dataFine))
            .reduce((s, a) => s + a.percentuale, 0);
        const cls = tot === 0 ? 'sat-zero' : tot < 100 ? 'sat-sotto' : tot === 100 ? 'sat-ok' : 'sat-sovra';
        return `<div class="res-sat-bar-cell ${cls}" title="${formatYM(mese)}: ${tot}%">
            <span class="res-sat-m">${mese.slice(5)}</span>
            <span class="res-sat-p">${tot}%</span>
        </div>`;
    }).join('');

    return `<div class="res-sat-wrap"><div class="res-sat-label">Saturazione mensile</div><div class="res-sat-bar">${cells}</div></div>`;
}

// ─── PIANIFICAZIONE TAB ──────────────────────────────────────

function _renderPianificazione() {
    const panel = $('#res-tab-pianificazione');
    if (!panel) return;

    const scenarioId = _resolveScenarioId();
    const persone = listPersone();
    const commesse = _ctx.getCommesse();
    const scenarioName = _ctx.getActiveScenarioName ? _ctx.getActiveScenarioName() : 'Scenario attivo';
    const selectedCommesse = _resolveSelectedCommesse();

    let allocazioni = listAllocazioni({ scenarioId });
    // Filtro commessa dalla sidebar
    if (selectedCommesse.length) allocazioni = allocazioni.filter(a => selectedCommesse.includes(a.codiceCommessa));
    // Filtro persona: text search
    if (_allocPersonaSearch) {
        const q = _allocPersonaSearch.toLowerCase();
        allocazioni = allocazioni.filter(a => {
            const p = persone.find(x => x.id === a.personaId);
            return p && `${p.cognome} ${p.nome} ${p.ruolo||''}`.toLowerCase().includes(q);
        });
    }

    panel.innerHTML = `
        <div class="res-toolbar res-toolbar-wrap">
            <div class="res-filter-row">
                <div class="res-filter-group">
                    <label class="res-filter-label-fixed">Scenario</label>
                    <span class="res-context-badge">${scenarioName}</span>
                </div>
                <div class="res-filter-group">
                    <label class="res-filter-label-fixed">Commessa</label>
                    <div class="res-sidebar-filter-info">${_sidebarCommessaBadge(selectedCommesse, commesse)}</div>
                </div>
                <div class="res-filter-group">
                    <label class="res-filter-label-fixed">Cerca persona</label>
                    <input type="text" id="res-filter-persona-search" class="res-search-input"
                        placeholder="Nome, ruolo…" value="${_allocPersonaSearch}" />
                </div>
            </div>
            <div class="res-toolbar-right">
                <button id="btn-res-add-alloc" class="btn btn-primary btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Aggiungi
                </button>
                <button id="btn-res-copy-alloc" class="btn btn-outline btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    Copia da Scenario
                </button>
                <button id="btn-res-import-alloc" class="btn btn-outline btn-sm">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Importa
                </button>
            </div>
        </div>

        ${persone.length === 0 ? `
            <div class="res-info-banner">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                Prima di aggiungere allocazioni, inserisci le persone nella sezione <strong>Persone</strong>.
            </div>` : ''
        }

        ${allocazioni.length === 0 && persone.length > 0 ? _emptyState(
            'Nessuna allocazione in questo scenario',
            'Aggiungi le assegnazioni delle persone alle commesse, oppure copia le allocazioni da un altro scenario.',
            'btn-res-add-alloc'
        ) : ''}

        ${(() => {
        if (allocazioni.length === 0) return '';
        // ── Sort pianificazione ──
        const _pSortVal = (a) => {
            const p = persone.find(x => x.id === a.personaId);
            switch (_pianifSortCol) {
                case 'persona':  return p ? `${p.cognome} ${p.nome}`.toLowerCase() : 'zzz';
                case 'ruolo':    return (p?.ruolo || '').toLowerCase();
                case 'commessa': return (a.codiceCommessa || '').toLowerCase();
                case 'perc':     return a.percentuale || 0;
                case 'da':       return a.dataInizio || '';
                case 'a':        return a.dataFine || '';
                case 'costo':    return p ? (p.costoMedioMese || 0) * a.percentuale / 100 : 0;
                case 'origine':  return (a.origine || 'manuale').toLowerCase();
                default: return '';
            }
        };
        const sortedAlloc = [...allocazioni].sort((a, b) => {
            const va = _pSortVal(a), vb = _pSortVal(b);
            const cmp = typeof va === 'number' ? va - vb : va.localeCompare(vb);
            return _pianifSortDir === 'asc' ? cmp : -cmp;
        });
        const thP = (col, label, cls = '') => {
            const active = _pianifSortCol === col;
            const arrow = active ? (_pianifSortDir === 'asc' ? ' ▲' : ' ▼') : '';
            return `<th class="res-th-sort res-th-pianif${active ? ' res-th-active' : ''}${cls ? ' '+cls : ''}" data-psort="${col}">${label}${arrow}</th>`;
        };
        return `
        <div class="res-count-bar">
            <span>${allocazioni.length} ${allocazioni.length===1?'allocazione':'allocazioni'}${selectedCommesse.length||_allocPersonaSearch?' (filtrate)':''}</span>
        </div>
        <div class="table-container">
            <table class="res-table">
                <thead><tr>
                    ${thP('persona', 'Persona')}
                    ${thP('ruolo', 'Ruolo')}
                    ${thP('commessa', 'Commessa')}
                    ${thP('perc', '%', 'col-num')}
                    ${thP('da', 'Da')}
                    ${thP('a', 'A')}
                    ${thP('costo', 'Costo/Mese', 'col-num')}
                    ${thP('origine', 'Origine')}
                    <th class="col-actions"></th>
                </tr></thead>
                <tbody>
                    ${sortedAlloc.map(a => {
                        const p = persone.find(x => x.id === a.personaId);
                        const c = commesse.find(x => x.codice === a.codiceCommessa);
                        const costoMese = p ? (p.costoMedioMese || 0) * a.percentuale / 100 : 0;
                        const _cessatoBadge = (() => {
                            if (!p) return '';
                            const termine = p.dataTermine?.slice(0, 7);
                            const dfA = a.dataFine?.slice(0, 7);
                            if (termine && dfA && dfA > termine) return `<span class="res-badge-cessato">⚠ ${termine <= new Date().toISOString().slice(0,7) ? 'Cessato' : 'Cesserà'} ${formatYM(termine)}</span>`;
                            if (!_isPersonaAttiva(p) && termine) return `<span class="res-badge-cessato">⚠ Cessato ${formatYM(termine)}</span>`;
                            if (!_isPersonaAttiva(p)) return `<span class="res-badge-cessato">⚠ Non attiva</span>`;
                            return '';
                        })();
                        return `
                            <tr>
                                <td><div class="res-person-name">${p ? `${p.cognome} ${p.nome}` : `<span class="res-warn-inline">Persona non trovata</span>`}${_cessatoBadge}</div></td>
                                <td>${p?.ruolo || '<span class="text-muted">—</span>'}</td>
                                <td>
                                    <span class="res-commessa-code">${a.codiceCommessa}</span>
                                    ${c ? `<span class="res-commessa-nome"> ${c.nome}</span>` : ''}
                                    ${c?.tipo ? `<span class="res-badge tipo-${(c.tipo||'').toLowerCase().replace(' ','-')}">${c.tipo}</span>` : ''}
                                </td>
                                <td class="col-num"><span class="res-perc-badge ${a.percentuale===100?'full':a.percentuale>=50?'half':'low'}">${a.percentuale}%</span></td>
                                <td>${_fmtDateCell(a.dataInizio, a.aggancioInizio, _effDates(a).di)}</td>
                                <td>${_fmtDateCell(a.dataFine, a.aggancioFine, _effDates(a).df)}</td>
                                <td class="col-num">${costoMese ? formatEuro(costoMese) : '—'}</td>
                                <td><span class="res-origine-badge origem-${a.origine||'manuale'}">${a.origine||'manuale'}</span></td>
                                <td class="col-actions">
                                    <button class="btn btn-ghost btn-xs btn-edit-alloc-plan" data-id="${a.id}" title="Modifica">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                                    </button>
                                    <button class="btn btn-danger btn-xs btn-delete-alloc-plan" data-id="${a.id}" title="Elimina">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                                    </button>
                                </td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </div>`;
    })()}
    `;

    // Sort listener pianificazione
    panel.querySelectorAll('.res-th-pianif').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.psort;
            if (_pianifSortCol === col) {
                _pianifSortDir = _pianifSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _pianifSortCol = col;
                _pianifSortDir = 'asc';
            }
            _renderPianificazione();
        });
    });

    $('#res-filter-persona-search')?.addEventListener('input', e => {
        const pos = e.target.selectionStart;
        _allocPersonaSearch = e.target.value;
        _renderPianificazione();
        const inp = $('#res-filter-persona-search');
        if (inp) { inp.focus(); inp.setSelectionRange(pos, pos); }
    });
    $('#btn-res-add-alloc')?.addEventListener('click', () => _openAllocModal(null, null));
    $('#btn-res-copy-alloc')?.addEventListener('click', () => _openCopyAllocModal());
    $('#btn-res-import-alloc')?.addEventListener('click', () => _openImportModal('allocazioni'));

    panel.querySelectorAll('.btn-edit-alloc-plan').forEach(btn => {
        btn.addEventListener('click', () => _openAllocModal(btn.dataset.id, null));
    });
    panel.querySelectorAll('.btn-delete-alloc-plan').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!confirm('Eliminare questa allocazione?')) { _restoreFocus(); return; }
            trackDeletion('allocazione', btn.dataset.id);
            deleteAllocazione(btn.dataset.id);
            _renderPianificazione();
        });
    });
}

// ─── COMMESSE/RISORSE TAB ─────────────────────────────────────

function _renderCommesseRisorse() {
    const panel = $('#res-tab-commesse');
    if (!panel) return;

    const commesse = _ctx.getCommesse();
    const scenarioId = _ctx.getActiveScenarioId();
    const dateRange = _ctx.getDateRange ? _ctx.getDateRange() : {};

    const selectedCommesse = _resolveSelectedCommesse();

    const dateRangeLabel = (() => {
        if (!dateRange.from && !dateRange.to) return 'Tutto il periodo';
        if (dateRange.from && dateRange.to) return `${formatYM(dateRange.from)} → ${formatYM(dateRange.to)}`;
        if (dateRange.from) return `Da ${formatYM(dateRange.from)}`;
        return `Fino a ${formatYM(dateRange.to)}`;
    })();

    panel.innerHTML = `
        <div class="res-toolbar">
            <div class="res-filter-group">
                <label class="res-filter-label-fixed">Periodo</label>
                <span class="res-context-badge">${dateRangeLabel}</span>
            </div>
            <div class="res-filter-group">
                <label class="res-filter-label-fixed">Commessa</label>
                <div class="res-sidebar-filter-info">${_sidebarCommessaBadge(selectedCommesse, commesse)}</div>
            </div>
            <div class="res-filter-group">
                <label>Allocazioni</label>
                <select id="res-alloc-filter-sel">
                    <option value="all"${_resFilterAlloc==='all'?' selected':''}>Tutte</option>
                    <option value="con"${_resFilterAlloc==='con'?' selected':''}>Con allocazioni</option>
                    <option value="senza"${_resFilterAlloc==='senza'?' selected':''}>Senza allocazioni</option>
                </select>
            </div>
        </div>
        <div id="res-commessa-detail"></div>
    `;

    $('#res-alloc-filter-sel')?.addEventListener('change', e => {
        _resFilterAlloc = e.target.value;
        _renderCommessaDetail(scenarioId, commesse, selectedCommesse, dateRange);
    });

    _renderCommessaDetail(scenarioId, commesse, selectedCommesse, dateRange);
}

function _renderCommessaDetail(scenarioId, commesse, selectedCommesse = [], dateRange = {}) {
    const panel = $('#res-commessa-detail');
    if (!panel) return;

    const persone = listPersone();
    let commesseDaRender = selectedCommesse.length
        ? commesse.filter(c => selectedCommesse.includes(c.codice))
        : commesse;

    // Apply global filters (Settore and Tipo from the top filter bar)
    const globalFilters = _ctx.getActiveFilters ? _ctx.getActiveFilters() : {};
    if (globalFilters.settori && globalFilters.settori.length) {
        commesseDaRender = commesseDaRender.filter(c =>
            globalFilters.settori.includes(c.settore || '')
        );
    }
    if (globalFilters.types && globalFilters.types.length) {
        commesseDaRender = commesseDaRender.filter(c => {
            const tipo = c.effectiveType || c.tipo || c.type || 'Backlog';
            return globalFilters.types.includes(tipo);
        });
    }

    if (_resFilterAlloc !== 'all') {
        commesseDaRender = commesseDaRender.filter(c => {
            const haAlloc = listAllocazioni({ codiceCommessa: c.codice, scenarioId }).length > 0;
            return _resFilterAlloc === 'con' ? haAlloc : !haAlloc;
        });
    }

    if (!commesseDaRender.length) {
        const msg = _resFilterAlloc === 'con'
            ? 'Nessuna commessa ha allocazioni assegnate.'
            : _resFilterAlloc === 'senza'
            ? 'Tutte le commesse hanno almeno una allocazione.'
            : 'Nessuna commessa disponibile — aggiungine nel modulo scenario.';
        panel.innerHTML = `<div class="res-empty-state" style="padding:40px 0;">
            <h3>Nessun risultato</h3>
            <p>${msg}</p>
        </div>`;
        return;
    }

    /** Conta i mesi di un'allocazione intersecati col filtro date */
    const _filteredMonths = (di, df) => {
        const allMonths = getMonthsInRange(di, df);
        if (!dateRange.from && !dateRange.to) return allMonths;
        return allMonths.filter(m =>
            (!dateRange.from || m >= dateRange.from) &&
            (!dateRange.to   || m <= dateRange.to)
        );
    };

    let grandTeorico = 0, grandProb = 0, grandFte = 0;
    const grandPersoneSet = new Set();

    const cards = commesseDaRender.map(commessa => {
        const allocazioni = listAllocazioni({ codiceCommessa: commessa.codice, scenarioId });
        const prob = (commessa.probabilita ?? 100) / 100;
        let costoTeorico = 0, costoProb = 0, fteTotal = 0;
        const personeCommessaSet = new Set();

        const rows = allocazioni.map(a => {
            const p = persone.find(x => x.id === a.personaId);
            if (!p) return `
                <tr>
                    <td colspan="9"><span class="res-warn-inline">Persona non trovata (id: ${a.personaId || '—'}) — dati da correggere</span></td>
                </tr>`;
            const { di: effDi, df: effDf } = _effDates(a);
            const months = _filteredMonths(effDi || a.dataInizio, effDf || a.dataFine);
            const mesi = months.length;
            if (mesi === 0) return ''; // allocazione fuori dal periodo filtrato
            const costoMese = (p.costoMedioMese || 0) * a.percentuale / 100;
            const costoAlloc = costoMese * mesi;
            costoTeorico += costoAlloc;
            costoProb += costoAlloc * prob;
            fteTotal += a.percentuale / 100;
            personeCommessaSet.add(a.personaId);
            grandPersoneSet.add(a.personaId);
            return `
                <tr>
                    <td><div class="res-person-name">${p.cognome} ${p.nome}</div></td>
                    <td>${p.ruolo || '<span class="text-muted">—</span>'}</td>
                    <td class="col-num"><span class="res-perc-badge ${a.percentuale===100?'full':a.percentuale>=50?'half':'low'}">${a.percentuale}%</span></td>
                    <td>${_fmtDateCell(a.dataInizio, a.aggancioInizio, _effDates(a).di)}</td>
                    <td>${_fmtDateCell(a.dataFine, a.aggancioFine, _effDates(a).df)}</td>
                    <td class="col-num">${mesi}</td>
                    <td class="col-num">${costoMese ? formatEuro(costoMese) : '—'}</td>
                    <td class="col-num">${costoAlloc ? formatEuro(costoAlloc) : '—'}</td>
                    <td class="col-num">${formatEuro(costoAlloc * prob)}</td>
                </tr>
            `;
        }).filter(r => r).join('');

        grandTeorico += costoTeorico;
        grandProb += costoProb;
        grandFte += fteTotal;

        const bodyHtml = rows
            ? `<div class="table-container">
                <table class="res-table">
                    <thead><tr>
                        <th>Persona</th><th>Ruolo</th><th class="col-num">%</th>
                        <th>Da</th><th>A</th><th class="col-num">Mesi nel periodo</th>
                        <th class="col-num">Costo/Mese</th><th class="col-num">Costo Tot.</th><th class="col-num">Costo Prob.</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`
            : `<p class="text-muted" style="padding:12px 0;">Nessuna risorsa assegnata in questo periodo.</p>`;

        return `
            <div class="res-commessa-card">
                <div class="res-commessa-card-header">
                    <div>
                        <h3>${commessa.codice} — ${commessa.nome}</h3>
                        <div class="res-commessa-meta">
                            ${commessa.tipo ? `<span class="res-badge tipo-${(commessa.tipo||'').toLowerCase().replace(' ','-')}">${commessa.tipo}</span>` : ''}
                            ${commessa.probabilita !== undefined ? `<span class="text-muted">Prob: ${commessa.probabilita}%</span>` : ''}
                            <button class="btn btn-ghost btn-xs res-btn-rename-commessa"
                                data-codice="${commessa.codice}" data-nome="${commessa.nome}"
                                title="Rinomina codice/nome commessa">✏ Rinomina</button>
                        </div>
                    </div>
                    <div class="res-kpi-row">
                        <div class="res-kpi-mini">
                            <span class="res-kpi-label">Persone allocate</span>
                            <span class="res-kpi-val">${personeCommessaSet.size}</span>
                        </div>
                        <div class="res-kpi-mini">
                            <span class="res-kpi-label">FTE assegnati</span>
                            <span class="res-kpi-val">${fteTotal.toFixed(1)}</span>
                        </div>
                        <div class="res-kpi-mini">
                            <span class="res-kpi-label">Costo personale allocato</span>
                            <span class="res-kpi-val">${formatEuro(costoTeorico)}</span>
                        </div>
                        <div class="res-kpi-mini accent">
                            <span class="res-kpi-label">Costo personale probabilizzato</span>
                            <span class="res-kpi-val">${formatEuro(costoProb)}</span>
                        </div>
                    </div>
                </div>
                ${(() => {
                    const ruoliNecessari = listRuoli().filter(r => (r.tipo || 'necessario') === 'necessario');
                    if (!ruoliNecessari.length) return '';
                    // Ruoli coperti: persone allocate su questa commessa che hanno un ruolo necessario
                    const ruoliAllocati = new Set();
                    for (const a of allocazioni) {
                        const p = persone.find(x => x.id === a.personaId);
                        if (p?.ruolo) ruoliAllocati.add(p.ruolo.toLowerCase());
                    }
                    const coperti = ruoliNecessari.filter(r => ruoliAllocati.has(r.nome.toLowerCase()));
                    const mancanti = ruoliNecessari.filter(r => !ruoliAllocati.has(r.nome.toLowerCase()));
                    const perc = ruoliNecessari.length > 0 ? Math.round(coperti.length / ruoliNecessari.length * 100) : 100;
                    const percColor = perc >= 80 ? 'var(--success, #22c55e)' : perc >= 50 ? '#f59e0b' : 'var(--danger, #ef4444)';
                    if (allocazioni.length === 0) return ''; // non mostrare se nessuna allocazione
                    return `
                    <div style="padding:8px 16px;border-top:1px solid var(--border);font-size:12px;">
                        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                            <span style="font-weight:600;color:var(--text-muted);">Copertura ruoli necessari</span>
                            <span style="font-weight:700;color:${percColor};">${coperti.length}/${ruoliNecessari.length} (${perc}%)</span>
                        </div>
                        ${mancanti.length > 0 ? `<div class="res-copertura-bar">
                            ${mancanti.map(r => `<span class="res-copertura-item res-copertura-miss">❌ ${r.codice ? r.codice + ' — ' : ''}${r.nome}</span>`).join('')}
                        </div>` : '<span style="color:var(--success);font-size:11px;">✅ Tutti i ruoli necessari coperti</span>'}
                    </div>`;
                })()}
                ${bodyHtml}
            </div>
        `;
    }).join('');

    // Totale complessivo
    const totalHtml = commesseDaRender.length > 1 ? `
        <div class="res-commessa-card res-grand-total-card">
            <div class="res-commessa-card-header">
                <div><h3>Totale complessivo</h3></div>
                <div class="res-kpi-row">
                    <div class="res-kpi-mini">
                        <span class="res-kpi-label">Persone allocate</span>
                        <span class="res-kpi-val">${grandPersoneSet.size}</span>
                    </div>
                    <div class="res-kpi-mini">
                        <span class="res-kpi-label">FTE totali</span>
                        <span class="res-kpi-val">${grandFte.toFixed(1)}</span>
                    </div>
                    <div class="res-kpi-mini">
                        <span class="res-kpi-label">Costo personale allocato</span>
                        <span class="res-kpi-val">${formatEuro(grandTeorico)}</span>
                    </div>
                    <div class="res-kpi-mini accent">
                        <span class="res-kpi-label">Costo personale probabilizzato</span>
                        <span class="res-kpi-val">${formatEuro(grandProb)}</span>
                    </div>
                </div>
            </div>
        </div>` : '';

    panel.innerHTML = totalHtml + cards;

    // Event delegation per bottoni Rinomina
    panel.querySelectorAll('.res-btn-rename-commessa').forEach(btn => {
        btn.addEventListener('click', () => {
            _openRenameCommessaModal(btn.dataset.codice, btn.dataset.nome);
        });
    });
}

// ─── RINOMINA COMMESSA MODAL ──────────────────────────────────

function _openRenameCommessaModal(codice, nome) {
    $('#res-rename-old-codice').value = codice;
    $('#res-rename-old-nome').value = nome;
    $('#res-rename-new-codice').value = codice;
    $('#res-rename-new-nome').value = nome;
    $('#res-rename-error').textContent = '';
    document.getElementById('res-rename-commessa-modal').classList.remove('hidden');
    $('#res-rename-new-codice').focus();
    $('#res-rename-new-codice').select();
}

function _saveRenameCommessa() {
    const oldCodice = $('#res-rename-old-codice').value.trim();
    const oldNome   = $('#res-rename-old-nome').value.trim();
    const newCodice = $('#res-rename-new-codice').value.trim();
    const newNome   = $('#res-rename-new-nome').value.trim();
    const errEl = $('#res-rename-error');

    if (!newCodice) { errEl.textContent = 'Il nuovo codice è obbligatorio'; return; }
    if (!newNome)   { errEl.textContent = 'Il nuovo nome è obbligatorio'; return; }
    if (newCodice === oldCodice && newNome === oldNome) {
        errEl.textContent = 'Nessuna modifica rilevata';
        return;
    }

    const { allocCount, scenCount } = _ctx.renameCommessa(oldCodice, oldNome, newCodice, newNome);
    document.getElementById('res-rename-commessa-modal').classList.add('hidden');

    const msg = `Rinomina completata: ${allocCount} allocazion${allocCount === 1 ? 'e' : 'i'} e ${scenCount} scenar${scenCount === 1 ? 'io' : 'i'} aggiornati.`;
    alert(msg);
    _renderSubTab('commesse');
}

// ─── RILEVAMENTO ALLOCAZIONI SCOPERTE ────────────────────────

/**
 * Trova allocazioni che non coprono più le date effettive della commessa nello scenario.
 * Restituisce array di { alloc, persona, commessa, effDates, tipoProblema }
 * tipoProblema: 'inizio_posticipato' | 'fine_posticipata' | 'entrambi'
 */
function _detectAllocazioniScoperte(allocazioni, commesse, persone) {
    const problemi = [];
    for (const alloc of allocazioni) {
        // Solo allocazioni con almeno un aggancio attivo: le date manuali sono
        // intenzionali e non devono mai essere segnalate come "da sincronizzare".
        if (!alloc.aggancioInizio && !alloc.aggancioFine) continue;

        const eff = _ctx.getEffectiveCommessaDates(alloc.codiceCommessa);
        if (!eff) continue;

        const persona = persone.find(p => p.id === alloc.personaId);
        const commessa = commesse.find(c => c.codice === alloc.codiceCommessa);

        let inizioScoperto = false;
        let fineScoperta = false;
        let nuovaDi = null;
        let nuovaDf = null;

        // Inizio agganciato: la data attuale deve essere eff.dataInizio + deltaInizio
        if (alloc.aggancioInizio && eff.dataInizio) {
            nuovaDi = addMonths(eff.dataInizio, alloc.deltaInizio || 0);
            if (alloc.dataInizio !== nuovaDi) inizioScoperto = true;
        }

        // Fine agganciata: la data attuale deve essere eff.dataFine + deltaFine
        if (alloc.aggancioFine && eff.dataFine) {
            nuovaDf = addMonths(eff.dataFine, alloc.deltaFine || 0);
            if (alloc.dataFine !== nuovaDf) fineScoperta = true;
        }

        if (!inizioScoperto && !fineScoperta) continue;

        problemi.push({
            alloc,
            persona,
            commessa,
            effDates: eff,
            nuovaDi,
            nuovaDf,
            tipoProblema: inizioScoperto && fineScoperta ? 'entrambi'
                : inizioScoperto ? 'inizio_posticipato'
                : 'fine_posticipata',
        });
    }
    return problemi;
}

function _sincronizzaAllocazione(allocId) {
    const alloc = getAllocazione(allocId);
    if (!alloc) return;
    const eff = _ctx.getEffectiveCommessaDates(alloc.codiceCommessa);
    if (!eff) return;
    const update = { id: allocId };
    if (alloc.aggancioInizio && eff.dataInizio)
        update.dataInizio = addMonths(eff.dataInizio, alloc.deltaInizio || 0);
    if (alloc.aggancioFine && eff.dataFine)
        update.dataFine = addMonths(eff.dataFine, alloc.deltaFine || 0);
    saveAllocazione(update);
    _renderSubTab(_currentSubTab);
}

function _sincronizzaTutto(problemi) {
    for (const { alloc, effDates, nuovaDi, nuovaDf } of problemi) {
        const update = { id: alloc.id };
        if (alloc.aggancioInizio && nuovaDi) update.dataInizio = nuovaDi;
        if (alloc.aggancioFine   && nuovaDf) update.dataFine   = nuovaDf;
        saveAllocazione(update);
    }
    _renderSubTab(_currentSubTab);
    _showToast(`${problemi.length} allocazioni sincronizzate`);
}

function _buildScoperteBanner(problemi) {
    if (!problemi.length) return '';
    const rows = problemi.map(({ alloc, persona, commessa, nuovaDi, nuovaDf, tipoProblema }) => {
        const nomePers = persona ? `${persona.cognome} ${persona.nome}` : alloc.personaId;
        const nomeComm = commessa ? `${alloc.codiceCommessa} — ${commessa.nome}` : alloc.codiceCommessa;
        const fmtDelta = (delta) => delta ? ` (Δ${delta > 0 ? '+' : ''}${delta}m)` : '';
        const descrizione = tipoProblema === 'entrambi'
            ? `Inizio: ${formatYM(alloc.dataInizio)} → ${formatYM(nuovaDi)}${fmtDelta(alloc.deltaInizio)} &nbsp;|&nbsp; Fine: ${formatYM(alloc.dataFine)} → ${formatYM(nuovaDf)}${fmtDelta(alloc.deltaFine)}`
            : tipoProblema === 'inizio_posticipato'
            ? `Inizio: ${formatYM(alloc.dataInizio)} → ${formatYM(nuovaDi)}${fmtDelta(alloc.deltaInizio)}`
            : `Fine: ${formatYM(alloc.dataFine)} → ${formatYM(nuovaDf)}${fmtDelta(alloc.deltaFine)}`;
        return `
            <tr>
                <td>${nomePers}</td>
                <td>${nomeComm}</td>
                <td class="text-muted" style="font-size:.78rem;">${descrizione}</td>
                <td><button class="btn btn-sm btn-outline btn-sync-one" data-id="${alloc.id}" style="white-space:nowrap;">Sincronizza</button></td>
            </tr>`;
    }).join('');

    return `
        <div class="res-scoperte-banner">
            <div class="res-scoperte-header">
                <span class="res-scoperte-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    ${problemi.length} allocazioni non allineate con lo scenario
                </span>
                <button class="btn btn-sm btn-primary btn-sync-all">Sincronizza tutto</button>
            </div>
            <div class="table-container" style="margin-top:8px;">
                <table class="res-table" style="font-size:.8rem;">
                    <thead><tr><th>Persona</th><th>Commessa</th><th>Modifica date</th><th></th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>`;
}

// ─── SEARCHABLE PERSONA PICKER ───────────────────────────────

function _initPersonaPicker(containerSel, inputSel, listSel, persone, onSelect, getLabelById) {
    const container = $(containerSel);
    const input     = $(inputSel);
    const list      = $(listSel);
    if (!container || !input || !list) return;

    const show = () => list.classList.add('open');
    const hide = () => list.classList.remove('open');

    const filterList = (q) => {
        const lq = q.toLowerCase();
        list.querySelectorAll('.res-picker-option[data-id]').forEach(opt => {
            if (!opt.dataset.id) { opt.style.display = ''; return; } // "Tutte"
            const text = opt.textContent.toLowerCase();
            opt.style.display = text.includes(lq) ? '' : 'none';
        });
    };

    input.addEventListener('focus', () => { filterList(input.value); show(); });
    input.addEventListener('input', () => { filterList(input.value); show(); });

    list.addEventListener('mousedown', e => {
        const opt = e.target.closest('.res-picker-option');
        if (!opt) return;
        e.preventDefault(); // evita blur prima del click
        const id = opt.dataset.id;
        if (!id) {
            input.value = '';
        } else if (getLabelById) {
            input.value = getLabelById(id) || '';
        } else {
            const p = persone.find(x => x.id === id);
            input.value = p ? `${p.cognome} ${p.nome}` : '';
        }
        hide();
        onSelect(id);
    });

    // Chiudi cliccando fuori
    document.addEventListener('click', e => {
        if (!container.contains(e.target)) hide();
    }, { capture: true });
}

// ─── RILEVAMENTO PERSONE CESSATE ─────────────────────────────

function _detectAllocazioniPrimaAssunzione(allocazioni, persone, getEffDates) {
    const problemi = [];
    for (const alloc of allocazioni) {
        const persona = persone.find(p => p.id === alloc.personaId);
        if (!persona || !persona.dataAssunzione) continue;
        const assunzione = persona.dataAssunzione.slice(0, 7);
        const { di } = _resolveAllocDateRange(alloc, getEffDates);
        if (!di) continue;
        const diMese = di.slice(0, 7);
        if (diMese < assunzione) {
            problemi.push({ alloc, persona, assunzione, diAlloc: diMese });
        }
    }
    return problemi;
}

function _buildPrimaAssunzioneBanner(problemi) {
    if (!problemi.length) return '';
    const isCollapsed = localStorage.getItem('res-prima-assunzione-collapsed') === '1';
    const rows = problemi.map(({ alloc, persona, assunzione, diAlloc }) => {
        const nomePers = `${persona.cognome} ${persona.nome}`;
        return `<tr>
            <td>${nomePers}</td>
            <td>${alloc.codiceCommessa}</td>
            <td class="text-muted" style="font-size:.78rem;">Allocazione da ${formatYM(diAlloc)}, assunzione ${formatYM(assunzione)}</td>
        </tr>`;
    }).join('');
    return `
        <div class="res-cessate-banner${isCollapsed ? ' collapsed' : ''}" style="border-color:var(--warning, #f59e0b);">
            <div class="res-cessate-header res-cessate-toggle" data-collapse-key="res-prima-assunzione-collapsed">
                <span class="res-cessate-title" style="color:var(--warning, #f59e0b);">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    ${problemi.length} allocazion${problemi.length === 1 ? 'e inizia' : 'i iniziano'} prima della data di assunzione
                </span>
                <span class="res-cessate-chevron">${isCollapsed ? '▶' : '▼'}</span>
            </div>
            <div class="res-cessate-body">
                <div class="table-container" style="margin-top:6px;">
                    <table class="res-table" style="font-size:.8rem;">
                        <thead><tr><th>Persona</th><th>Commessa</th><th>Dettaglio</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
}

function _detectPersoneCessate(allocazioni, persone) {
    const problemi = [];
    const ignorati = [];
    for (const alloc of allocazioni) {
        const persona = persone.find(p => p.id === alloc.personaId);
        if (!persona) continue;
        const termine = persona.dataTermine?.slice(0, 7);
        const dfAlloc = alloc.dataFine?.slice(0, 7);
        if (!termine && _isPersonaAttiva(persona)) continue;
        const oltretermine = termine && dfAlloc && dfAlloc > termine;
        const nonAttiva = !_isPersonaAttiva(persona);
        if (!oltretermine && !nonAttiva) continue;
        const entry = { alloc, persona, termine, dfAlloc, oltretermine, nonAttiva };
        if (alloc.cessatoOk) ignorati.push(entry);
        else problemi.push(entry);
    }
    return { problemi, ignorati };
}

function _buildCessateBanner(problemi) {
    if (!problemi.length) return '';
    const isCollapsed = localStorage.getItem('res-cessate-banner-collapsed') === '1';
    const rows = problemi.map(({ alloc, persona, termine, dfAlloc, oltretermine, nonAttiva }) => {
        const nomePers = `${persona.cognome} ${persona.nome}`;
        const dettaglio = nonAttiva && !termine
            ? 'Persona non più attiva in azienda'
            : oltretermine
            ? `Fine allocazione ${formatYM(dfAlloc)} supera il termine rapporto ${formatYM(termine)}`
            : `Rapporto ${termine <= new Date().toISOString().slice(0,7) ? 'cessato' : 'cesserà'} a ${formatYM(termine)}`;
        return `<tr>
            <td>${nomePers}</td>
            <td>${alloc.codiceCommessa}</td>
            <td class="text-muted" style="font-size:.78rem;">${dettaglio}</td>
            <td><button class="btn-ignora-cessato" data-alloc-id="${alloc.id}" title="Non mostrare più questo avviso">Ignora</button></td>
        </tr>`;
    }).join('');
    return `
        <div class="res-cessate-banner${isCollapsed ? ' collapsed' : ''}">
            <div class="res-cessate-header res-cessate-toggle">
                <span class="res-cessate-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                    ${problemi.length} allocazion${problemi.length === 1 ? 'e' : 'i'} su person${problemi.length === 1 ? 'a cessata' : 'e cessate o non attive'}
                </span>
                <span class="res-cessate-chevron">${isCollapsed ? '▶' : '▼'}</span>
            </div>
            <div class="res-cessate-body">
                <div class="table-container" style="margin-top:6px;">
                    <table class="res-table" style="font-size:.8rem;">
                        <thead><tr><th>Persona</th><th>Commessa</th><th>Dettaglio</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
}

function _buildCessateIgnoratiSection(ignorati) {
    if (!ignorati.length) return '';
    const isCollapsed = localStorage.getItem('res-cessate-ignorati-collapsed') !== '0'; // default chiuso
    const rows = ignorati.map(({ alloc, persona, termine, dfAlloc, oltretermine, nonAttiva }) => {
        const nomePers = `${persona.cognome} ${persona.nome}`;
        const dettaglio = nonAttiva && !termine
            ? 'Persona non più attiva in azienda'
            : oltretermine
            ? `Fine allocazione ${formatYM(dfAlloc)} supera il termine rapporto ${formatYM(termine)}`
            : `Rapporto ${termine <= new Date().toISOString().slice(0,7) ? 'cessato' : 'cesserà'} a ${formatYM(termine)}`;
        return `<tr>
            <td>${nomePers}</td>
            <td>${alloc.codiceCommessa}</td>
            <td class="text-muted" style="font-size:.78rem;">${dettaglio}</td>
            <td><button class="btn-ripristina-cessato" data-alloc-id="${alloc.id}" title="Ripristina questo avviso">Ripristina</button></td>
        </tr>`;
    }).join('');
    return `
        <div class="res-cessate-ignorati${isCollapsed ? ' collapsed' : ''}">
            <div class="res-cessate-ignorati-toggle">
                <span class="res-cessate-ignorati-title">
                    ${ignorati.length} avvis${ignorati.length === 1 ? 'o ignorato' : 'i ignorati'} su persone cessate
                </span>
                <span class="res-cessate-ignorati-chevron">${isCollapsed ? '▶' : '▼'}</span>
            </div>
            <div class="res-cessate-ignorati-body">
                <div class="table-container" style="margin-top:6px;">
                    <table class="res-table" style="font-size:.8rem;">
                        <thead><tr><th>Persona</th><th>Commessa</th><th>Dettaglio</th><th></th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                </div>
            </div>
        </div>`;
}

// ─── CAPACITY TAB ─────────────────────────────────────────────

// ─── COST CHARTS HELPERS ─────────────────────────────────────

function _computeMonthlyCostsByType(matrix, months, commesse) {
    const data = { total: [], backlog: [], oi: [] };
    const commessaTypeMap = new Map();
    for (const c of commesse) {
        commessaTypeMap.set(c.codice, c.effectiveType || c.tipo || c.type || 'Backlog');
    }

    for (const mese of months) {
        let tot = 0, bl = 0, oi = 0;
        for (const [, pMap] of matrix) {
            const cell = pMap.get(mese);
            if (!cell) continue;
            for (const a of cell.allocazioni) {
                const tipo = commessaTypeMap.get(a.codiceCommessa) || 'Backlog';
                tot += a.costo;
                if (tipo === 'Backlog') bl += a.costo;
                else oi += a.costo;
            }
        }
        data.total.push(Math.round(tot));
        data.backlog.push(Math.round(bl));
        data.oi.push(Math.round(oi));
    }
    return data;
}

function _fmtK(v) {
    if (Math.abs(v) >= 1000000) return (v / 1000000).toFixed(1) + 'M';
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(0) + 'k';
    return v.toFixed(0);
}

function _buildCostChart(canvasId, labels, monthlyData, color, cumColor) {
    // Destroy previous instance
    if (_capacityCharts[canvasId]) { _capacityCharts[canvasId].destroy(); delete _capacityCharts[canvasId]; }
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;

    // Compute cumulative
    const cumulative = [];
    let running = 0;
    for (const v of monthlyData) { running += v; cumulative.push(running); }

    const chart = new Chart(canvas, {
        type: 'bar',
        plugins: [ChartDataLabels],
        data: {
            labels,
            datasets: [
                {
                    label: 'Costo mensile',
                    data: monthlyData,
                    backgroundColor: color,
                    borderRadius: 3,
                    order: 2,
                    yAxisID: 'y',
                    datalabels: {
                        anchor: 'end',
                        align: 'top',
                        color: 'var(--text-muted, #888)',
                        font: { size: 10, weight: '600' },
                        formatter: v => v > 0 ? _fmtK(v) : '',
                    }
                },
                {
                    label: 'Cumulato',
                    data: cumulative,
                    type: 'line',
                    borderColor: cumColor,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 2,
                    pointBackgroundColor: cumColor,
                    tension: 0.3,
                    order: 1,
                    yAxisID: 'y2',
                    datalabels: {
                        anchor: 'end',
                        align: 'top',
                        color: cumColor,
                        font: { size: 9 },
                        formatter: v => _fmtK(v),
                        display: (ctx) => {
                            // Show label only on last point and every ~4th point
                            const i = ctx.dataIndex;
                            const len = ctx.dataset.data.length;
                            return i === len - 1 || (len > 6 && i % Math.ceil(len / 5) === 0);
                        }
                    }
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.dataset.label}: ${new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0, useGrouping: true }).format(ctx.raw)} €`
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 10 }, maxRotation: 45 }
                },
                y: {
                    position: 'left',
                    beginAtZero: true,
                    grid: { color: 'rgba(128,128,128,0.1)' },
                    ticks: { font: { size: 10 }, callback: v => _fmtK(v) }
                },
                y2: {
                    position: 'right',
                    beginAtZero: true,
                    grid: { display: false },
                    ticks: { font: { size: 10 }, callback: v => _fmtK(v) }
                }
            }
        }
    });
    _capacityCharts[canvasId] = chart;
}

function _renderCostCharts(matrix, months, commesse) {
    const costs = _computeMonthlyCostsByType(matrix, months, commesse);
    const labels = months.map(m => formatYM(m));

    _buildCostChart('chart-cost-total', labels, costs.total,
        'rgba(34, 197, 94, 0.7)', '#16a34a');
    _buildCostChart('chart-cost-backlog', labels, costs.backlog,
        'rgba(251, 146, 60, 0.7)', '#ea580c');
    _buildCostChart('chart-cost-oi', labels, costs.oi,
        'rgba(99, 140, 255, 0.7)', '#4f6ef7');
}

function _renderSaturationCharts(summary, matrix, months, personeFiltrate, persone) {
    const labels = months.map(m => formatYM(m));

    // --- Costo Personale Mensile (bar chart) ---
    if (persone && persone.length > 0) {
        const costoMensile = computeCostoPersonaleMensile(persone, months);
        const costoData = months.map(m => costoMensile.get(m)?.costo || 0);
        const personeData = months.map(m => costoMensile.get(m)?.numPersone || 0);

        // Colore condizionale: evidenzia variazioni rispetto al mese precedente
        const bgColors = costoData.map((val, i) => {
            if (i === 0) return 'rgba(99, 140, 255, 0.7)';
            const prev = costoData[i - 1];
            if (val < prev) return 'rgba(239, 68, 68, 0.7)';   // calo = rosso (cessazione)
            if (val > prev) return 'rgba(34, 197, 94, 0.7)';   // aumento = verde (assunzione)
            return 'rgba(99, 140, 255, 0.7)';                   // invariato = blu
        });

        if (_capacityCharts['chart-costo-personale-mensile']) { _capacityCharts['chart-costo-personale-mensile'].destroy(); }
        const canvasCosto = document.getElementById('chart-costo-personale-mensile');
        if (canvasCosto) {
            _capacityCharts['chart-costo-personale-mensile'] = new Chart(canvasCosto, {
                type: 'bar',
                plugins: [ChartDataLabels],
                data: {
                    labels,
                    datasets: [{
                        label: 'Costo personale mensile',
                        data: costoData,
                        backgroundColor: bgColors,
                        borderRadius: 3,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        datalabels: {
                            anchor: 'end',
                            align: 'top',
                            font: { size: 9, weight: '600' },
                            color: 'rgba(150,150,150,0.9)',
                            formatter: val => val > 0 ? (val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val.toFixed(0)) : '',
                        },
                        tooltip: {
                            callbacks: {
                                title: ctx => {
                                    const mese = months[ctx[0].dataIndex];
                                    return formatYM(mese);
                                },
                                label: ctx => {
                                    const mese = months[ctx.dataIndex];
                                    const info = costoMensile.get(mese);
                                    const costo = ctx.raw.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
                                    const lines = [`Costo: ${costo}`, `Persone sotto contratto: ${info?.numPersone || 0}`];
                                    if (info?.assunte?.length) {
                                        lines.push('', `Assunte (${info.assunte.length}):`);
                                        info.assunte.forEach(n => lines.push(`  + ${n}`));
                                    }
                                    if (info?.cessate?.length) {
                                        lines.push('', `Cessate (${info.cessate.length}):`);
                                        info.cessate.forEach(n => lines.push(`  - ${n}`));
                                    }
                                    return lines;
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
                        y: {
                            beginAtZero: true,
                            grid: { color: 'rgba(128,128,128,0.1)' },
                            ticks: {
                                font: { size: 10 },
                                callback: val => val >= 1000 ? (val / 1000).toFixed(0) + 'k' : val
                            }
                        }
                    }
                }
            });
        }
    }

    // --- Persone per stato (stacked bar) ---
    const okData = [], sottoData = [], sovraData = [], dispData = [];
    for (const mese of months) {
        const s = summary[mese] || { ok: 0, sotto: 0, sovra: 0, disponibile: personeFiltrate.length };
        okData.push(s.ok);
        sottoData.push(s.sotto);
        sovraData.push(s.sovra);
        dispData.push(s.disponibile);
    }

    if (_capacityCharts['chart-persone-stato']) { _capacityCharts['chart-persone-stato'].destroy(); }
    const canvas1 = document.getElementById('chart-persone-stato');
    if (canvas1) {
        _capacityCharts['chart-persone-stato'] = new Chart(canvas1, {
            type: 'bar',
            plugins: [ChartDataLabels],
            data: {
                labels,
                datasets: [
                    { label: 'Sovra (>100%)', data: sovraData, backgroundColor: 'rgba(239, 68, 68, 0.75)', borderRadius: 2 },
                    { label: 'OK (100%)', data: okData, backgroundColor: 'rgba(34, 197, 94, 0.75)', borderRadius: 2 },
                    { label: 'Sotto (<100%)', data: sottoData, backgroundColor: 'rgba(250, 204, 21, 0.75)', borderRadius: 2 },
                    { label: 'Disponibile', data: dispData, backgroundColor: 'rgba(148, 163, 184, 0.4)', borderRadius: 2 },
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true, position: 'top', labels: { boxWidth: 12, font: { size: 10 } } },
                    datalabels: { display: false },
                    tooltip: {
                        callbacks: {
                            label: ctx => `${ctx.dataset.label}: ${ctx.raw} persone`
                        }
                    }
                },
                scales: {
                    x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
                    y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(128,128,128,0.1)' }, ticks: { font: { size: 10 }, stepSize: 1 } }
                }
            }
        });
    }

    // --- Saturazione media (bar con colore condizionale + etichette %) ---
    const avgData = [], bgColors = [], borderColors = [];
    for (const mese of months) {
        let totalPercSum = 0;
        for (const p of personeFiltrate) {
            const cell = matrix.get(p.id)?.get(mese);
            if (cell) totalPercSum += cell.totalePerc;
        }
        const avg = personeFiltrate.length > 0 ? Math.round(totalPercSum / personeFiltrate.length) : 0;
        avgData.push(avg);
        if (avg > 100) { bgColors.push('rgba(239, 68, 68, 0.7)'); borderColors.push('#ef4444'); }
        else if (avg === 100) { bgColors.push('rgba(34, 197, 94, 0.7)'); borderColors.push('#22c55e'); }
        else if (avg > 0) { bgColors.push('rgba(250, 204, 21, 0.7)'); borderColors.push('#facc15'); }
        else { bgColors.push('rgba(148, 163, 184, 0.3)'); borderColors.push('#94a3b8'); }
    }

    if (_capacityCharts['chart-saturazione-media']) { _capacityCharts['chart-saturazione-media'].destroy(); }
    const canvas2 = document.getElementById('chart-saturazione-media');
    if (canvas2) {
        _capacityCharts['chart-saturazione-media'] = new Chart(canvas2, {
            type: 'bar',
            plugins: [ChartDataLabels],
            data: {
                labels,
                datasets: [{
                    label: 'Saturazione media %',
                    data: avgData,
                    backgroundColor: bgColors,
                    borderColor: borderColors,
                    borderWidth: 1,
                    borderRadius: 3,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    datalabels: {
                        anchor: 'end',
                        align: 'top',
                        font: { size: 10, weight: '600' },
                        color: (ctx) => {
                            const v = ctx.dataset.data[ctx.dataIndex];
                            return v > 100 ? '#ef4444' : v === 100 ? '#22c55e' : v > 0 ? '#a16207' : '#94a3b8';
                        },
                        formatter: v => v > 0 ? v + '%' : '',
                    },
                    tooltip: {
                        callbacks: { label: ctx => `Saturazione: ${ctx.raw}%` }
                    }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 45 } },
                    y: {
                        beginAtZero: true,
                        grid: { color: 'rgba(128,128,128,0.1)' },
                        ticks: { font: { size: 10 }, callback: v => v + '%' }
                    }
                }
            }
        });
    }
}

function _renderCapacity() {
    const panel = $('#res-tab-capacity');
    if (!panel) return;

    const persone = listPersone();
    const scenarioId = _ctx.getActiveScenarioId();
    const commesse = _ctx.getCommesse();

    if (!persone.length) {
        panel.innerHTML = _emptyState('Nessuna persona inserita', 'Inserisci le persone e le allocazioni per vedere l\'analisi di capacity.', null);
        return;
    }

    const selectedCommesse = _resolveSelectedCommesse();
    let allocazioni = listAllocazioni({ scenarioId });
    if (selectedCommesse.length) allocazioni = allocazioni.filter(a => selectedCommesse.includes(a.codiceCommessa));
    if (!allocazioni.length) {
        panel.innerHTML = _emptyState('Nessuna allocazione in questo scenario', 'Aggiungi allocazioni nella sezione Pianificazione.', null);
        return;
    }

    // Filtro persona + ordinamento
    const personeFiltrate = (_capacityPersonaId
        ? persone.filter(p => p.id === _capacityPersonaId)
        : [...persone]
    ).sort((a, b) => {
        let va, vb;
        if (_capacitySortCol === 'ruolo') {
            va = (a.ruolo || '').toLowerCase();
            vb = (b.ruolo || '').toLowerCase();
        } else {
            va = `${a.cognome} ${a.nome}`.toLowerCase();
            vb = `${b.cognome} ${b.nome}`.toLowerCase();
        }
        const cmp = va.localeCompare(vb, 'it');
        return _capacitySortDir === 'asc' ? cmp : -cmp;
    });

    // Collect months (from ALL allocations, not filtered by persona)
    const monthSet = new Set();
    allocazioni.forEach(a => {
        const eff = (a.aggancioInizio || a.aggancioFine) ? _ctx.getEffectiveCommessaDates(a.codiceCommessa) : null;
        const di = (a.aggancioInizio && eff?.dataInizio) ? eff.dataInizio : a.dataInizio;
        const df = (a.aggancioFine   && eff?.dataFine)   ? eff.dataFine   : a.dataFine;
        if (di && df) getMonthsInRange(di, df).forEach(m => monthSet.add(m));
    });

    // Estendi a range continuo: i mesi "buco" (nessuna allocazione) devono
    // comunque comparire nella griglia con saturazione 0.
    if (monthSet.size > 0) {
        const sorted = [...monthSet].sort();
        let cur = sorted[0];
        const last = sorted[sorted.length - 1];
        while (cur < last) {
            monthSet.add(cur);
            const [y, mo] = cur.split('-').map(Number);
            const t = y * 12 + (mo - 1) + 1;
            cur = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
        }
    }

    // Applica filtro date globale
    const dateRange = _ctx.getDateRange ? _ctx.getDateRange() : {};
    const months = [...monthSet].sort().filter(m =>
        (!dateRange.from || m >= dateRange.from) &&
        (!dateRange.to   || m <= dateRange.to)
    );

    const matrix = computeResourceMatrix(scenarioId, commesse, months, _ctx.getEffectiveCommessaDates);
    const summary = computeSaturationSummary(matrix, months, personeFiltrate);
    const kpis = computeResourceKpis(matrix, months);
    const { costoPersonaleTotale, costoAttivi, costoInIngresso, costoDaRicercare } = computeCostoPersonaleTotale(persone, months);
    const assorbimento = kpis.costoTotale - costoPersonaleTotale;

    const problemiScoperte = _detectAllocazioniScoperte(allocazioni, commesse, persone);
    const bannerHtml = _buildScoperteBanner(problemiScoperte);

    const dateRangeLabel = (() => {
        if (!dateRange.from && !dateRange.to) return 'Tutto il periodo';
        if (dateRange.from && dateRange.to) return `${formatYM(dateRange.from)} → ${formatYM(dateRange.to)}`;
        if (dateRange.from) return `Da ${formatYM(dateRange.from)}`;
        return `Fino a ${formatYM(dateRange.to)}`;
    })();

    panel.innerHTML = `
        <div class="res-toolbar res-toolbar-wrap">
            <div class="res-filter-row">
                <div class="res-filter-group">
                    <label class="res-filter-label-fixed">Periodo</label>
                    <span class="res-context-badge">${dateRangeLabel}</span>
                </div>
                <div class="res-filter-group">
                    <label class="res-filter-label-fixed">Commessa</label>
                    <div class="res-sidebar-filter-info">${_sidebarCommessaBadge(selectedCommesse, commesse)}</div>
                </div>
                <div class="res-filter-group">
                    <label class="res-filter-label-fixed">Persona</label>
                    <div class="res-persona-picker" id="res-capacity-picker">
                        <input type="text" id="res-capacity-persona-search" class="res-search-input"
                            placeholder="Tutte le persone…" autocomplete="off"
                            value="${_capacityPersonaId ? (() => { const p = persone.find(x => x.id === _capacityPersonaId); return p ? `${p.cognome} ${p.nome}` : ''; })() : ''}" />
                        <div class="res-picker-dropdown" id="res-capacity-picker-list">
                            <div class="res-picker-option" data-id="">— Tutte le persone —</div>
                            ${persone.map(p => `
                                <div class="res-picker-option${_capacityPersonaId === p.id ? ' selected' : ''}" data-id="${p.id}">
                                    <span class="res-picker-name">${p.cognome} ${p.nome}</span>
                                    ${p.ruolo ? `<span class="res-picker-ruolo">${p.ruolo}</span>` : ''}
                                </div>`).join('')}
                        </div>
                    </div>
                </div>
            </div>
        </div>
        ${bannerHtml}
        <div class="res-capacity-kpis">
            <div class="res-kpi-mini">
                <span class="res-kpi-label">Persone allocate</span>
                <span class="res-kpi-val">${kpis.personeAllocate} / ${persone.length}</span>
            </div>
            <div class="res-kpi-mini">
                <span class="res-kpi-label">Costo personale totale</span>
                <span class="res-kpi-val">${formatEuro(costoPersonaleTotale)}</span>
            </div>
            <div class="res-kpi-mini">
                <span class="res-kpi-label">Costo personale allocato</span>
                <span class="res-kpi-val">${formatEuro(kpis.costoTotale)}</span>
            </div>
            <div class="res-kpi-mini accent">
                <span class="res-kpi-label">Costo personale probabilizzato</span>
                <span class="res-kpi-val">${formatEuro(kpis.costoProb)}</span>
            </div>
            <div class="res-kpi-mini ${assorbimento < 0 ? 'warning' : assorbimento > 0 ? 'accent' : ''}" ${assorbimento < 0 ? 'style="border-color:var(--danger, #ef4444);"' : ''}>
                <span class="res-kpi-label">${assorbimento < 0 ? 'Sotto-assorbimento' : assorbimento > 0 ? 'Sovra-assorbimento' : 'Assorbimento'}</span>
                <span class="res-kpi-val" ${assorbimento < 0 ? 'style="color:var(--danger, #ef4444);"' : ''}>${assorbimento >= 0 ? '+' : ''}${formatEuro(assorbimento)}</span>
            </div>
            <div class="res-kpi-mini">
                <span class="res-kpi-label">FTE equivalenti</span>
                <span class="res-kpi-val">${kpis.fte.toFixed(1)}</span>
            </div>
        </div>

        ${(costoInIngresso > 0 || costoDaRicercare > 0) ? `
        <div class="res-capacity-kpis" style="margin-top:0;">
            <div class="res-kpi-mini">
                <span class="res-kpi-label">Costo personale attivo</span>
                <span class="res-kpi-val">${formatEuro(costoAttivi)}</span>
            </div>
            ${costoInIngresso > 0 ? `<div class="res-kpi-mini" style="border-left:2px solid #3b82f6;">
                <span class="res-kpi-label">Costo nuove assunzioni (certe)</span>
                <span class="res-kpi-val" style="color:#3b82f6;">${formatEuro(costoInIngresso)}</span>
            </div>` : ''}
            ${costoDaRicercare > 0 ? `<div class="res-kpi-mini" style="border-left:2px solid #f59e0b;">
                <span class="res-kpi-label">Costo posizioni aperte</span>
                <span class="res-kpi-val" style="color:#f59e0b;">${formatEuro(costoDaRicercare)}</span>
            </div>` : ''}
        </div>` : ''}

        ${(() => {
            const oggi = new Date().toISOString().slice(0, 7);
            const pianificate = persone.filter(p => p.dataAssunzione?.slice(0, 7) > oggi && (p.statoAssunzione === 'in_ingresso' || p.statoAssunzione === 'da_ricercare'));
            if (!pianificate.length) return '';
            pianificate.sort((a, b) => (a.dataAssunzione || '').localeCompare(b.dataAssunzione || ''));
            return `
            <div class="res-disp-section" style="margin-bottom:12px;">
                <div class="res-disp-header">
                    <h4>Piano Assunzioni</h4>
                    <span class="text-muted" style="font-size:.78rem;">${pianificate.length} ${pianificate.length === 1 ? 'posizione' : 'posizioni'}</span>
                </div>
                <div class="res-disp-body">
                    <div class="table-container">
                        <table class="res-table">
                            <thead><tr>
                                <th>Persona</th><th>Ruolo</th><th>BU</th><th>Stato</th><th>Assunzione</th><th class="col-num">Costo/Mese</th>
                            </tr></thead>
                            <tbody>${pianificate.map(p => `
                                <tr>
                                    <td><div class="res-person-name">${p.cognome} ${p.nome}</div></td>
                                    <td>${p.ruolo || '—'}</td>
                                    <td>${p.bu || '—'}</td>
                                    <td>${p.statoAssunzione === 'in_ingresso' ? '<span class="res-badge-ingresso">In ingresso</span>' : '<span class="res-badge-ricerca">Da ricercare</span>'}</td>
                                    <td>${formatYM(p.dataAssunzione?.slice(0, 7))}</td>
                                    <td class="col-num">${p.costoMedioMese ? formatEuro(p.costoMedioMese) : '—'}</td>
                                </tr>`).join('')}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>`;
        })()}

        <!-- Grafici costi mensili (Chart.js) -->
        <div class="res-capacity-section">
            <h4>Costo Personale per mese — Totale</h4>
            <div style="position:relative;height:280px;"><canvas id="chart-cost-total"></canvas></div>
        </div>
        <div class="res-capacity-charts-row">
            <div class="res-capacity-section res-capacity-chart-half">
                <h4>Costo Personale per mese — Backlog</h4>
                <div style="position:relative;height:260px;"><canvas id="chart-cost-backlog"></canvas></div>
            </div>
            <div class="res-capacity-section res-capacity-chart-half">
                <h4>Costo Personale per mese — Order Intake</h4>
                <div style="position:relative;height:260px;"><canvas id="chart-cost-oi"></canvas></div>
            </div>
        </div>

        <!-- Grafici secondari: saturazione (Chart.js) -->
        <details class="res-secondary-charts">
            <summary style="cursor:pointer;font-size:13px;color:var(--text-muted);margin:16px 0 8px;">Grafici saturazione (mostra/nascondi)</summary>
            <div class="res-capacity-section" style="margin-bottom:12px;">
                <h4>Costo Personale Mensile</h4>
                <div style="position:relative;height:280px;"><canvas id="chart-costo-personale-mensile"></canvas></div>
            </div>
            <div class="res-capacity-charts-row">
                <div class="res-capacity-section res-capacity-chart-half">
                    <h4>Persone per stato — ${personeFiltrate.length} ${_capacityPersonaId ? 'selezionata' : 'totali'}</h4>
                    <div style="position:relative;height:260px;"><canvas id="chart-persone-stato"></canvas></div>
                </div>
                <div class="res-capacity-section res-capacity-chart-half">
                    <h4>Saturazione media del team</h4>
                    <div style="position:relative;height:260px;"><canvas id="chart-saturazione-media"></canvas></div>
                </div>
            </div>
        </details>

        <div class="res-capacity-section">
            <h4>Dettaglio per Persona</h4>
            <div class="table-container" style="overflow-x:auto;">
                <table class="res-saturation-table">
                    <thead>
                        <tr>
                            <th class="res-sat-fixed res-capacity-sort" data-sort="persona" style="cursor:pointer;user-select:none;">Persona ${_capacitySortCol === 'persona' ? (_capacitySortDir === 'asc' ? '▲' : '▼') : ''}</th>
                            <th class="res-sat-fixed res-capacity-sort" data-sort="ruolo" style="cursor:pointer;user-select:none;">Ruolo ${_capacitySortCol === 'ruolo' ? (_capacitySortDir === 'asc' ? '▲' : '▼') : ''}</th>
                            ${months.map(m => `<th class="res-sat-month-th">${m.slice(5)}<br><small>${m.slice(0,4)}</small></th>`).join('')}
                        </tr>
                    </thead>
                    <tbody>
                        ${personeFiltrate.map(p => {
                            const pMap = matrix.get(p.id);
                            const _termine = p.dataTermine?.slice(0, 7) || null;
                            return `
                                <tr>
                                    <td class="res-sat-fixed res-person-name">
                                        ${p.cognome} ${p.nome}
                                        ${_termine ? `<span class="res-badge-cessato">${_termine <= new Date().toISOString().slice(0,7) ? 'Cessato' : 'Cesserà'} ${formatYM(_termine)}</span>` : !_isPersonaAttiva(p) ? '<span class="res-badge-cessato">Non attiva</span>' : ''}
                                    </td>
                                    <td class="res-sat-fixed text-muted">${p.ruolo || '—'}</td>
                                    ${months.map(mese => {
                                        // Mesi dopo il termine: cella grigiata
                                        if (_termine && mese > _termine) {
                                            return `<td class="res-sat-cell sat-terminated" title="Rapporto ${_termine <= new Date().toISOString().slice(0,7) ? 'cessato' : 'cesserà'} ${formatYM(_termine)}">✕</td>`;
                                        }
                                        const cell = pMap?.get(mese);
                                        if (!cell || cell.totalePerc === 0) return `<td class="res-sat-cell sat-zero">—</td>`;
                                        const tt = cell.allocazioni.map(a => `${a.codiceCommessa}: ${a.percentuale}%`).join(', ');
                                        return `<td class="res-sat-cell sat-${cell.saturazione}" title="${tt}">${cell.totalePerc}%</td>`;
                                    }).join('')}
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>

        ${_buildDisponibilitaSection(persone, allocazioni, commesse, months, _ctx.getEffectiveCommessaDates, matrix)}

    `;

    // Render cost charts (Chart.js)
    _renderCostCharts(matrix, months, commesse);

    // Render saturation charts when details is opened (lazy, avoids canvas sizing issues)
    const detailsEl = panel.querySelector('.res-secondary-charts');
    if (detailsEl) {
        let satChartsRendered = false;
        detailsEl.addEventListener('toggle', () => {
            if (detailsEl.open && !satChartsRendered) {
                satChartsRendered = true;
                _renderSaturationCharts(summary, matrix, months, personeFiltrate, persone);
            }
        });
    }

    // Sort colonne tabella dettaglio persona
    panel.querySelectorAll('.res-capacity-sort').forEach(th => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (_capacitySortCol === col) {
                _capacitySortDir = _capacitySortDir === 'asc' ? 'desc' : 'asc';
            } else {
                _capacitySortCol = col;
                _capacitySortDir = 'asc';
            }
            _renderCapacity();
        });
    });

    // Searchable persona picker
    _initPersonaPicker(
        '#res-capacity-picker',
        '#res-capacity-persona-search',
        '#res-capacity-picker-list',
        persone,
        id => { _capacityPersonaId = id; _renderCapacity(); }
    );

    // Listener banner sincronizzazione
    panel.querySelector('.btn-sync-all')?.addEventListener('click', () => _sincronizzaTutto(problemiScoperte));
    panel.querySelectorAll('.btn-sync-one').forEach(btn => {
        btn.addEventListener('click', () => _sincronizzaAllocazione(btn.dataset.id));
    });

}

// ─── DISPONIBILITÀ / FABBISOGNO ──────────────────────────────

function _resolveAllocDateRange(a, getEffDates) {
    if (!getEffDates || (!a.aggancioInizio && !a.aggancioFine)) {
        return { di: a.dataInizio, df: a.dataFine };
    }
    const eff = getEffDates(a.codiceCommessa);
    const addM = (ym, delta) => {
        if (!delta || !ym) return ym;
        const [y, m] = ym.split('-').map(Number);
        const t = y * 12 + (m - 1) + delta;
        return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
    };
    return {
        di: a.aggancioInizio && eff?.dataInizio ? addM(eff.dataInizio, a.deltaInizio || 0) : a.dataInizio,
        df: a.aggancioFine && eff?.dataFine ? addM(eff.dataFine, a.deltaFine || 0) : a.dataFine,
    };
}

function _buildDisponibilitaSection(persone, allocazioni, commesse, months, getEffDates, matrix) {
    const oggi = new Date().toISOString().slice(0, 7);

    // Compute future 3 months from today
    const prossimi3 = [];
    for (let i = 0; i <= 3; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() + i);
        prossimi3.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }
    const limite = prossimi3[3];

    // Allocazioni in scadenza nei prossimi 3 mesi (keep _resolveAllocDateRange only here — small set)
    const inScadenza = [];
    allocazioni.forEach(a => {
        const { df } = _resolveAllocDateRange(a, getEffDates);
        if (!df) return;
        const mesFine = df.slice(0, 7);
        if (mesFine >= oggi && mesFine <= limite) {
            const p = persone.find(x => x.id === a.personaId);
            const c = commesse.find(x => x.codice === a.codiceCommessa);
            if (p) inScadenza.push({ p, c, a, mesFine });
        }
    });
    inScadenza.sort((a, b) => a.mesFine.localeCompare(b.mesFine));

    // Use the MATRIX (same data as KPIs) for riconciliazione — guarantees numbers match
    const personeLibere = [];
    const personeSotto = [];
    const personeScoperte = [];
    const personeSovra = [];

    for (const p of persone) {
        const da = p.dataAssunzione?.slice(0, 7) || months[0] || '';
        const a = p.dataTermine?.slice(0, 7) || '2030-12';
        const mesiContratto = months.filter(m => m >= da && m <= a);
        if (mesiContratto.length === 0) continue;

        const pMap = matrix.get(p.id); // allocation data from the matrix

        // Persona senza nessuna allocazione nella matrice per questo periodo
        if (!pMap || mesiContratto.every(m => !pMap.has(m) || pMap.get(m).totalePerc === 0)) {
            personeLibere.push(p);
            continue;
        }

        let mesiSottoCount = 0, costoResidSottoTot = 0, meseEsempioSotto = null, totEsempio = 0;
        let mesiScopertiCount = 0, costoScopertiTot = 0;
        let mesiSovraCount = 0, costoSovraTot = 0, meseEsempioSovra = null, totEsempioSovra = 0;

        for (const mese of mesiContratto) {
            const cell = pMap.get(mese);
            const tot = cell ? cell.totalePerc : 0;

            if (tot === 0) {
                mesiScopertiCount++;
                costoScopertiTot += (p.costoMedioMese || 0);
            } else if (tot < 100) {
                mesiSottoCount++;
                costoResidSottoTot += (p.costoMedioMese || 0) * (100 - tot) / 100;
                if (!meseEsempioSotto) { meseEsempioSotto = mese; totEsempio = tot; }
            } else if (tot > 100) {
                mesiSovraCount++;
                costoSovraTot += (p.costoMedioMese || 0) * (tot - 100) / 100;
                if (!meseEsempioSovra) { meseEsempioSovra = mese; totEsempioSovra = tot; }
            }
        }

        if (mesiSottoCount > 0) {
            personeSotto.push({ p, meseEsempio: meseEsempioSotto, tot: totEsempio, nMesi: mesiSottoCount, costoResiduoTotale: costoResidSottoTot });
        }
        if (mesiScopertiCount > 0) {
            personeScoperte.push({ p, nMesi: mesiScopertiCount, costoTotale: costoScopertiTot });
        }
        if (mesiSovraCount > 0) {
            personeSovra.push({ p, meseEsempio: meseEsempioSovra, tot: totEsempioSovra, nMesi: mesiSovraCount, costoExtraTotale: costoSovraTot });
        }
    }

    const scadenzaRows = inScadenza.map(({ p, c, a, mesFine }) => `
        <tr>
            <td><div class="res-person-name">${p.cognome} ${p.nome}</div></td>
            <td>${p.ruolo || '<span class="text-muted">—</span>'}</td>
            <td><span class="res-commessa-code">${a.codiceCommessa}</span>${c ? ` <span class="res-commessa-nome">${c.nome}</span>` : ''}</td>
            <td><span class="res-perc-badge ${a.percentuale===100?'full':a.percentuale>=50?'half':'low'}">${a.percentuale}%</span></td>
            <td><span class="res-scadenza-badge">${formatYM(mesFine)}</span></td>
            <td>${p.costoMedioMese ? formatEuro(p.costoMedioMese * a.percentuale / 100) : '—'}</td>
        </tr>
    `).join('');

    let totaleCostoLibere = 0;
    const libereRows = personeLibere.map(p => {
        const da = p.dataAssunzione?.slice(0, 7) || months[0] || '';
        const a = p.dataTermine?.slice(0, 7) || '2030-12';
        const mesiContratto = months.filter(m => m >= da && m <= a).length;
        const costoTotale = (p.costoMedioMese || 0) * mesiContratto;
        totaleCostoLibere += costoTotale;
        return `
        <tr>
            <td><div class="res-person-name">${p.cognome} ${p.nome}</div></td>
            <td>${p.ruolo || '<span class="text-muted">—</span>'}</td>
            <td>${p.bu ? `<span class="res-badge bu">${p.bu}</span>` : '—'}</td>
            <td class="col-num">${p.costoMedioMese ? formatEuro(p.costoMedioMese) : '—'}</td>
            <td class="col-num">${mesiContratto}</td>
            <td class="col-num" style="font-weight:600;">${costoTotale ? formatEuro(costoTotale) : '—'}</td>
        </tr>`;
    }).join('');

    let totaleCostoSotto = 0;
    const sottoRows = personeSotto.map(({ p, meseEsempio, tot, nMesi, costoResiduoTotale }) => {
        const costoResiduoMese = (p.costoMedioMese || 0) * (100 - tot) / 100;
        totaleCostoSotto += costoResiduoTotale;
        return `
        <tr>
            <td><div class="res-person-name">${p.cognome} ${p.nome}</div></td>
            <td>${p.ruolo || '<span class="text-muted">—</span>'}</td>
            <td>${p.bu ? `<span class="res-badge bu">${p.bu}</span>` : '—'}</td>
            <td class="col-num"><span class="res-perc-badge low">${tot}%</span></td>
            <td class="col-num">${nMesi} ${nMesi===1?'mese':'mesi'}</td>
            <td class="col-num">${costoResiduoMese ? formatEuro(costoResiduoMese) : '—'}</td>
            <td class="col-num" style="font-weight:600;">${costoResiduoTotale ? formatEuro(costoResiduoTotale) : '—'}</td>
        </tr>`;
    }).join('');

    let totaleCostoScoperte = 0;
    const scoperteRows = personeScoperte.map(({ p, nMesi, costoTotale }) => {
        totaleCostoScoperte += costoTotale;
        return `
        <tr>
            <td><div class="res-person-name">${p.cognome} ${p.nome}</div></td>
            <td>${p.ruolo || '<span class="text-muted">—</span>'}</td>
            <td>${p.bu ? `<span class="res-badge bu">${p.bu}</span>` : '—'}</td>
            <td class="col-num">${p.costoMedioMese ? formatEuro(p.costoMedioMese) : '—'}</td>
            <td class="col-num">${nMesi} ${nMesi===1?'mese':'mesi'}</td>
            <td class="col-num" style="font-weight:600;">${costoTotale ? formatEuro(costoTotale) : '—'}</td>
        </tr>`;
    }).join('');

    let totaleCostoSovra = 0;
    const sovraRows = personeSovra.map(({ p, meseEsempio, tot, nMesi, costoExtraTotale }) => {
        totaleCostoSovra += costoExtraTotale;
        const costoExtraMese = (p.costoMedioMese || 0) * (tot - 100) / 100;
        return `
        <tr>
            <td><div class="res-person-name">${p.cognome} ${p.nome}</div></td>
            <td>${p.ruolo || '<span class="text-muted">—</span>'}</td>
            <td>${p.bu ? `<span class="res-badge bu">${p.bu}</span>` : '—'}</td>
            <td class="col-num"><span class="res-perc-badge" style="background:rgba(239,68,68,.15);color:#ef4444;">${tot}%</span></td>
            <td class="col-num">${nMesi} ${nMesi===1?'mese':'mesi'}</td>
            <td class="col-num">${costoExtraMese ? formatEuro(costoExtraMese) : '—'}</td>
            <td class="col-num" style="font-weight:600;color:var(--success);">${costoExtraTotale ? formatEuro(costoExtraTotale) : '—'}</td>
        </tr>`;
    }).join('');

    return `
        <div class="res-disp-section">
            <div class="res-disp-header">
                <h4>Allocazioni in scadenza (prossimi 3 mesi)</h4>
                <span class="text-muted" style="font-size:.78rem;">${inScadenza.length} ${inScadenza.length===1?'allocazione':'allocazioni'}</span>
            </div>
            <div class="res-disp-body">
                ${inScadenza.length === 0 ? `<p class="res-disp-empty">Nessuna allocazione in scadenza nei prossimi 3 mesi.</p>` : `
                <div class="table-container">
                    <table class="res-table">
                        <thead><tr>
                            <th>Persona</th><th>Ruolo</th><th>Commessa</th>
                            <th class="col-num">%</th><th>Scade in</th><th class="col-num">Costo/Mese</th>
                        </tr></thead>
                        <tbody>${scadenzaRows}</tbody>
                    </table>
                </div>`}
            </div>
        </div>

        ${personeLibere.length > 0 ? `
        <div class="res-disp-section">
            <div class="res-disp-header">
                <h4>Risorse non allocate in questo scenario</h4>
                <span class="text-muted" style="font-size:.78rem;">${personeLibere.length} ${personeLibere.length===1?'persona':'persone'} — Costo totale: <strong>${formatEuro(totaleCostoLibere)}</strong></span>
            </div>
            <div class="res-disp-body">
                <div class="table-container">
                    <table class="res-table">
                        <thead><tr>
                            <th>Persona</th><th>Ruolo</th><th>BU</th><th class="col-num">Costo/Mese</th><th class="col-num">Mesi</th><th class="col-num">Costo Totale</th>
                        </tr></thead>
                        <tbody>${libereRows}</tbody>
                        <tfoot><tr style="border-top:2px solid var(--accent);font-weight:700;">
                            <td colspan="5" style="text-align:right;">Totale non allocate</td>
                            <td class="col-num">${formatEuro(totaleCostoLibere)}</td>
                        </tr></tfoot>
                    </table>
                </div>
            </div>
        </div>` : ''}

        ${personeSotto.length > 0 ? `
        <div class="res-disp-section">
            <div class="res-disp-header">
                <h4>Risorse sotto-allocate (capacità residua disponibile)</h4>
                <span class="text-muted" style="font-size:.78rem;">${personeSotto.length} ${personeSotto.length===1?'persona':'persone'} — Costo residuo totale: <strong>${formatEuro(totaleCostoSotto)}</strong></span>
            </div>
            <div class="res-disp-body">
                <div class="table-container">
                    <table class="res-table">
                        <thead><tr>
                            <th>Persona</th><th>Ruolo</th><th>BU</th>
                            <th class="col-num">Saturazione</th><th class="col-num">Mesi Parziali</th><th class="col-num">Residuo/Mese</th><th class="col-num">Costo Residuo Tot.</th>
                        </tr></thead>
                        <tbody>${sottoRows}</tbody>
                        <tfoot><tr style="border-top:2px solid var(--accent);font-weight:700;">
                            <td colspan="6" style="text-align:right;">Totale sotto-allocate</td>
                            <td class="col-num">${formatEuro(totaleCostoSotto)}</td>
                        </tr></tfoot>
                    </table>
                </div>
            </div>
        </div>` : ''}

        ${personeScoperte.length > 0 ? `
        <div class="res-disp-section">
            <div class="res-disp-header">
                <h4>Risorse con mesi scoperti (allocate parzialmente nel periodo)</h4>
                <span class="text-muted" style="font-size:.78rem;">${personeScoperte.length} ${personeScoperte.length===1?'persona':'persone'} — Costo scoperto totale: <strong>${formatEuro(totaleCostoScoperte)}</strong></span>
            </div>
            <div class="res-disp-body">
                <div class="table-container">
                    <table class="res-table">
                        <thead><tr>
                            <th>Persona</th><th>Ruolo</th><th>BU</th>
                            <th class="col-num">Costo/Mese</th><th class="col-num">Mesi Scoperti</th><th class="col-num">Costo Scoperto Tot.</th>
                        </tr></thead>
                        <tbody>${scoperteRows}</tbody>
                        <tfoot><tr style="border-top:2px solid var(--accent);font-weight:700;">
                            <td colspan="5" style="text-align:right;">Totale mesi scoperti</td>
                            <td class="col-num">${formatEuro(totaleCostoScoperte)}</td>
                        </tr></tfoot>
                    </table>
                </div>
            </div>
        </div>` : ''}

        ${personeSovra.length > 0 ? `
        <div class="res-disp-section">
            <div class="res-disp-header">
                <h4>Risorse sovra-allocate (&gt;100%)</h4>
                <span class="text-muted" style="font-size:.78rem;">${personeSovra.length} ${personeSovra.length===1?'persona':'persone'} — Costo extra totale: <strong style="color:var(--success);">${formatEuro(totaleCostoSovra)}</strong></span>
            </div>
            <div class="res-disp-body">
                <div class="table-container">
                    <table class="res-table">
                        <thead><tr>
                            <th>Persona</th><th>Ruolo</th><th>BU</th>
                            <th class="col-num">Saturazione</th><th class="col-num">Mesi</th><th class="col-num">Extra/Mese</th><th class="col-num">Costo Extra Tot.</th>
                        </tr></thead>
                        <tbody>${sovraRows}</tbody>
                        <tfoot><tr style="border-top:2px solid var(--accent);font-weight:700;">
                            <td colspan="6" style="text-align:right;">Totale sovra-allocate</td>
                            <td class="col-num" style="color:var(--success);">${formatEuro(totaleCostoSovra)}</td>
                        </tr></tfoot>
                    </table>
                </div>
            </div>
        </div>` : ''}

        <div class="res-disp-section" style="background:var(--bg-dark);border-color:var(--accent);">
            <div class="res-disp-body" style="padding:12px 16px;">
                <h4 style="margin:0 0 8px;font-size:13px;">Riconciliazione Assorbimento</h4>
                <table class="res-table" style="font-size:12px;">
                    <tbody>
                        <tr><td>Risorse non allocate</td><td class="col-num" style="font-weight:600;">-${formatEuro(totaleCostoLibere)}</td></tr>
                        <tr><td>Risorse sotto-allocate (residuo)</td><td class="col-num" style="font-weight:600;">-${formatEuro(totaleCostoSotto)}</td></tr>
                        <tr><td>Risorse con mesi scoperti</td><td class="col-num" style="font-weight:600;">-${formatEuro(totaleCostoScoperte)}</td></tr>
                        ${totaleCostoSovra > 0 ? `<tr><td>Risorse sovra-allocate (compensazione)</td><td class="col-num" style="font-weight:600;color:var(--success);">+${formatEuro(totaleCostoSovra)}</td></tr>` : ''}
                        <tr style="border-top:2px solid var(--accent);font-weight:700;font-size:13px;">
                            <td>Totale = ${(totaleCostoLibere + totaleCostoSotto + totaleCostoScoperte - totaleCostoSovra) > 0 ? 'Sotto' : 'Sovra'}-assorbimento</td>
                            <td class="col-num">${formatEuro(-(totaleCostoLibere + totaleCostoSotto + totaleCostoScoperte - totaleCostoSovra))}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

// ─── MODAL: PERSONA ──────────────────────────────────────────

function _openPersonaModal(id) {
    _editingPersonaId = id;
    const p = id ? getPersona(id) : null;
    $('#res-pm-title').textContent = id ? 'Modifica Persona' : 'Nuova Persona';
    $('#res-pm-cognome').value = p?.cognome || '';
    $('#res-pm-nome').value = p?.nome || '';
    $('#res-pm-cf').value = p?.codiceFiscale || '';

    // Populate ruolo dropdown
    const ruoloSelect = $('#res-pm-ruolo');
    const ruoli = listRuoli().sort((a, b) => a.nome.localeCompare(b.nome));
    ruoloSelect.innerHTML = '<option value="">— Seleziona ruolo —</option>'
        + ruoli.map(r => `<option value="${r.nome}" data-costo="${r.costoMedio}">${r.nome}</option>`).join('');

    // Set current value (match by name, or add as custom option if not in list)
    const currentRuolo = p?.ruolo || '';
    if (currentRuolo && !ruoli.some(r => r.nome === currentRuolo)) {
        ruoloSelect.insertAdjacentHTML('beforeend',
            `<option value="${currentRuolo}" selected>${currentRuolo} (non in elenco)</option>`);
    }
    ruoloSelect.value = currentRuolo;

    // Auto-fill cost when role changes
    let _lastRuoloCosto = 0; // track the cost set by role selection
    ruoloSelect.onchange = () => {
        const selected = ruoloSelect.selectedOptions[0];
        const costoSuggerito = Number(selected?.dataset.costo) || 0;
        const costoInput = $('#res-pm-costo');
        const costoAttuale = Number(costoInput.value) || 0;
        // Update cost if: empty, zero, or still matching the previous role's cost
        if (costoSuggerito > 0 && (costoAttuale === 0 || costoAttuale === _lastRuoloCosto)) {
            costoInput.value = costoSuggerito;
        }
        _lastRuoloCosto = costoSuggerito;
    };

    $('#res-pm-contratto').value = p?.tipoContratto || 'DIPENDENTE';
    $('#res-pm-societa').value = p?.societa || '';
    $('#res-pm-bu').value = p?.bu || '';
    $('#res-pm-cdc').value = p?.cdc || '';
    $('#res-pm-stato-assunzione').value = p?.statoAssunzione || 'assunta';
    $('#res-pm-costo').value = p?.costoMedioMese || '';
    $('#res-pm-data-ass').value = p?.dataAssunzione || '';
    $('#res-pm-data-term').value = p?.dataTermine || '';
    $('#res-pm-note').value = p?.note || '';
    $('#res-pm-error').textContent = '';
    _openModal('res-persona-modal');
}

function _savePersonaFromModal() {
    const cognome = $('#res-pm-cognome').value.trim();
    if (!cognome) { $('#res-pm-error').textContent = 'Cognome obbligatorio'; return; }

    const result = savePersona({
        id: _editingPersonaId || undefined,
        cognome, nome: $('#res-pm-nome').value.trim(),
        codiceFiscale: $('#res-pm-cf').value.trim(),
        ruolo: $('#res-pm-ruolo').value.trim(),
        tipoContratto: $('#res-pm-contratto').value,
        societa: $('#res-pm-societa').value.trim(),
        bu: $('#res-pm-bu').value.trim(),
        cdc: $('#res-pm-cdc').value.trim(),
        statoAssunzione: $('#res-pm-stato-assunzione').value || 'assunta',
        costoMedioMese: parseFloat($('#res-pm-costo').value) || 0,
        dataAssunzione: $('#res-pm-data-ass').value,
        dataTermine: $('#res-pm-data-term').value,
        note: $('#res-pm-note').value.trim(),
    });

    if (result?.error) { $('#res-pm-error').textContent = result.error; return; }
    _closeModal('res-persona-modal');
    _renderPersone();
}

// ─── MODAL: ALLOCAZIONE ──────────────────────────────────────

function _openAllocModal(allocId, defaultPersonaId) {
    _editingAllocId = allocId;
    const alloc = allocId ? getAllocazione(allocId) : null;
    const persone = listPersone();
    const commesse = _ctx.getCommesse();
    const scenarios = _ctx.getScenarios();
    const scenarioId = alloc?.scenarioId !== undefined ? alloc.scenarioId : _resolveScenarioId();

    $('#res-alloc-title').textContent = allocId ? 'Modifica Allocazione' : 'Nuova Allocazione';

    // Searchable persona picker
    const selectedPersonaId = alloc?.personaId || defaultPersonaId || '';
    const selectedPersona = selectedPersonaId ? persone.find(p => p.id === selectedPersonaId) : null;
    $('#res-alloc-persona').value = selectedPersonaId;
    const searchInput = $('#res-alloc-persona-search');
    if (searchInput) searchInput.value = selectedPersona ? `${selectedPersona.cognome} ${selectedPersona.nome}` : '';
    const pickerList = $('#res-alloc-persona-list');
    if (pickerList) {
        pickerList.innerHTML =
            `<div class="res-picker-option" data-id="">— Seleziona persona —</div>` +
            persone.map(p => `<div class="res-picker-option${selectedPersonaId === p.id ? ' selected' : ''}" data-id="${p.id}"><span class="res-picker-name">${p.cognome} ${p.nome}</span>${p.ruolo ? `<span class="res-picker-ruolo">${p.ruolo}</span>` : ''}</div>`).join('');
    }
    _initPersonaPicker(
        '#res-alloc-persona-picker',
        '#res-alloc-persona-search',
        '#res-alloc-persona-list',
        persone,
        id => { $('#res-alloc-persona').value = id || ''; _updateAllocPreview(); _checkAllocSat(); }
    );

    // Searchable commessa picker
    const selectedCodice = alloc?.codiceCommessa || '';
    const selectedCommessa = selectedCodice ? commesse.find(c => c.codice === selectedCodice) : null;
    $('#res-alloc-commessa').value = selectedCodice;
    const commessaSearchInput = $('#res-alloc-commessa-search');
    if (commessaSearchInput) commessaSearchInput.value = selectedCommessa ? `${selectedCommessa.codice} — ${selectedCommessa.nome}` : '';
    const commessaPickerList = $('#res-alloc-commessa-list');
    if (commessaPickerList) {
        commessaPickerList.innerHTML =
            `<div class="res-picker-option" data-id="">— Seleziona commessa —</div>` +
            commesse.map(c => `<div class="res-picker-option${selectedCodice === c.codice ? ' selected' : ''}" data-id="${c.codice}"><span class="res-picker-name">${c.codice} — ${c.nome}</span></div>`).join('');
    }
    _initPersonaPicker(
        '#res-alloc-commessa-picker',
        '#res-alloc-commessa-search',
        '#res-alloc-commessa-list',
        commesse,
        id => { $('#res-alloc-commessa').value = id || ''; _updateDeltaHint('di'); _updateDeltaHint('df'); },
        id => { const c = commesse.find(x => x.codice === id); return c ? `${c.codice} — ${c.nome}` : ''; }
    );

    const scenarioSel = $('#res-alloc-scenario-modal');
    scenarioSel.innerHTML = `<option value=""${!scenarioId?' selected':''}>Baseline</option>` +
        scenarios.map(s => `<option value="${s.id}"${scenarioId===s.id?' selected':''}>${s.name}</option>`).join('');

    $('#res-alloc-perc').value = alloc?.percentuale ?? 100;
    $('#res-alloc-di').value = alloc?.dataInizio || '';
    $('#res-alloc-df').value = alloc?.dataFine || '';
    $('#res-alloc-note').value = alloc?.note || '';
    $('#res-alloc-error').textContent = '';
    $('#res-alloc-warn').textContent = '';
    $('#res-alloc-costo-preview').textContent = '';

    // Flag aggancio + delta
    const chkDi = $('#chk-aggancio-di');
    const chkDf = $('#chk-aggancio-df');
    if (chkDi) chkDi.checked = alloc?.aggancioInizio || false;
    if (chkDf) chkDf.checked = alloc?.aggancioFine || false;
    const diDelta = $('#res-delta-di'); if (diDelta) diDelta.value = alloc?.deltaInizio || 0;
    const dfDelta = $('#res-delta-df'); if (dfDelta) dfDelta.value = alloc?.deltaFine   || 0;
    _updateMagnetButtons();

    _updateAllocPreview();
    _openModal('res-alloc-modal');
}

const _magnetIcon = `<svg class="res-magnet-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" title="Agganciato alla commessa"><path d="M6 15L3 12l9-9 9 9-3 3"/><path d="M6 15l3 3a9 9 0 0 0 9-9"/><line x1="12" y1="12" x2="12" y2="21"/></svg>`;

function _fmtDateCell(ym, agganciato, effDate = null) {
    const display = agganciato && effDate ? effDate : ym;
    return agganciato
        ? `<span class="res-date-agganciata" title="Agganciato alla commessa${effDate && effDate !== ym ? ' — data aggiornata dallo scenario' : ''}">${_magnetIcon}${formatYM(display)}</span>`
        : formatYM(ym);
}

/** Restituisce le date effettive di un'allocazione (rispetta flag aggancio + delta mesi) */
function _effDates(alloc) {
    if (!alloc.aggancioInizio && !alloc.aggancioFine) return { di: null, df: null };
    const eff = _ctx.getEffectiveCommessaDates(alloc.codiceCommessa);
    const applyDelta = (ym, delta) => (delta && ym) ? addMonths(ym, delta) : ym;
    return {
        di: alloc.aggancioInizio ? applyDelta(eff?.dataInizio || null, alloc.deltaInizio || 0) : null,
        df: alloc.aggancioFine   ? applyDelta(eff?.dataFine   || null, alloc.deltaFine  || 0) : null,
    };
}

function _updateMagnetButtons() {
    const di = $('#chk-aggancio-di')?.checked;
    const df = $('#chk-aggancio-df')?.checked;
    $('#btn-magnet-di')?.classList.toggle('active', !!di);
    $('#btn-magnet-df')?.classList.toggle('active', !!df);

    // Mostra/nascondi riga delta
    const wrapDi = $('#res-delta-di-wrap');
    const wrapDf = $('#res-delta-df-wrap');
    if (wrapDi) wrapDi.style.display = di ? 'flex' : 'none';
    if (wrapDf) wrapDf.style.display = df ? 'flex' : 'none';

    // Aggiorna hint data risultante
    _updateDeltaHint('di');
    _updateDeltaHint('df');
}

/** Risolve lo scenarioId dalla modal allocazione (gestisce __current__ e __baseline__) */
function _modalScenarioId() {
    const val = $('#res-alloc-scenario-modal')?.value;
    if (!val || val === '__baseline__') return null;   // vuoto = Baseline
    if (val === '__current__') return _ctx.getActiveScenarioId();
    return val;
}

function _updateDeltaHint(field) {
    const codice = $('#res-alloc-commessa')?.value;
    const agganciato = $(`#chk-aggancio-${field}`)?.checked;
    const hint = $(`#res-delta-${field}-hint`);
    if (!hint) return;
    if (!agganciato || !codice) { hint.textContent = ''; return; }
    const eff = _ctx.getEffectiveCommessaDates(codice, _modalScenarioId());
    const base = field === 'di' ? eff?.dataInizio : eff?.dataFine;
    if (!base) { hint.textContent = ''; return; }
    const delta = parseInt($(`#res-delta-${field}`)?.value) || 0;
    const risultante = delta ? addMonths(base, delta) : base;
    hint.textContent = `→ ${formatYM(risultante)}`;
}

function _applyMagnet(field) {
    const codice = $('#res-alloc-commessa')?.value;
    if (!codice) return;
    const eff = _ctx.getEffectiveCommessaDates(codice, _modalScenarioId());
    if (!eff) return;
    const delta = parseInt($(`#res-delta-${field}`)?.value) || 0;
    if (field === 'di') {
        const base = eff.dataInizio || '';
        $('#res-alloc-di').value = delta ? addMonths(base, delta) : base;
        $('#chk-aggancio-di').checked = true;
    } else {
        const base = eff.dataFine || '';
        $('#res-alloc-df').value = delta ? addMonths(base, delta) : base;
        $('#chk-aggancio-df').checked = true;
    }
    _updateMagnetButtons();
    _updateAllocPreview();
    _checkAllocSat();
}

function _updateAllocPreview() {
    const personaId = $('#res-alloc-persona')?.value;
    const perc = parseFloat($('#res-alloc-perc')?.value) || 0;
    const p = personaId ? getPersona(personaId) : null;
    const el = $('#res-alloc-costo-preview');
    if (el) el.textContent = p && perc > 0 ? `Costo mensile allocato: ${formatEuro((p.costoMedioMese || 0) * perc / 100)}` : '';
    _checkTerminazionePersona();
}

function _checkTerminazionePersona() {
    const warn = $('#res-alloc-termine-warn');
    if (!warn) return;
    const personaId = $('#res-alloc-persona')?.value;
    const df = $('#res-alloc-df')?.value;
    const p = personaId ? getPersona(personaId) : null;
    if (!p) { warn.style.display = 'none'; return; }

    const lines = [];
    if (!_isPersonaAttiva(p)) {
        lines.push('Persona non più attiva in azienda.');
    }
    if (p.dataTermine) {
        const termine = p.dataTermine.slice(0, 7);
        if (df && df > termine) {
            lines.push(`Rapporto ${termine <= new Date().toISOString().slice(0,7) ? 'cessato' : 'cesserà'} a ${formatYM(termine)} — l'allocazione supera questa data.`);
        } else if (!df) {
            lines.push(`Attenzione: rapporto ${termine <= new Date().toISOString().slice(0,7) ? 'cessato' : 'cesserà'} a ${formatYM(termine)}.`);
        }
    }

    if (lines.length) {
        warn.style.display = 'flex';
        warn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div>${lines.join('<br>')}</div>`;
    } else {
        warn.style.display = 'none';
    }
}

function _checkAllocSat() {
    const personaId = $('#res-alloc-persona')?.value;
    const perc = parseFloat($('#res-alloc-perc')?.value) || 0;
    const di = $('#res-alloc-di')?.value;
    const df = $('#res-alloc-df')?.value;
    const scenarioId = $('#res-alloc-scenario-modal')?.value || null;
    const warn = $('#res-alloc-warn');
    if (!warn || !personaId || !perc || !di || !df) { if (warn) warn.textContent = ''; return; }

    const existing = listAllocazioni();
    const mesi = getMonthsInRange(di, df);
    const overMesi = [];
    for (const mese of mesi) {
        const tot = existing
            .filter(a => a.id !== _editingAllocId && a.personaId === personaId && a.scenarioId === scenarioId)
            .filter(a => a.dataInizio && a.dataFine && isMonthInRange(mese, a.dataInizio, a.dataFine))
            .reduce((s, a) => s + a.percentuale, 0);
        if (tot + perc > 100) overMesi.push(`${formatYM(mese)} (${tot + perc}%)`);
    }
    if (overMesi.length) {
        warn.className = 'res-alloc-error-msg';
        warn.textContent = `⚠ Saturazione > 100%: ${overMesi.slice(0, 3).join(', ')}${overMesi.length > 3 ? '…' : ''}`;
    } else {
        warn.className = 'res-alloc-info-msg';
        const max = mesi.reduce((mx, mese) => {
            const tot = existing
                .filter(a => a.id !== _editingAllocId && a.personaId === personaId && a.scenarioId === scenarioId)
                .filter(a => isMonthInRange(mese, a.dataInizio, a.dataFine))
                .reduce((s, a) => s + a.percentuale, 0);
            return Math.max(mx, tot + perc);
        }, 0);
        warn.textContent = max < 100 && max > 0 ? `Saturazione massima: ${max}% — risorsa parzialmente allocata` : '';
    }
}

function _saveAllocFromModal() {
    const personaId = $('#res-alloc-persona').value;
    const codiceCommessa = $('#res-alloc-commessa').value;
    const scenarioId = $('#res-alloc-scenario-modal').value || null;
    const percentuale = parseFloat($('#res-alloc-perc').value);
    const dataInizio = $('#res-alloc-di').value;
    const dataFine = $('#res-alloc-df').value;
    const note = $('#res-alloc-note').value.trim();
    const errEl = $('#res-alloc-error');

    if (!personaId) { errEl.textContent = 'Seleziona una persona'; return; }
    if (!codiceCommessa) { errEl.textContent = 'Seleziona una commessa'; return; }
    if (!percentuale || percentuale <= 0 || percentuale > 100) { errEl.textContent = 'Percentuale non valida (1–100)'; return; }
    if (!dataInizio || !dataFine) { errEl.textContent = 'Date obbligatorie'; return; }
    if (dataInizio > dataFine) { errEl.textContent = 'Data inizio > data fine'; return; }

    // Verifica coerenza con il contratto della persona
    const _persona = getPersona(personaId);
    if (_persona) {
        const assunz = _persona.dataAssunzione?.slice(0, 7);
        const termin = _persona.dataTermine?.slice(0, 7);
        const diMese = dataInizio.slice(0, 7);
        const dfMese = dataFine.slice(0, 7);
        if (assunz && diMese < assunz) {
            if (!confirm(`Attenzione: l'allocazione inizia a ${formatYM(diMese)} ma ${_persona.cognome} ${_persona.nome} viene assunto/a a ${formatYM(assunz)}.\n\nI mesi prima dell'assunzione non verranno conteggiati.\nVuoi procedere comunque?`)) return;
        }
        if (termin && dfMese > termin) {
            if (!confirm(`Attenzione: l'allocazione termina a ${formatYM(dfMese)} ma ${_persona.cognome} ${_persona.nome} ${termin <= new Date().toISOString().slice(0,7) ? 'è cessato/a' : 'cesserà'} a ${formatYM(termin)}.\n\nI mesi dopo la cessazione non verranno conteggiati.\nVuoi procedere comunque?`)) return;
        }
    }

    const aggancioInizio = $('#chk-aggancio-di')?.checked || false;
    const aggancioFine   = $('#chk-aggancio-df')?.checked || false;
    const deltaInizio    = aggancioInizio ? (parseInt($('#res-delta-di')?.value) || 0) : 0;
    const deltaFine      = aggancioFine   ? (parseInt($('#res-delta-df')?.value) || 0) : 0;

    const result = saveAllocazione({
        id: _editingAllocId || undefined,
        personaId, codiceCommessa, scenarioId, percentuale, dataInizio, dataFine,
        aggancioInizio, aggancioFine, deltaInizio, deltaFine, note,
    });
    if (result?.error) { errEl.textContent = result.error; return; }
    _closeModal('res-alloc-modal');
    _renderSubTab(_currentSubTab);
}

// ─── MODAL: COPIA ALLOCAZIONI ─────────────────────────────────

function _openCopyAllocModal() {
    const scenarios = _ctx.getScenarios();
    const toId = _resolveScenarioId();
    const sel = $('#res-copy-from-sel');
    if (sel) {
        sel.innerHTML = '<option value="">— Seleziona scenario sorgente —</option>' +
            scenarios.filter(s => s.id !== toId).map(s => {
                const n = listAllocazioni({ scenarioId: s.id }).length;
                return `<option value="${s.id}">${s.name} (${n} allocazioni)</option>`;
            }).join('');
    }
    const toLabel = $('#res-copy-to-label');
    if (toLabel) {
        const sc = scenarios.find(s => s.id === toId);
        toLabel.textContent = sc ? sc.name : (toId ? toId : 'Baseline');
    }
    $('#res-copy-alloc-error').textContent = '';
    $('#chk-copy-overwrite').checked = false;
    _openModal('res-copy-alloc-modal');
}

function _confirmCopyAlloc() {
    const fromId = $('#res-copy-from-sel')?.value;
    const toId = _resolveScenarioId();
    if (!fromId) { $('#res-copy-alloc-error').textContent = 'Seleziona lo scenario sorgente'; return; }
    if (fromId === toId) { $('#res-copy-alloc-error').textContent = 'Sorgente e destinazione coincidono'; return; }
    if ($('#chk-copy-overwrite')?.checked) deleteAllocazioniScenario(toId);
    const n = copyAllocazioniScenario(fromId, toId);
    _closeModal('res-copy-alloc-modal');
    _renderSubTab(_currentSubTab);
    _showToast(`Copiate ${n} allocazioni`);
}

// ─── MODAL: IMPORT ───────────────────────────────────────────

function _openImportModal(tipo) {
    _importTipo = tipo;
    _importData = null;
    $('#res-import-title').textContent = tipo === 'persone' ? 'Importa Persone da Excel' : 'Importa Allocazioni da Excel';
    $('#res-import-desc').innerHTML = tipo === 'persone'
        ? 'Colonne richieste: <strong>Cognome</strong>, <strong>Nome</strong>. Opzionali: CodiceFiscale, Ruolo, TipoContratto, Società, BU, CDC, CostoMedioMese, DataAssunzione, DataTermine, Note.'
        : 'Colonne richieste: <strong>Cognome</strong>, <strong>Nome</strong>, <strong>CodiceCommessa</strong>, <strong>Percentuale</strong>, <strong>DataInizio</strong>, <strong>DataFine</strong>. Opzionali: AggancioInizio, AggancioFine (Sì/No), DeltaInizio, DeltaFine (mesi), CodiceFiscale, Scenario, Note.';
    $('#res-import-file').value = '';
    $('#res-import-preview').innerHTML = '';
    $('#res-import-result').innerHTML = '';
    $('#btn-res-import-confirm').disabled = true;
    _openModal('res-import-modal');
}

function _handleImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        try {
            const wb = XLSX.read(new Uint8Array(ev.target.result), { type: 'array' });
            const targetSheet = _importTipo === 'persone' ? 'Persone' : 'Allocazioni';
            const sheetName = wb.SheetNames.includes(targetSheet) ? targetSheet : wb.SheetNames[0];
            const ws = wb.Sheets[sheetName];
            const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
            if (!raw.length) { $('#res-import-result').innerHTML = '<span class="res-error-text">File vuoto</span>'; return; }
            _importData = raw.map(row => {
                const norm = {};
                for (const [k, v] of Object.entries(row)) norm[_normalizeCol(k)] = v;
                return norm;
            });
            const preview = _importData.slice(0, 5);
            const cols = Object.keys(_importData[0]);
            const sheetInfo = wb.SheetNames.includes(targetSheet)
                ? `foglio <strong>${sheetName}</strong>`
                : `foglio <strong>${sheetName}</strong> (primo disponibile)`;
            $('#res-import-preview').innerHTML = `
                <div class="res-import-info">${_importData.length} righe trovate da ${sheetInfo} — anteprima (prime 5):</div>
                <div style="overflow-x:auto;margin-top:8px;">
                    <table class="res-table" style="font-size:11px;">
                        <thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
                        <tbody>${preview.map(r => `<tr>${cols.map(c => `<td>${r[c]}</td>`).join('')}</tr>`).join('')}</tbody>
                    </table>
                </div>
            `;
            $('#btn-res-import-confirm').disabled = false;
        } catch (err) {
            $('#res-import-result').innerHTML = `<span class="res-error-text">Errore lettura file: ${err.message}</span>`;
        }
    };
    reader.readAsArrayBuffer(file);
}

function _normalizeCol(name) {
    const map = {
        'cognome':'cognome','nome':'nome','codice fiscale':'codiceFiscale','codicefiscale':'codiceFiscale','cf':'codiceFiscale',
        'ruolo':'ruolo','ruolo/mansione':'ruolo','mansione':'ruolo',
        'tipo contratto':'tipoContratto','tipocontratto':'tipoContratto','contratto':'tipoContratto',
        'societa':'societa','società':'societa','societa ':'societa','società ':'societa',
        'bu':'bu','cdc':'cdc','vdc':'vdc','tdc':'tdc',
        'costo medio mese':'costoMedioMese','costomedioмесе':'costoMedioMese','costo/mese':'costoMedioMese','costo medio mensile':'costoMedioMese',
        'data assunzione':'dataAssunzione','dataassunzione':'dataAssunzione',
        'data termine':'dataTermine','datatermine':'dataTermine',
        'note':'note',
        'codice commessa':'codiceCommessa','codicecommessa':'codiceCommessa','commessa':'codiceCommessa',
        '% incidenza':'percentuale','percentuale':'percentuale','perc':'percentuale','% allocazione':'percentuale',
        'data inizio':'dataInizio','datainizio':'dataInizio','data_inizio':'dataInizio',
        'data fine':'dataFine','datafine':'dataFine','data_fine':'dataFine',
        'aggancio inizio':'aggancioInizio','aggancioinizio':'aggancioInizio',
        'aggancio fine':'aggancioFine','agganciofine':'aggancioFine',
        'delta inizio (mesi)':'deltaInizio','deltainizio':'deltaInizio','delta inizio':'deltaInizio',
        'delta fine (mesi)':'deltaFine','deltafine':'deltaFine','delta fine':'deltaFine',
        'scenario':'scenario',
    };
    return map[name.toLowerCase().trim()] || name;
}

function _confirmImport() {
    if (!_importData) return;
    const scenarioId = _resolveScenarioId();
    const commesse = _ctx.getCommesse();
    let r;
    if (_importTipo === 'persone') {
        r = importPersoneFromRows(_importData);
    } else {
        r = importAllocazioniFromRows(_importData, scenarioId, commesse);
    }
    const lines = [];
    if (r.created) lines.push(`<span class="res-ok-text">✓ ${r.created} creati</span>`);
    if (r.updated) lines.push(`<span class="res-ok-text">✓ ${r.updated} aggiornati</span>`);
    if (r.warnings?.length) lines.push(`<span class="res-warn-inline">⚠ ${r.warnings.length} warning</span>`);
    r.errors?.forEach(e => lines.push(`<span class="res-error-text">✗ ${e}</span>`));
    $('#res-import-result').innerHTML = lines.join('<br>');
    $('#btn-res-import-confirm').disabled = true;
    if (!r.errors?.length) {
        setTimeout(() => { _closeModal('res-import-modal'); _renderSubTab(_currentSubTab); }, 1200);
    }
}

// ─── MODALS SETUP ─────────────────────────────────────────────

function _setupModals() {
    // Delegate close on backdrop
    document.addEventListener('click', e => {
        if (e.target.classList.contains('modal-backdrop')) {
            ['res-persona-modal','res-alloc-modal','res-copy-alloc-modal','res-import-modal'].forEach(_closeModal);
        }
    });

    // Persona modal
    $('#res-persona-modal-close')?.addEventListener('click', () => _closeModal('res-persona-modal'));
    $('#btn-res-pm-save')?.addEventListener('click', _savePersonaFromModal);

    // Alloc modal
    $('#res-alloc-modal-close')?.addEventListener('click', () => _closeModal('res-alloc-modal'));
    $('#btn-res-alloc-save')?.addEventListener('click', _saveAllocFromModal);

    $('#res-alloc-perc')?.addEventListener('input', () => { _updateAllocPreview(); _checkAllocSat(); });
    $('#res-alloc-di')?.addEventListener('change', () => { $('#chk-aggancio-di').checked = false; _updateMagnetButtons(); _checkAllocSat(); });
    $('#res-alloc-df')?.addEventListener('change', () => { $('#chk-aggancio-df').checked = false; _updateMagnetButtons(); _checkAllocSat(); _checkTerminazionePersona(); });
    $('#res-alloc-scenario-modal')?.addEventListener('change', () => { _checkAllocSat(); _updateDeltaHint('di'); _updateDeltaHint('df'); });
    $('#btn-magnet-di')?.addEventListener('click', () => _applyMagnet('di'));
    $('#btn-magnet-df')?.addEventListener('click', () => _applyMagnet('df'));
    $('#chk-aggancio-di')?.addEventListener('change', _updateMagnetButtons);
    $('#chk-aggancio-df')?.addEventListener('change', _updateMagnetButtons);
    $('#res-delta-di')?.addEventListener('input', () => { _updateDeltaHint('di'); if ($('#chk-aggancio-di')?.checked) _applyMagnet('di'); });
    $('#res-delta-df')?.addEventListener('input', () => { _updateDeltaHint('df'); if ($('#chk-aggancio-df')?.checked) _applyMagnet('df'); });

    // Copy alloc modal
    $('#res-copy-alloc-modal-close')?.addEventListener('click', () => _closeModal('res-copy-alloc-modal'));
    $('#btn-res-copy-confirm')?.addEventListener('click', _confirmCopyAlloc);

    // Import modal
    $('#res-import-modal-close')?.addEventListener('click', () => _closeModal('res-import-modal'));
    $('#res-import-file')?.addEventListener('change', _handleImportFile);
    $('#btn-res-import-confirm')?.addEventListener('click', _confirmImport);
    $('#btn-res-download-template')?.addEventListener('click', _downloadImportTemplate);

    // Rinomina commessa modal
    $('#res-rename-commessa-close')?.addEventListener('click', () => _closeModal('res-rename-commessa-modal'));
    $('#res-rename-commessa-cancel')?.addEventListener('click', () => _closeModal('res-rename-commessa-modal'));
    $('#btn-res-rename-confirm')?.addEventListener('click', _saveRenameCommessa);
}

function _downloadImportTemplate() {
    const wb = XLSX.utils.book_new();
    if (_importTipo === 'persone') {
        const ws = XLSX.utils.aoa_to_sheet([[
            'Cognome','Nome','CodiceFiscale','Ruolo','TipoContratto',
            'Società','BU','CDC','CostoMedioMese','DataAssunzione','DataTermine','Note'
        ]]);
        XLSX.utils.book_append_sheet(wb, ws, 'Persone');
        XLSX.writeFile(wb, 'template_persone.xlsx');
    } else {
        const ws = XLSX.utils.aoa_to_sheet([[
            'Cognome','Nome','CodiceCommessa','Percentuale','DataInizio','DataFine',
            'AggancioInizio','AggancioFine','DeltaInizio','DeltaFine','Note'
        ]]);
        XLSX.utils.book_append_sheet(wb, ws, 'Allocazioni');
        XLSX.writeFile(wb, 'template_allocazioni.xlsx');
    }
}

function _injectDuplicateCheckbox() {
    const body = document.querySelector('#duplicate-scenario-modal .modal-body');
    if (!body || $('#chk-copy-allocazioni')) return;
    const wrap = document.createElement('div');
    wrap.className = 'form-group';
    wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:4px;';
    wrap.innerHTML = `
        <input type="checkbox" id="chk-copy-allocazioni" style="width:auto;margin:0;" />
        <label for="chk-copy-allocazioni" style="cursor:pointer;margin:0;font-weight:400;">Copia anche le allocazioni risorse</label>
    `;
    const btn = body.querySelector('#btn-confirm-duplicate');
    if (btn) body.insertBefore(wrap, btn); else body.appendChild(wrap);
}

// ─── EXPORT ───────────────────────────────────────────────────

function _exportRisorse() {
    const persone = listPersone();
    if (!persone.length) { _showToast('Nessuna persona da esportare'); return; }

    const scenarioId = _resolveScenarioId();
    const commesse = _ctx.getCommesse();
    const allocazioni = listAllocazioni({ scenarioId });

    // Raccolta mesi
    const monthSet = new Set();
    allocazioni.forEach(a => {
        if (a.dataInizio && a.dataFine)
            getMonthsInRange(a.dataInizio, a.dataFine).forEach(m => monthSet.add(m));
    });
    const months = [...monthSet].sort();

    const matrix = computeResourceMatrix(scenarioId, commesse, months, _ctx.getEffectiveCommessaDates);
    const wb = XLSX.utils.book_new();

    // Sheet 1 — Anagrafica Persone
    const personRows = persone.map(p => ({
        'Cognome': p.cognome,
        'Nome': p.nome,
        'Codice Fiscale': p.codiceFiscale || '',
        'Ruolo': p.ruolo || '',
        'Tipo Contratto': p.tipoContratto || '',
        'Società': p.societa || '',
        'BU': p.bu || '',
        'CDC': p.cdc || '',
        'Costo Medio Mese': p.costoMedioMese || 0,
        'Data Assunzione': p.dataAssunzione || '',
        'Data Termine': p.dataTermine || '',
        'Attivo': _isPersonaAttiva(p) ? 'Sì' : 'No',
        'Note': p.note || '',
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(personRows), 'Persone');

    // Sheet 2 — Allocazioni
    if (allocazioni.length) {
        const allocRows = allocazioni.map(a => {
            const p = persone.find(x => x.id === a.personaId);
            const c = commesse.find(x => x.codice === a.codiceCommessa);
            const mesi = getMonthsInRange(a.dataInizio, a.dataFine).length;
            const costoMese = p ? (p.costoMedioMese || 0) * a.percentuale / 100 : 0;
            const prob = (c?.probabilita ?? 100) / 100;
            return {
                'Cognome': p?.cognome || '',
                'Nome': p?.nome || '',
                'Ruolo': p?.ruolo || '',
                'Codice Commessa': a.codiceCommessa,
                'Nome Commessa': c?.nome || '',
                'Tipo Commessa': c?.tipo || '',
                '% Allocazione': a.percentuale,
                'Data Inizio': a.dataInizio || '',
                'Data Fine': a.dataFine || '',
                'Aggancio Inizio': a.aggancioInizio ? 'Sì' : 'No',
                'Aggancio Fine': a.aggancioFine ? 'Sì' : 'No',
                'Delta Inizio (mesi)': a.deltaInizio || 0,
                'Delta Fine (mesi)': a.deltaFine || 0,
                'N. Mesi': mesi,
                'Costo Mese Allocato (€)': Math.round(costoMese),
                'Costo Totale (€)': Math.round(costoMese * mesi),
                'Prob. Commessa %': c?.probabilita ?? 100,
                'Costo Personale Probabilizzato (€)': Math.round(costoMese * mesi * prob),
                'Origine': a.origine || 'manuale',
            };
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allocRows), 'Allocazioni');
    }

    // Sheet 3 — Saturazione mensile (matrice persona × mese)
    if (months.length) {
        const satRows = persone.map(p => {
            const row = { 'Cognome': p.cognome, 'Nome': p.nome, 'Ruolo': p.ruolo || '', 'BU': p.bu || '' };
            const pMap = matrix.get(p.id);
            months.forEach(m => { row[m] = pMap?.get(m)?.totalePerc ?? 0; });
            return row;
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(satRows), 'Saturazione');
    }

    // Sheet 4 — Riepilogo per Commessa
    const commesseCodes = [...new Set(allocazioni.map(a => a.codiceCommessa))];
    if (commesseCodes.length) {
        const commRows = commesseCodes.map(cod => {
            const c = commesse.find(x => x.codice === cod);
            const allocs = allocazioni.filter(a => a.codiceCommessa === cod);
            const prob = (c?.probabilita ?? 100) / 100;
            let costoTotale = 0, costoProb = 0, fte = 0;
            allocs.forEach(a => {
                const p = persone.find(x => x.id === a.personaId);
                if (!p) return;
                const mesi = getMonthsInRange(a.dataInizio, a.dataFine).length;
                const cm = (p.costoMedioMese || 0) * a.percentuale / 100;
                costoTotale += cm * mesi;
                costoProb += cm * mesi * prob;
                fte += a.percentuale / 100;
            });
            return {
                'Codice': cod,
                'Nome': c?.nome || '',
                'Tipo': c?.tipo || '',
                'Probabilità %': c?.probabilita ?? 100,
                'N. Allocazioni': allocs.length,
                'FTE Assegnati': Math.round(fte * 10) / 10,
                'Costo Personale Allocato (€)': Math.round(costoTotale),
                'Costo Personale Probabilizzato (€)': Math.round(costoProb),
            };
        });
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(commRows), 'Riepilogo Commesse');
    }

    const date = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Risorse_${date}.xlsx`);
    _showToast('Export Excel completato');
}

// ─── MODAL HELPERS ────────────────────────────────────────────

function _openModal(id) { $(`#${id}`)?.classList.remove('hidden'); }
function _closeModal(id) { $(`#${id}`)?.classList.add('hidden'); }

// ─── UI HELPERS ───────────────────────────────────────────────

function _emptyState(title, desc, btnId) {
    return `
        <div class="res-empty-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.25">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                <circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
            </svg>
            <h3>${title}</h3>
            <p>${desc}</p>
        </div>
    `;
}

function _showToast(msg) {
    const t = document.createElement('div');
    t.className = 'res-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}
