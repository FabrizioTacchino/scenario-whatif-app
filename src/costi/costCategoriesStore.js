/**
 * costCategoriesStore.js — fonte unica delle categorie costi "live".
 *
 * Le 14 categorie hardcoded in costCategories.js fungono da SEED (defaults).
 * L'utente, dal pannello admin, può:
 *   - Aggiungere nuove categorie
 *   - Rinominare la label di esistenti
 *   - Aggiungere/rimuovere alias BI (etichette riconosciute dal parser)
 *   - Archiviare (soft delete reversibile, dati storici preservati)
 *   - Riattivare categorie archiviate
 *
 * NON gestisce: modifica pesi/curve/paramA (i seed hardcoded servono solo per
 * cold-start OI; i valori reali vivono dentro scenario.costi).
 *
 * Storage:
 *   - localStorage 'whatif_cost_categories' = override completo (array)
 *     Se presente, sostituisce i seed. Se assente, fallback ai seed.
 *   - Cloud sync via app_config['cost_categories'] (gestito da costAdminUI).
 *
 * Eventi:
 *   - window.dispatchEvent('whatif:costCategoriesChanged') ad ogni modifica
 *     così UI può re-renderizzare (pannello costi, tab comparison, ecc.).
 */

import { COST_CATEGORIES as SEED_CATEGORIES } from './costCategories.js';
import { supabase } from '../supabaseClient.js';
import { getCurrentRole, getSyncStatus, onSyncStatusChange } from '../syncManager.js';
import { safeSetItem } from '../storage.js';

// Il modulo reagiva a QUALSIASI stato "connected" — quindi a ogni push riuscito del
// polling — con una query su app_config: decine al minuto. Ora si muove solo alla
// transizione disconnesso -> connesso, con una soglia minima fra due letture.
let _eraConnesso = false;
let _ultimaLettura = 0;
const _INTERVALLO_MIN_MS = 60000;

function _vaLetto(statoConnesso) {
    const adesso = Date.now();
    const transizione = statoConnesso && !_eraConnesso;
    _eraConnesso = statoConnesso;
    if (!transizione) return false;
    if (adesso - _ultimaLettura < _INTERVALLO_MIN_MS) return false;
    _ultimaLettura = adesso;
    return true;
}

const STORAGE_KEY = 'whatif_cost_categories';
const APP_CONFIG_KEY = 'cost_categories';

function loadOverride() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
    } catch { return null; }
}

function saveOverride(categories) {
    try {
        safeSetItem(STORAGE_KEY, JSON.stringify(categories));
    } catch (e) {
        console.warn('[costCategoriesStore] save failed:', e);
    }
}

/** Costruisce la lista "live": override se esiste, altrimenti seed con i nuovi campi default. */
export function getCostCategories() {
    const override = loadOverride();
    const source = override || SEED_CATEGORIES;
    return source.map(c => ({
        id: c.id,
        label: c.label || c.id,
        peso: Number(c.peso) || 0,
        curvaDefault: c.curvaDefault || 'uniforme',
        paramA: c.paramA != null ? Number(c.paramA) : 1.0,
        archived: !!c.archived,
        aliasesBI: Array.isArray(c.aliasesBI) ? c.aliasesBI.slice() : [],
    }));
}

/** Categorie attive (non archiviate). */
export function getActiveCategories() {
    return getCostCategories().filter(c => !c.archived);
}

/** Categorie archiviate. */
export function getArchivedCategories() {
    return getCostCategories().filter(c => c.archived);
}

/** Categorie con peso > 0 e attive (per cold-start OI da margine). */
export function getActiveDefaultCategoriesLive() {
    return getActiveCategories().filter(c => c.peso > 0);
}

/** Lookup per id su tutto l'insieme (incluse archiviate). */
export function getCategoryByIdLive(id) {
    return getCostCategories().find(c => c.id === id);
}

/**
 * Mappa label_uppercase → id, includendo label e alias delle categorie ATTIVE.
 * Usata dal parser BI per riconoscere le etichette del file Excel.
 */
export function getCategoryAliasMap() {
    const map = {};
    for (const cat of getActiveCategories()) {
        const upper = (cat.label || '').toUpperCase().trim();
        if (upper) map[upper] = cat.id;
        for (const alias of cat.aliasesBI || []) {
            const u = (alias || '').toUpperCase().trim();
            if (u) map[u] = cat.id;
        }
    }
    return map;
}

/**
 * Set di label/alias delle categorie ARCHIVIATE (uppercase, trim).
 * Usato dal parser BI: queste vengono ignorate silenziosamente come oggi RIS.
 */
export function getArchivedLabelsSet() {
    const set = new Set();
    for (const cat of getArchivedCategories()) {
        const u = (cat.label || '').toUpperCase().trim();
        if (u) set.add(u);
        for (const alias of cat.aliasesBI || []) {
            const ua = (alias || '').toUpperCase().trim();
            if (ua) set.add(ua);
        }
    }
    return set;
}

/** Salva una nuova versione completa delle categorie + emette evento. */
export function setCategories(categories) {
    saveOverride(categories);
    if (typeof window !== 'undefined') {
        try {
            window.dispatchEvent(new CustomEvent('whatif:costCategoriesChanged'));
        } catch { /* ignore */ }
    }
}

/** Aggiunge una nuova categoria. Genera id stabile da slug della label. */
export function addCategory({ label, aliasesBI = [], curvaDefault = 'uniforme', paramA = 1.0 }) {
    if (!label || !String(label).trim()) throw new Error('Label categoria richiesta');
    const all = getCostCategories();
    const baseId = String(label).toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'cat';
    let id = baseId;
    let counter = 2;
    while (all.find(c => c.id === id)) {
        id = `${baseId}_${counter++}`;
    }
    const newCat = {
        id,
        label: String(label).trim(),
        peso: 0,
        curvaDefault,
        paramA: Number(paramA) || 1.0,
        archived: false,
        aliasesBI: (aliasesBI || []).map(a => String(a).trim()).filter(Boolean),
    };
    setCategories([...all, newCat]);
    return newCat;
}

