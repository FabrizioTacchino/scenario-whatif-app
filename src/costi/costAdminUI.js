/**
 * costAdminUI.js — UI del pannello admin per gestione dinamica categorie costi (P19).
 *
 * Solo admin vede la sezione (tab admin del cloud-admin-panel esistente).
 * Funzioni:
 *   - Lista categorie attive (label + alias BI editabili inline)
 *   - Toggle "Mostra archiviate"
 *   - Aggiungi nuova categoria (form modale leggero)
 *   - Archivia / Riattiva
 *
 * Niente editing pesi/curve: i seed da costCategories.js bastano per cold-start.
 */

import { WHATIF_COSTI_ENABLED } from './costFeatureFlag.js';
import {
    getCostCategories,
    getActiveCategories,
    getArchivedCategories,
    addCategory,
    archiveCategory,
    unarchiveCategory,
    renameCategory,
    updateCategoryAliases,
} from './costCategoriesStore.js';

let _initialized = false;
let _showArchived = false;

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }
function setHidden(el, h) { if (el) el.classList.toggle('hidden', !!h); }
function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
}

function renderCategoryList() {
    const container = $('#admin-cost-cat-list');
    if (!container) return;

    const active = getActiveCategories();
    const archived = getArchivedCategories();

    let html = active.map(cat => renderCategoryRow(cat, false)).join('');

    if (_showArchived && archived.length > 0) {
        html += `<div class="admin-cost-cat-archived-section">Archiviate (${archived.length})</div>`;
        html += archived.map(cat => renderCategoryRow(cat, true)).join('');
    }

    if (!html) {
        html = '<div style="padding:12px;text-align:center;color:var(--text-muted,#888);font-size:11px;">Nessuna categoria definita.</div>';
    }

    container.innerHTML = html;
    attachRowHandlers();

    // Aggiorna pulsante toggle
    const toggleBtn = $('#admin-cost-cat-toggle-archived');
    if (toggleBtn) {
        toggleBtn.textContent = _showArchived
            ? `Nascondi archiviate (${archived.length})`
            : `Mostra archiviate (${archived.length})`;
    }
}

function renderCategoryRow(cat, isArchived) {
    const aliases = (cat.aliasesBI || []).join(', ');
    return `
        <div class="admin-cost-cat-row${isArchived ? ' archived' : ''}" data-cat-id="${escapeHtml(cat.id)}">
            <span class="cat-id" title="${escapeHtml(cat.id)}">${escapeHtml(cat.id)}</span>
            <input type="text"
                   class="cat-label-input"
                   data-field="label"
                   value="${escapeHtml(cat.label)}"
                   placeholder="Etichetta categoria"
                   ${isArchived ? 'disabled' : ''} />
            <input type="text"
                   class="cat-aliases-input"
                   data-field="aliases"
                   value="${escapeHtml(aliases)}"
                   placeholder="alias BI separati da virgola"
                   title="Alias del file BI (es. PENALI [-], etc.)"
                   ${isArchived ? 'disabled' : ''} />
            ${isArchived
                ? `<button data-action="unarchive">↩ Riattiva</button>`
                : `<button data-action="archive">🗄 Archivia</button>`}
        </div>
    `;
}

function attachRowHandlers() {
    const container = $('#admin-cost-cat-list');
    if (!container) return;

    // Edit handler (label + alias) — change/blur
    container.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', () => {
            const row = input.closest('.admin-cost-cat-row');
            const id = row?.dataset.catId;
            if (!id) return;
            const field = input.dataset.field;
            const value = input.value;
            try {
                if (field === 'label') {
                    if (value.trim()) {
                        renameCategory(id, value);
                    } else {
                        // Label vuota → ripristino
                        renderCategoryList();
                    }
                } else if (field === 'aliases') {
                    const list = value.split(',').map(s => s.trim()).filter(Boolean);
                    updateCategoryAliases(id, list);
                }
            } catch (err) {
                alert('Errore: ' + err.message);
                renderCategoryList();
            }
        });
    });

    // Action buttons (archive, unarchive)
    container.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const row = btn.closest('.admin-cost-cat-row');
            const id = row?.dataset.catId;
            if (!id) return;
            const action = btn.dataset.action;
            if (action === 'archive') {
                if (!confirm(`Archiviare la categoria "${id}"?\n\nLa categoria scompare dalle UI di editing. I dati storici degli scenari sono preservati e visibili con il toggle "Mostra archiviate" nei pannelli costi.`)) return;
                archiveCategory(id);
                renderCategoryList();
            } else if (action === 'unarchive') {
                unarchiveCategory(id);
                renderCategoryList();
            }
        });
    });
}

function showAddCategoryDialog() {
    const label = prompt('Nome della nuova categoria:');
    if (!label || !label.trim()) return;
    const aliasesInput = prompt(
        'Alias riconosciuti dal parser BI (separati da virgola, opzionali):\n\n' +
        'Es. se il file BI può scrivere questa categoria con altri nomi, aggiungili qui.',
        ''
    );
    const aliasesBI = (aliasesInput || '').split(',').map(s => s.trim()).filter(Boolean);
    try {
        const newCat = addCategory({ label, aliasesBI });
        renderCategoryList();
        alert(`Categoria "${newCat.label}" aggiunta (id: ${newCat.id}).`);
    } catch (err) {
        alert('Errore: ' + err.message);
    }
}

/**
 * Inizializza il pannello admin categorie.
 * Chiamato all'apertura del cloud-admin-panel quando l'utente è admin.
 */
export function initCostAdminUI() {
    if (_initialized) return;
    if (!WHATIF_COSTI_ENABLED) return;
    const section = $('#admin-cost-categories-section');
    if (!section) return;

    _initialized = true;

    // Mostra sezione
    setHidden(section, false);

    // Pulsanti
    $('#admin-cost-cat-add-btn')?.addEventListener('click', showAddCategoryDialog);
    $('#admin-cost-cat-toggle-archived')?.addEventListener('click', () => {
        _showArchived = !_showArchived;
        renderCategoryList();
    });

    renderCategoryList();
}

// Re-render se le categorie cambiano dall'esterno (es. import/sync)
if (typeof window !== 'undefined') {
    window.addEventListener('whatif:costCategoriesChanged', () => {
        if (_initialized) renderCategoryList();
    });
}

/**
 * Auto-attivazione: osserva il pannello cloud-admin-panel. Quando diventa
 * visibile (admin login), inizializza la sezione costi (idempotente).
 */
function setupAutoInit() {
    if (typeof document === 'undefined') return;
    const adminPanel = document.querySelector('#cloud-admin-panel');
    if (!adminPanel) return;
    // Se il pannello è già visibile al boot, init subito
    if (!adminPanel.classList.contains('hidden')) {
        initCostAdminUI();
    }
    // Osserva future modifiche di .hidden
    const observer = new MutationObserver(() => {
        if (!adminPanel.classList.contains('hidden')) {
            initCostAdminUI();
        }
    });
    observer.observe(adminPanel, { attributes: true, attributeFilter: ['class'] });
}

if (typeof window !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupAutoInit, { once: true });
    } else {
        setupAutoInit();
    }
}
