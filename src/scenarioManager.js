/**
 * scenarioManager.js — CRUD for scenarios in localStorage
 */

import { safeSetItem, trackChanges } from './storage.js';

const STORAGE_KEY = 'whatif_scenarios';

function generateId() {
    return 'scen_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function loadAll() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveAll(scenarios, changedIds = null) {
    safeSetItem(STORAGE_KEY, JSON.stringify(scenarios));
    if (changedIds && changedIds.length) trackChanges('scenario', changedIds);
    // Segnala il cambiamento a chi tiene risultati derivati in memoria (le date
    // effettive di commessa dipendono da inputs, ritardo e shift dello scenario).
    try { window.dispatchEvent(new CustomEvent('whatif:scenariCambiati')); }
    catch { /* fuori dal browser */ }
}

export function listScenarios() {
    return loadAll();
}

export function getScenario(id) {
    return loadAll().find(s => s.id === id) || null;
}

export function createScenario(name, notes = '', type = 'calculated', importedData = null, createdBy = '') {
    const scenarios = loadAll();
    const scen = {
        id: generateId(),
        name: name || 'Nuovo Scenario',
        type: type, // 'calculated' or 'imported'
        notes: notes || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        inputs: {}, // { commessaKey: { shiftStart, probabilita, margine, ritardo, smussamento } }
        importedData: importedData, // { [commessaKey]: [{month, actual, remaining}] }
        locked: false,
        lockedBy: null,
        lockedAt: null,
        draft: false,
        createdBy: createdBy || '',
    };
    scenarios.push(scen);
    saveAll(scenarios, [scen.id]);
    return scen;
}


export function duplicateScenario(id, overrides = {}) {
    const scenarios = loadAll();
    const orig = scenarios.find(s => s.id === id);
    if (!orig) return null;
    const dup = {
        ...JSON.parse(JSON.stringify(orig)),
        id: generateId(),
        name: overrides.name ?? (orig.name + ' (copia)'),
        notes: overrides.notes !== undefined ? overrides.notes : (orig.notes || ''),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        locked: false,
        lockedBy: null,
        lockedAt: null,
        draft: false,
        createdBy: overrides.createdBy || orig.createdBy || '',
    };
    scenarios.push(dup);
    saveAll(scenarios, [dup.id]);
    return dup;
}

export function updateScenario(id, updates) {
    const scenarios = loadAll();
    const idx = scenarios.findIndex(s => s.id === id);
    if (idx === -1) return null;
    if (scenarios[idx].locked) return null; // locked scenarios cannot be modified
    Object.assign(scenarios[idx], updates, { updatedAt: new Date().toISOString() });
    saveAll(scenarios, [id]);
    return scenarios[idx];
}

export function updateScenarioInput(scenarioId, commessaKey, inputUpdates) {
    const scenarios = loadAll();
    const scen = scenarios.find(s => s.id === scenarioId);
    if (!scen) return null;
    if (scen.locked) return null; // locked scenarios cannot be modified
    if (!scen.inputs) scen.inputs = {};
    if (!scen.inputs[commessaKey]) scen.inputs[commessaKey] = {};
    Object.assign(scen.inputs[commessaKey], inputUpdates);
    scen.updatedAt = new Date().toISOString();
    saveAll(scenarios, [scenarioId]);
    return scen;
}

export function deleteScenario(id) {
    const scenarios = loadAll();
    const scen = scenarios.find(s => s.id === id);
    if (scen?.locked) return false; // locked scenarios cannot be deleted
    saveAll(scenarios.filter(s => s.id !== id));
    return true;
}

// ─────────────────────────────────────────────────────
// Hook per snapshot costi al lock (registrato dal modulo costi)
// Se nessuno registra un provider, lockScenario funziona identico al pre-modulo.
// ─────────────────────────────────────────────────────
let _costiSnapshotProvider = null;
export function setCostiSnapshotProvider(fn) {
    _costiSnapshotProvider = (typeof fn === 'function') ? fn : null;
}

