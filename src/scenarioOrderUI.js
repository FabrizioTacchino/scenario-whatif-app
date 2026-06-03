/**
 * scenarioOrderUI.js — UI per ordinamento scenari (admin-only).
 *
 * APPROCCIO CONSERVATIVO (post-crash V1):
 *   1. Drag & drop sulle righe Gestione Scenari (admin only)
 *   2. Riordino "lazy" dei dropdown al focus/mousedown (just-in-time)
 *   3. NIENTE MutationObserver globali (causa di crash V1)
 *   4. Al drop: nessun refresh cloud, riordino solo le righe correnti (istantaneo)
 */

import { getCurrentRole, onSyncStatusChange, getSyncStatus } from './syncManager.js';
import { supabase } from './supabaseClient.js';
import {
    loadOrder,
    reorderScenarios,
    pullOrderFromCloud,
    pushOrderToCloud,
} from './scenarioOrderManager.js';
import { listScenarios } from './scenarioManager.js';

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function isAdmin() {
    try { return getCurrentRole() === 'admin'; } catch { return false; }
}

// ─────────────────────────────────────────────────────
// Riordino dropdown (lazy: al focus/mousedown)
// ─────────────────────────────────────────────────────

function reorderSelectByCustomOrder(selectEl) {
    if (!selectEl) return;
    const order = loadOrder();
    if (!order || order.length === 0) return;

    const options = Array.from(selectEl.options);
    const placeholders = options.filter(o => !o.value || o.value === '__baseline__' || o.value.startsWith('__'));
    const realOptions = options.filter(o => o.value && !o.value.startsWith('__'));
    const orderMap = new Map(order.map((id, i) => [id, i]));
    const inOrder = realOptions.filter(o => orderMap.has(o.value));
    const notInOrder = realOptions.filter(o => !orderMap.has(o.value));

    // Skip se già ordinato
    let needsReorder = false;
    let lastIdx = -1;
    for (const o of inOrder) {
        const idx = orderMap.get(o.value);
        if (idx < lastIdx) { needsReorder = true; break; }
        lastIdx = idx;
    }
    if (!needsReorder) return;

    inOrder.sort((a, b) => orderMap.get(a.value) - orderMap.get(b.value));

    const currentValue = selectEl.value;
    selectEl.innerHTML = '';
    placeholders.forEach(o => selectEl.appendChild(o));
    inOrder.forEach(o => selectEl.appendChild(o));
    notInOrder.forEach(o => selectEl.appendChild(o));
    if (currentValue) selectEl.value = currentValue;
}

function attachLazyReorderToSelect(sel) {
    if (!sel || sel.dataset.scenOrderInit === '1') return;
    sel.dataset.scenOrderInit = '1';
    sel.addEventListener('mousedown', () => reorderSelectByCustomOrder(sel));
    sel.addEventListener('focus', () => reorderSelectByCustomOrder(sel));
}

function attachAllSelects() {
    for (const id of ['active-scenario-select', 'compare-scen-a', 'compare-scen-b', 'costi-comp-confronto-select']) {
        attachLazyReorderToSelect(document.getElementById(id));
    }
}

// ─────────────────────────────────────────────────────
// Drag & drop sulla tabella Gestione Scenari (admin only)
// ─────────────────────────────────────────────────────

/** Mappa nome scenario → id, costruita on-demand da listScenarios. */
function buildScenarioByName() {
    const all = listScenarios();
    return new Map(all.map(s => [s.name || s.id, s.id]));
}

function attachDragDropToGestioneTable() {
    if (!isAdmin()) return;
    const table = $('.gestione-table');
    if (!table) return;
    const tbody = table.querySelector('tbody');
    if (!tbody) return;

    const scenByName = buildScenarioByName();
    const rows = $$('tr', tbody).filter(r => !r.classList.contains('row-deleted'));
    if (rows.length === 0) return;

    rows.forEach(tr => {
        if (tr.dataset.dndAttached === '1') return; // idempotente
        const tdName = tr.querySelector('td');
        const scenName = tdName ? tdName.textContent.trim() : null;
        const scenId = scenName ? scenByName.get(scenName) : null;
        if (!scenId) return;

        tr.dataset.scenId = scenId;
        tr.dataset.dndAttached = '1';
        tr.draggable = true;
        tr.style.cursor = 'grab';

        tr.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', scenId);
            e.dataTransfer.effectAllowed = 'move';
            tr.classList.add('dragging');
        });
        tr.addEventListener('dragend', () => {
            tr.classList.remove('dragging');
            $$('tr.drag-over', tbody).forEach(r => r.classList.remove('drag-over'));
        });
        tr.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            tr.classList.add('drag-over');
        });
        tr.addEventListener('dragleave', () => {
            tr.classList.remove('drag-over');
        });
        tr.addEventListener('drop', async (e) => {
            e.preventDefault();
            tr.classList.remove('drag-over');
            const fromId = e.dataTransfer.getData('text/plain');
            const toId = scenId;
            if (!fromId || fromId === toId) return;

            // Salva ordine in localStorage + dispatch evento
            const allIds = listScenarios().map(s => s.id);
            reorderScenarios(fromId, toId, allIds);
            // Push cloud (best effort, non blocco l'UI)
            pushOrderToCloud().catch(() => {});

            // Riordina IMMEDIATAMENTE le righe correnti (no refresh cloud, no async)
            reorderGestioneTableRows();
        });
    });
}