/** Archivia una categoria (soft delete). */
export function archiveCategory(id) {
    const all = getCostCategories();
    setCategories(all.map(c => c.id === id ? { ...c, archived: true } : c));
}

/** Riattiva una categoria archiviata. */
export function unarchiveCategory(id) {
    const all = getCostCategories();
    setCategories(all.map(c => c.id === id ? { ...c, archived: false } : c));
}

/** Rinomina la label di una categoria. L'id resta stabile. */
export function renameCategory(id, newLabel) {
    const trimmed = String(newLabel || '').trim();
    if (!trimmed) throw new Error('Label categoria richiesta');
    const all = getCostCategories();
    setCategories(all.map(c => c.id === id ? { ...c, label: trimmed } : c));
}

/** Aggiorna alias BI di una categoria. */
export function updateCategoryAliases(id, aliasesBI) {
    const cleaned = (aliasesBI || []).map(a => String(a).trim()).filter(Boolean);
    const all = getCostCategories();
    setCategories(all.map(c => c.id === id ? { ...c, aliasesBI: cleaned } : c));
}

/** Reset ai seed hardcoded. Utile per debug o "ripristina default". */
export function resetToSeed() {
    try {
        localStorage.removeItem(STORAGE_KEY);
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('whatif:costCategoriesChanged'));
        }
    } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────
// Cloud sync (admin-only write, all-users read)
// ─────────────────────────────────────────────────────

let _isApplyingRemote = false;
let _realtimeChannel = null;

/** Pull categorie da Supabase app_config (best effort). */
export async function pullCategoriesFromCloud() {
    try {
        const { data, error } = await supabase
            .from('app_config')
            .select('value')
            .eq('key', APP_CONFIG_KEY)
            .maybeSingle();
        if (error || !data) return;
        const arr = JSON.parse(data.value);
        if (!Array.isArray(arr)) return;
        // Salva solo se differente
        const local = loadOverride();
        const localStr = JSON.stringify(local || []);
        const cloudStr = JSON.stringify(arr);
        if (localStr !== cloudStr) {
            _isApplyingRemote = true;
            try {
                safeSetItem(STORAGE_KEY, JSON.stringify(arr));
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('whatif:costCategoriesChanged'));
                }
            } finally {
                _isApplyingRemote = false;
            }
        }
    } catch (err) {
        console.warn('[costCategoriesStore] pull failed:', err.message);
    }
}

/** Push categorie correnti al cloud (admin-only — chiamante deve verificare). */
export async function pushCategoriesToCloud() {
    const local = loadOverride();
    if (!local) return; // niente da pushare se non ci sono override
    try {
        const { error } = await supabase
            .from('app_config')
            .upsert({
                key: APP_CONFIG_KEY,
                value: JSON.stringify(local),
                updated_at: new Date().toISOString(),
            }, { onConflict: 'key' });
        if (error) throw error;
    } catch (err) {
        console.warn('[costCategoriesStore] push failed:', err.message);
    }
}

/** Subscription realtime su app_config con filter key=cost_categories. */
function startCategoriesRealtime() {
    if (_realtimeChannel) return;
    try {
        _realtimeChannel = supabase
            .channel('app-config-cost-categories')
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'app_config',
                filter: 'key=eq.cost_categories',
            }, async () => {
                console.info('[Realtime] cost_categories changed by another user');
                await pullCategoriesFromCloud();
            })
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    console.info('[Realtime] cost_categories subscription active');
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    console.warn('[Realtime] cost_categories subscription error:', status);
                    // Azzerare il riferimento senza rimuovere il canale lasciava il
                    // socket aperto: a ogni nuovo tentativo se ne accumulava un altro.
                    stopCategoriesRealtime();
                }
            });
    } catch (err) {
        console.warn('[Realtime] cost_categories subscription failed:', err.message);
        _realtimeChannel = null;
    }
}

function stopCategoriesRealtime() {
    if (_realtimeChannel) {
        try { supabase.removeChannel(_realtimeChannel); } catch { /* ignore */ }
        _realtimeChannel = null;
    }
}

// ─────────────────────────────────────────────────────
// Auto-init: pull iniziale + listener push + realtime
// ─────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
    // Auto-push quando admin modifica le categorie localmente
    window.addEventListener('whatif:costCategoriesChanged', () => {
        if (_isApplyingRemote) return; // evita loop pull→push
        try {
            if (getCurrentRole() === 'admin') {
                pushCategoriesToCloud().catch(() => {});
            }
        } catch { /* ignore */ }
    });

    // Avvia realtime quando il sync è connesso (lazy)
    const tryStart = () => {
        try {
            const status = getSyncStatus();
            if (status?.state === 'connected') {
                pullCategoriesFromCloud(); // pull iniziale
                startCategoriesRealtime();
            }
        } catch { /* ignore */ }
    };
    // Defer: aspetta che gli altri moduli si carichino
    queueMicrotask(tryStart);
    try {
        onSyncStatusChange((s) => {
            const connesso = s?.state === 'connected';
            if (connesso) {
                // Solo alla transizione disconnesso -> connesso, non a ogni push riuscito
                if (_vaLetto(true)) pullCategoriesFromCloud();
                startCategoriesRealtime();
            } else if (s?.state === 'disconnected' || s?.state === 'error') {
                _vaLetto(false);
                stopCategoriesRealtime();
            }
        });
    } catch { /* ignore */ }
}
