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
    const scritto = safeSetItem(STORAGE_KEY, JSON.stringify(scenarios));
    if (changedIds && changedIds.length) trackChanges('scenario', changedIds);
    // Segnala il cambiamento a chi tiene risultati derivati in memoria (le date
    // effettive di commessa dipendono da inputs, ritardo e shift dello scenario).
    try { window.dispatchEvent(new CustomEvent('whatif:scenariCambiati')); }
    catch { /* fuori dal browser */ }
    return scritto;
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

// Le cinque strutture di uno scenario indicizzate per chiave commessa.
// inputs/importedData/costi/costiSnapshot sono oggetti con la chiave come
// nome di proprietà; newCommesse è un array con la chiave come campo.
const MAPPE_PER_CHIAVE = ['inputs', 'importedData', 'costi', 'costiSnapshot'];

/** Elenca le strutture di uno scenario che contengono una data chiave. */
function _doveCompare(scen, chiave) {
    const dove = [];
    for (const nome of MAPPE_PER_CHIAVE) {
        if (scen[nome]?.[chiave] !== undefined) dove.push(nome);
    }
    if (Array.isArray(scen.newCommesse) && scen.newCommesse.some(c => c.key === chiave)) {
        dove.push('newCommesse');
    }
    return dove;
}

/**
 * Conta cosa verrebbe toccato da una rinomina, senza scrivere niente.
 * Serve all'anteprima mostrata prima di confermare.
 */
export function contaRinominaCommessa(oldKey) {
    const scenarios = loadAll();
    const esito = {
        scenari: 0, inputs: 0, importedData: 0, costi: 0, costiSnapshot: 0,
        newCommesse: 0, vociCosto: 0, bloccati: [],
    };
    for (const scen of scenarios) {
        const dove = _doveCompare(scen, oldKey);
        if (!dove.length) continue;
        esito.scenari++;
        for (const nome of dove) esito[nome]++;
        esito.vociCosto += Object.keys(scen.costi?.[oldKey]?.categorie || {}).length;
        if (scen.locked) esito.bloccati.push(scen.name || scen.id);
    }
    return esito;
}

/**
 * Rinomina la chiave di una commessa in tutti gli scenari salvati.
 *
 * Copre tutte e cinque le strutture indicizzate per chiave. Prima copriva solo
 * inputs, importedData e newCommesse.key: costi e costiSnapshot restavano
 * indietro e i costi inseriti a mano diventavano irraggiungibili, compresi
 * quelli degli scenari bloccati privi di snapshot, che ricadono su costi.
 *
 * Gli scenari bloccati vengono rinominati come gli altri: saltarli li
 * lascerebbe orfani, che è molto peggio. Lo stato del blocco resta intatto.
 *
 * Restituisce { scenari, ids, vociCosto, bloccati } oppure { errore }.
 */