/** Riordina <tr> del tbody Gestione Scenari secondo l'ordine custom. */
function reorderGestioneTableRows() {
    const order = loadOrder();
    if (!order || order.length === 0) return;
    const tbody = $('.gestione-table tbody');
    if (!tbody) return;
    const orderMap = new Map(order.map((id, i) => [id, i]));
    const rows = Array.from(tbody.querySelectorAll('tr'));
    const inOrder = [];
    const notInOrder = [];
    for (const tr of rows) {
        const scenId = tr.dataset.scenId;
        if (scenId && orderMap.has(scenId)) {
            inOrder.push({ tr, idx: orderMap.get(scenId) });
        } else {
            notInOrder.push(tr);
        }
    }
    inOrder.sort((a, b) => a.idx - b.idx);
    // appendChild su elemento già nel DOM lo sposta (non duplica)
    for (const { tr } of inOrder) tbody.appendChild(tr);
    for (const tr of notInOrder) tbody.appendChild(tr);
}

/**
 * Retry: la tabella viene popolata async (fetch cloud).
 * Provo fino a 20 volte ogni 250ms (totale ~5s).
 */
function tryAttachWithRetry(maxAttempts = 20, interval = 250) {
    let attempts = 0;
    const trier = () => {
        attempts++;
        const tbody = $('.gestione-table tbody');
        const rows = tbody ? Array.from(tbody.querySelectorAll('tr')) : [];
        if (rows.length > 0) {
            attachDragDropToGestioneTable();
            reorderGestioneTableRows();
            return;
        }
        if (attempts < maxAttempts) {
            setTimeout(trier, interval);
        }
    };
    trier();
}

// ─────────────────────────────────────────────────────
// CSS injection
// ─────────────────────────────────────────────────────

function injectStyles() {
    if (document.querySelector('#scenario-order-style')) return;
    const style = document.createElement('style');
    style.id = 'scenario-order-style';
    style.textContent = `
        .gestione-table tbody tr[draggable="true"] {
            cursor: grab;
        }
        .gestione-table tbody tr[draggable="true"]:active {
            cursor: grabbing;
        }
        .gestione-table tbody tr.dragging {
            opacity: 0.4;
        }
        .gestione-table tbody tr.drag-over {
            border-top: 3px solid var(--accent, #638cff) !important;
        }
    `;
    document.head.appendChild(style);
}

// ─────────────────────────────────────────────────────
// Realtime subscription per app_config['scenarios_order']
// Modulo separato da syncManager.REALTIME_TABLES per non interferire
// con la pipeline esistente. Sub lazy: parte quando il sync è connesso.
// ─────────────────────────────────────────────────────

let _orderRealtimeChannel = null;

function startOrderRealtime() {
    if (_orderRealtimeChannel) return;
    try {
        _orderRealtimeChannel = supabase
            .channel('app-config-scenarios-order')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'app_config',
                filter: 'key=eq.scenarios_order',
            }, async (payload) => {
                console.info('[Realtime] scenarios_order changed by another user');
                // pullOrderFromCloud già dispatcha whatif:scenariosOrderChanged
                // → riordina dropdown automaticamente
                await pullOrderFromCloud();
                // Se l'utente è su Gestione Scenari, riordina anche le righe della tabella
                if ($('#tab-gestione-scenari')?.classList.contains('active')) {
                    reorderGestioneTableRows();
                }
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.info('[Realtime] scenarios_order subscription active');
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    console.warn('[Realtime] scenarios_order subscription error:', status);
                    // Reset per permettere retry al prossimo sync-connected
                    _orderRealtimeChannel = null;
                }
            });
    } catch (err) {
        console.warn('[Realtime] scenarios_order subscription failed:', err.message);
        _orderRealtimeChannel = null;
    }
}

function stopOrderRealtime() {
    if (_orderRealtimeChannel) {
        try { supabase.removeChannel(_orderRealtimeChannel); } catch { /* ignore */ }
        _orderRealtimeChannel = null;
    }
}

// ─────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────

async function init() {
    injectStyles();

    // Pull cloud (best effort)
    try { await pullOrderFromCloud(); } catch { /* ignore */ }

    // Aggancia listener lazy ai dropdown già esistenti
    attachAllSelects();

    // Click su tab → re-aggancia (per dropdown e per attivare D&D su Gestione Scenari)
    document.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.tab-btn');
        if (tabBtn) {
            requestAnimationFrame(() => {
                attachAllSelects();
                if (tabBtn.dataset.tab === 'gestione-scenari') {
                    tryAttachWithRetry();
                }
            });
            return;
        }
        // Click su refresh gestione → re-aggancia D&D dopo il refetch
        if (e.target.closest('#btn-refresh-gestione')) {
            tryAttachWithRetry();
        }
    }, true);

    // Re-render dropdown quando l'ordine cambia
    window.addEventListener('whatif:scenariosOrderChanged', () => {
        queueMicrotask(() => {
            for (const id of ['active-scenario-select', 'compare-scen-a', 'compare-scen-b', 'costi-comp-confronto-select']) {
                reorderSelectByCustomOrder(document.getElementById(id));
            }
        });
    });

    // Se sono già su gestione-scenari al boot, aggancia con retry
    if ($('#tab-gestione-scenari')?.classList.contains('active')) {
        tryAttachWithRetry();
    }

    // Avvia realtime quando il sync diventa connesso (lazy: serve il login Supabase)
    try {
        const status = getSyncStatus();
        if (status?.state === 'connected') {
            startOrderRealtime();
        }
        onSyncStatusChange((s) => {
            if (s?.state === 'connected') {
                startOrderRealtime();
            } else if (s?.state === 'disconnected' || s?.state === 'error') {
                stopOrderRealtime();
            }
        });
    } catch (err) {
        console.warn('[scenarioOrderUI] sync status hook failed:', err.message);
    }
}

if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
}