export function lockScenario(id, email) {
    const scenarios = loadAll();
    const scen = scenarios.find(s => s.id === id);
    if (!scen) return null;

    // Genera snapshot costi prima del lock (se provider registrato dal modulo costi).
    // Esegue su una "copia di lavoro" dello scenario (non ancora locked) per evitare
    // di entrare nel ramo bypass-snapshot di computeCategoriaMensile.
    if (_costiSnapshotProvider) {
        try {
            const snap = _costiSnapshotProvider(scen);
            if (snap && Object.keys(snap).length > 0) {
                scen.costiSnapshot = snap;
            }
        } catch (err) {
            console.warn('[scenarioManager] costi snapshot generation failed:', err);
        }
    }

    scen.locked = true;
    scen.lockedBy = email || '';
    scen.lockedAt = new Date().toISOString();
    scen.snapshotAt = scen.lockedAt;
    scen.updatedAt = new Date().toISOString();
    saveAll(scenarios, [id]);
    return scen;
}

export function unlockScenario(id) {
    const scenarios = loadAll();
    const scen = scenarios.find(s => s.id === id);
    if (!scen) return null;
    scen.locked = false;
    scen.lockedBy = null;
    scen.lockedAt = null;
    // Cancella snapshot costi: i valori tornano ad essere ricalcolati dinamicamente
    if (scen.costiSnapshot !== undefined) scen.costiSnapshot = null;
    scen.updatedAt = new Date().toISOString();
    saveAll(scenarios, [id]);
    return scen;
}

export function setScenarioDraft(id, draftValue) {
    const scenarios = loadAll();
    const scen = scenarios.find(s => s.id === id);
    if (!scen) return null;
    scen.draft = draftValue;
    scen.updatedAt = new Date().toISOString();
    saveAll(scenarios, [id]);
    return scen;
}

export function clearAll() {
    localStorage.removeItem(STORAGE_KEY);
}

/**
 * Rinomina la chiave di una commessa in tutti gli scenari salvati.
 * Aggiorna inputs e importedData di ogni scenario.
 * Restituisce il numero di scenari modificati.
 */
export function renameCommessaKey(oldKey, newKey) {
    if (!oldKey || !newKey || oldKey === newKey) return 0;
    const scenarios = loadAll();
    let count = 0;
    const toccati = [];
    for (const scen of scenarios) {
        let changed = false;
        if (scen.inputs?.[oldKey] !== undefined) {
            scen.inputs[newKey] = scen.inputs[oldKey];
            delete scen.inputs[oldKey];
            changed = true;
        }
        if (scen.importedData?.[oldKey] !== undefined) {
            scen.importedData[newKey] = scen.importedData[oldKey];
            delete scen.importedData[oldKey];
            changed = true;
        }
        // newCommesse: aggiorna la commessa con chiave oldKey
        if (Array.isArray(scen.newCommesse)) {
            for (const c of scen.newCommesse) {
                if (c.key === oldKey) { c.key = newKey; changed = true; }
            }
        }
        if (changed) { scen.updatedAt = new Date().toISOString(); toccati.push(scen.id); count++; }
    }
    if (count > 0) saveAll(scenarios, toccati);
    return count;
}

// ─── Baseline Persistence ───────────────────────────────────────────────────
const BASELINE_KEY = 'whatif_baseline';

/**
 * Serializza e salva la baseline in localStorage.
 * La Map viene convertita in array di entries; i Date object vengono rimossi
 * (i mesi sono già ordinati al momento del parse).
 */
export function saveBaseline(appData) {
    try {
        const serializable = {
            commesse: appData.commesse,
            monthlyData: Array.from(appData.monthlyData.entries()).map(([k, months]) => [
                k,
                months.map(({ date, ...rest }) => rest),
            ]),
            allMonths: appData.allMonths,
            filters: appData.filters,
        };
        safeSetItem(BASELINE_KEY, JSON.stringify(serializable));
    } catch (e) {
        console.warn('Impossibile salvare la baseline in localStorage:', e);
    }
}

/**
 * Carica la baseline salvata. Restituisce null se non presente o corrotta.
 */
export function loadBaseline() {
    try {
        const raw = localStorage.getItem(BASELINE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        // Verifica la forma minima: prima bastava che il JSON fosse valido, e una
        // baseline troncata apriva l'app vuota facendo poi esplodere populateFilters.
        if (!parsed || !Array.isArray(parsed.commesse) || !Array.isArray(parsed.allMonths)
            || !Array.isArray(parsed.monthlyData)) {
            console.warn('[scenarioManager] baseline salvata incompleta: ignorata');
            return null;
        }
        return {
            commesse: parsed.commesse,
            monthlyData: new Map(parsed.monthlyData),
            allMonths: parsed.allMonths,
            filters: parsed.filters || { settori: [], types: [] },
        };
    } catch {
        return null;
    }
}

export function clearBaseline() {
    localStorage.removeItem(BASELINE_KEY);
}