export function renameCommessaKey(oldKey, newKey, newCodice = null, newNome = null) {
    if (!oldKey || !newKey || oldKey === newKey) {
        return { scenari: 0, ids: [], vociCosto: 0, bloccati: [] };
    }
    const scenarios = loadAll();

    // ── Prima passata: sola lettura, per fermarsi PRIMA di scrivere invece di
    //    accorgersene a metà lavoro con i depositi già disallineati.
    //
    //    L'errore è solo quando uno scenario contiene ENTRAMBE le chiavi: lì il
    //    rimappaggio sovrascriverebbe dati, fondendo due commesse. Se contiene
    //    solo quella nuova è lavoro già fatto — una rinomina ripetuta dopo
    //    un'interruzione — e va lasciata passare senza toccare niente, altrimenti
    //    il recupero da un fallimento parziale sarebbe impossibile.
    for (const scen of scenarios) {
        if (_doveCompare(scen, oldKey).length && _doveCompare(scen, newKey).length) {
            return { errore: `Lo scenario "${scen.name || scen.id}" contiene già entrambe le `
                           + 'commesse: rinominare le fonderebbe, e non è reversibile.' };
        }
    }

    // ── Seconda passata: applica.
    const toccati = [];
    let vociCosto = 0;
    const bloccati = [];
    for (const scen of scenarios) {
        let changed = false;
        for (const nome of MAPPE_PER_CHIAVE) {
            if (scen[nome]?.[oldKey] !== undefined) {
                if (nome === 'costi') {
                    vociCosto += Object.keys(scen.costi[oldKey]?.categorie || {}).length;
                }
                scen[nome][newKey] = scen[nome][oldKey];
                delete scen[nome][oldKey];
                changed = true;
            }
        }
        // newCommesse: la chiave è un campo, e vanno allineati anche codice e
        // nome, altrimenti l'oggetto resta incoerente con la propria chiave.
        if (Array.isArray(scen.newCommesse)) {
            for (const c of scen.newCommesse) {
                if (c.key === oldKey) {
                    c.key = newKey;
                    if (newCodice) c.codice = newCodice;
                    if (newNome) c.nome = newNome;
                    changed = true;
                }
            }
        }
        // Elenco delle commesse dell'ultimo import costi da BI. Nessuno lo
        // rilegge: è una traccia. Ma lascerebbe scritto il nome di una commessa
        // che non esiste più, quindi va allineato come tutto il resto.
        const importate = scen.bilImportMeta?.commesseImportate;
        if (Array.isArray(importate)) {
            for (let i = 0; i < importate.length; i++) {
                if (importate[i] === oldKey) { importate[i] = newKey; changed = true; }
            }
        }
        if (changed) {
            // updatedAt protegge lo scenario da _pullIfNewer, che confronta i timestamp
            scen.updatedAt = new Date().toISOString();
            toccati.push(scen.id);
            if (scen.locked) bloccati.push(scen.name || scen.id);
        }
    }

    if (toccati.length > 0 && !saveAll(scenarios, toccati)) {
        return { errore: 'Spazio esaurito: gli scenari non sono stati salvati.' };
    }
    return { scenari: toccati.length, ids: toccati, vociCosto, bloccati };
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
        // L'esito va restituito: a quota esaurita safeSetItem torna false, e
        // prima l'informazione si fermava qui. Chi rinomina deve poterlo sapere.
        return safeSetItem(BASELINE_KEY, JSON.stringify(serializable));
    } catch (e) {
        console.warn('Impossibile salvare la baseline in localStorage:', e);
        return false;
    }
}

/**
 * Rinomina una commessa dentro la baseline: l'oggetto in memoria E la copia
 * salvata, nella stessa chiamata.
 *
 * Sta qui e non nell'orchestratore perché la doppia natura di monthlyData —
 * una Map in memoria, un array di coppie una volta serializzata — è un
 * dettaglio interno di questo modulo. Duplicarlo altrove è dove nascerebbe il
 * prossimo difetto.
 *
 * Restituisce { trovata, mesi, scritta } oppure { errore }.
 */
export function renameCommessaInBaseline(appData, oldKey, newKey, newCodice, newNome) {
    if (!appData || !Array.isArray(appData.commesse)) {
        return { trovata: false, mesi: 0, scritta: false };
    }
    if (!oldKey || !newKey || oldKey === newKey) {
        return { trovata: false, mesi: 0, scritta: false };
    }

    const comm = appData.commesse.find(c => c.key === oldKey);
    const occupante = appData.commesse.find(c => c.key === newKey || c.codice === newCodice);

    // Due commesse con lo stesso codice renderebbero ambigui tutti i lookup che
    // cercano per solo codice. Ma se l'unica occupante è la commessa stessa —
    // cioè è già stata rinominata — non c'è nessun conflitto: è una ripetizione.
    if (comm && occupante && occupante !== comm) {
        return { errore: `La baseline contiene già un'altra commessa con codice ${newCodice} `
                       + `("${occupante.nome}").` };
    }
    // Sorgente assente: o non c'è mai stata, o la rinomina è già avvenuta.
    if (!comm) return { trovata: false, mesi: 0, scritta: false };

    comm.codice = newCodice;
    comm.nome = newNome;
    comm.key = newKey;
    // settore, type, probabilitaAOP, margineAOP e vdpTotale restano intatti:
    // sono i valori da cui il modulo risorse ricava la probabilità.

    let mesi = 0;
    if (appData.monthlyData instanceof Map) {
        const curva = appData.monthlyData.get(oldKey);
        if (curva) {
            mesi = curva.length;
            appData.monthlyData.set(newKey, curva);
            appData.monthlyData.delete(oldKey);
        }
    }

    // Riordina come fa il parse del file AOP, altrimenti la commessa rinominata
    // resta dov'era e nell'elenco laterale sembra fuori posto.
    appData.commesse.sort((a, b) => String(a.codice || '').localeCompare(String(b.codice || '')));

    return { trovata: true, mesi, scritta: saveBaseline(appData) };
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
