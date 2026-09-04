/**
 * scenarioOrderManager.js — gestisce l'ordine personalizzato degli scenari.
 *
 * Lo storage locale è un array di id scenario (`whatif_scenarios_order`).
 * Gli scenari non presenti nell'ordine vanno in fondo (ordinati per updatedAt desc).
 *
 * Sync cloud (admin-only): app_config['scenarios_order'] = JSON.stringify([id1, id2, ...]).
 * - Read: pull all'avvio + dopo ogni full-pull cloud (best effort)
 * - Write: solo admin pusha al drop (best effort)
 *
 * Eventi: dispatch 'whatif:scenariosOrderChanged' per re-render UI consumer.
 */

import { supabase } from './supabaseClient.js';
import { safeSetItem } from './storage.js';

const STORAGE_KEY = 'whatif_scenarios_order';
const APP_CONFIG_KEY = 'scenarios_order';

/** Carica ordine locale. Ritorna array di id o null. */
export function loadOrder() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : null;
    } catch { return null; }
}

/** Salva ordine in localStorage + emette evento. */
export function saveOrder(orderArray) {
    try {
        safeSetItem(STORAGE_KEY, JSON.stringify(orderArray));
    } catch (e) {
        console.warn('[scenarioOrderManager] save failed:', e);
        return;
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('whatif:scenariosOrderChanged'));
    }
}

/**
 * Ordina un array di scenari (o oggetti con .id / .local_id) secondo l'ordine custom.
 * Gli scenari non in lista vanno in fondo, ordinati per updatedAt desc.
 *
 * @param {Array} scenarios - array di oggetti con .id (o .local_id) e opzionalmente .updatedAt
 * @param {function} idFn - opzionale, estrattore di id (default: s => s.id || s.local_id)
 * @returns {Array} nuovo array ordinato
 */
export function sortScenariosByOrder(scenarios, idFn = (s) => s.id || s.local_id) {
    if (!Array.isArray(scenarios) || scenarios.length === 0) return scenarios;
    const order = loadOrder();
    if (!order || order.length === 0) {
        // Niente custom order → ordine "naturale" del chiamante
        return scenarios;
    }
    const orderMap = new Map(order.map((id, i) => [id, i]));
    const inOrder = [];
    const notInOrder = [];
    for (const s of scenarios) {
        const id = idFn(s);
        if (orderMap.has(id)) inOrder.push(s);
        else notInOrder.push(s);
    }
    inOrder.sort((a, b) => orderMap.get(idFn(a)) - orderMap.get(idFn(b)));
    notInOrder.sort((a, b) => String(b.updatedAt || b.data?.updatedAt || '').localeCompare(String(a.updatedAt || a.data?.updatedAt || '')));
    return [...inOrder, ...notInOrder];
}

/**
 * Sposta uno scenario nella posizione di un altro.
 * @param {string} fromId - id scenario da spostare
 * @param {string} toId - id scenario di destinazione (verrà inserito prima)
 * @param {Array<string>} allIds - tutti gli id presenti (per inizializzare se vuoto)
 */
export function reorderScenarios(fromId, toId, allIds) {
    let order = loadOrder();
    if (!order || order.length === 0) {
        // Inizializza da allIds se nessun ordine custom
        order = [...allIds];
    } else {
        // Aggiungi gli scenari nuovi (non in lista) in fondo
        for (const id of allIds) {
            if (!order.includes(id)) order.push(id);
        }
        // Rimuovi gli scenari eliminati
        order = order.filter(id => allIds.includes(id));
    }
    const fromIdx = order.indexOf(fromId);
    if (fromIdx === -1) return;
    order.splice(fromIdx, 1);
    const toIdx = order.indexOf(toId);
    if (toIdx === -1) order.push(fromId);
    else order.splice(toIdx, 0, fromId);
    saveOrder(order);
}

/** Reset ordine custom (torna a ordine naturale). */
export function resetOrder() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('whatif:scenariosOrderChanged'));
        }
    } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// Cloud sync (admin-only write, all-users read)
// ─────────────────────────────────────────────────────

/** Pull dell'ordine da Supabase app_config (best effort). */
export async function pullOrderFromCloud() {
    try {
        const { data, error } = await supabase
            .from('app_config')
            .select('value')
            .eq('key', APP_CONFIG_KEY)
            .maybeSingle();
        if (error || !data) return;
        const arr = JSON.parse(data.value);
        if (!Array.isArray(arr)) return;
        // Salva in localStorage solo se differente
        const local = loadOrder();
        const localStr = JSON.stringify(local || []);
        const cloudStr = JSON.stringify(arr);
        if (localStr !== cloudStr) {
            saveOrder(arr);
        }
    } catch (err) {
        console.warn('[scenarioOrderManager] pull failed:', err.message);
    }
}

/** Push dell'ordine corrente al cloud (admin-only — chiamante deve verificare). */
export async function pushOrderToCloud() {
    const order = loadOrder();
    if (!order) return;
    try {
        const { error } = await supabase
            .from('app_config')
            .upsert({
                key: APP_CONFIG_KEY,
                value: JSON.stringify(order),
                updated_at: new Date().toISOString(),
            }, { onConflict: 'key' });
        if (error) throw error;
    } catch (err) {
        console.warn('[scenarioOrderManager] push failed:', err.message);
    }
}
