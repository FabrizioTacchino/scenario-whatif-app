/**
 * scenarioManager.js — CRUD for scenarios in localStorage
 */

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

function saveAll(scenarios) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scenarios));
}

export function listScenarios() {
    return loadAll();
}

export function getScenario(id) {
    return loadAll().find(s => s.id === id) || null;
}

export function createScenario(name, notes = '', type = 'calculated', importedData = null) {
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
    };
    scenarios.push(scen);
    saveAll(scenarios);
    return scen;
}


export function duplicateScenario(id) {
    const scenarios = loadAll();
    const orig = scenarios.find(s => s.id === id);
    if (!orig) return null;
    const dup = {
        ...JSON.parse(JSON.stringify(orig)),
        id: generateId(),
        name: orig.name + ' (copia)',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
    scenarios.push(dup);
    saveAll(scenarios);
    return dup;
}

export function updateScenario(id, updates) {
    const scenarios = loadAll();
    const idx = scenarios.findIndex(s => s.id === id);
    if (idx === -1) return null;
    Object.assign(scenarios[idx], updates, { updatedAt: new Date().toISOString() });
    saveAll(scenarios);
    return scenarios[idx];
}

export function updateScenarioInput(scenarioId, commessaKey, inputUpdates) {
    const scenarios = loadAll();
    const scen = scenarios.find(s => s.id === scenarioId);
    if (!scen) return null;
    if (!scen.inputs) scen.inputs = {};
    if (!scen.inputs[commessaKey]) scen.inputs[commessaKey] = {};
    Object.assign(scen.inputs[commessaKey], inputUpdates);
    scen.updatedAt = new Date().toISOString();
    saveAll(scenarios);
    return scen;
}

export function deleteScenario(id) {
    const scenarios = loadAll().filter(s => s.id !== id);
    saveAll(scenarios);
}

export function clearAll() {
    localStorage.removeItem(STORAGE_KEY);
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
        localStorage.setItem(BASELINE_KEY, JSON.stringify(serializable));
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
        return {
            commesse: parsed.commesse,
            monthlyData: new Map(parsed.monthlyData),
            allMonths: parsed.allMonths,
            filters: parsed.filters,
        };
    } catch {
        return null;
    }
}

export function clearBaseline() {
    localStorage.removeItem(BASELINE_KEY);
}
