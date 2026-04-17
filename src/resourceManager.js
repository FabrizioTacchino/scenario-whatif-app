/**
 * resourceManager.js — Gestione Persone e Allocazioni
 * Modulo completamente isolato. Non tocca logica esistente.
 * Chiavi localStorage separate: whatif_persone, whatif_allocazioni, whatif_audit
 */

import { trackDeletion } from './syncManager.js';
import { getScenario } from './scenarioManager.js';

/**
 * Check if a scenario is locked. Returns true if locked.
 * Baseline (scenarioId = null) is never locked.
 */
function _isScenarioLocked(scenarioId) {
    if (!scenarioId) return false; // baseline never locked
    const scen = getScenario(scenarioId);
    return scen?.locked === true;
}

const RUOLI_KEY = 'whatif_ruoli';
const PERSONE_KEY = 'whatif_persone';
const ALLOCAZIONI_KEY = 'whatif_allocazioni';
const AUDIT_KEY = 'whatif_audit';
const MESI_IT = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── RUOLI ─────────────────────────────────────────────────

export function listRuoli() {
    try { return JSON.parse(localStorage.getItem(RUOLI_KEY) || '[]'); }
    catch { return []; }
}

export function getRuolo(id) {
    return listRuoli().find(r => r.id === id) || null;
}

export function saveRuolo(data) {
    const all = listRuoli();
    const now = new Date().toISOString();

    if (data.id) {
        const idx = all.findIndex(r => r.id === data.id);
        if (idx === -1) return null;
        all[idx] = { ...all[idx], ...data, updatedAt: now };
        localStorage.setItem(RUOLI_KEY, JSON.stringify(all));
        return all[idx];
    }

    // Check duplicate name
    const nome = (data.nome || '').trim();
    if (!nome) return { error: 'Il nome del ruolo è obbligatorio.' };
    if (all.some(r => r.nome.toLowerCase() === nome.toLowerCase())) {
        return { error: 'Esiste già un ruolo con questo nome.' };
    }

    const nuovo = {
        id: genId(),
        nome,
        codice: (data.codice || '').trim(),
        tipo: data.tipo || 'necessario',
        costoMedio: data.costoMedio || 0,
        createdAt: now,
        updatedAt: now,
    };
    all.push(nuovo);
    localStorage.setItem(RUOLI_KEY, JSON.stringify(all));
    return nuovo;
}

export function deleteRuolo(id) {
    const all = listRuoli();
    const ruolo = all.find(r => r.id === id);
    const remaining = all.filter(r => r.id !== id);
    localStorage.setItem(RUOLI_KEY, JSON.stringify(remaining));
    // Track deletion with name for cloud-side dedup cleanup
    trackDeletion('ruolo', id, ruolo?.nome);
}

/**
 * Rinomina un ruolo e aggiorna tutte le persone che lo usano.
 * Restituisce il numero di persone aggiornate.
 */
export function renameRuolo(id, newNome) {
    const ruolo = getRuolo(id);
    if (!ruolo) return 0;
    const oldNome = ruolo.nome;
    if (oldNome === newNome) return 0;

    // Aggiorna il ruolo
    saveRuolo({ id, nome: newNome });

    // Aggiorna tutte le persone che hanno il vecchio nome
    const persone = listPersone();
    let count = 0;
    for (const p of persone) {
        if (p.ruolo === oldNome) {
            savePersona({ id: p.id, ruolo: newNome }, 'rinomina_ruolo');
            count++;
        }
    }
    return count;
}

/**
 * Sincronizza i ruoli con le persone esistenti.
 * Aggiunge ruoli mancanti (presenti in persone ma non nell'elenco ruoli).
 */
export function syncRuoliFromPersone() {
    const ruoli = listRuoli();
    const persone = listPersone();
    const existing = new Set(ruoli.map(r => r.nome.toLowerCase()));
    let added = 0;

    for (const p of persone) {
        const ruolo = (p.ruolo || '').trim();
        if (ruolo && !existing.has(ruolo.toLowerCase())) {
            existing.add(ruolo.toLowerCase());
            ruoli.push({
                id: genId(),
                nome: ruolo,
                costoMedio: p.costoMedioMese || 0,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            });
            added++;
        }
    }

    if (added > 0) {
        localStorage.setItem(RUOLI_KEY, JSON.stringify(ruoli));
    }
    return added;
}

// ─── PERSONE ────────────────────────────────────────────────

export function listPersone() {
    try {
        const persone = JSON.parse(localStorage.getItem(PERSONE_KEY) || '[]');
        // Migrazione: ripara persone senza id (bug precedente dove id:genId() veniva
        // sovrascritto da ...data con id:undefined, poi JSON.stringify ometteva la chiave)
        let personaChanged = false;
        const idRemap = new Map(); // old broken reference → new valid id

        for (const p of persone) {
            if (!p.id) {
                const newId = genId();
                // Il personaId nelle allocazioni era la stringa "undefined"
                // (perché ${p.id} === ${undefined} === "undefined" nel template)
                idRemap.set('undefined', newId);
                idRemap.set(undefined, newId); // per sicurezza, caso JS undefined
                p.id = newId;
                personaChanged = true;
            }
        }

        if (personaChanged) {
            localStorage.setItem(PERSONE_KEY, JSON.stringify(persone));
            // Ripara anche le allocazioni che referenziano i vecchi id corrotti
            try {
                const allocs = JSON.parse(localStorage.getItem(ALLOCAZIONI_KEY) || '[]');
                let allocChanged = false;
                for (const a of allocs) {
                    // Ripara personaId corrotto
                    const newPersonaId = idRemap.get(a.personaId);
                    if (newPersonaId !== undefined) { a.personaId = newPersonaId; allocChanged = true; }
                    // Ripara allocazioni senza id (stesso bug)
                    if (!a.id) { a.id = genId(); allocChanged = true; }
                }
                if (allocChanged) localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify(allocs));
            } catch { /* non bloccante */ }
        }

        return persone;
    }
    catch { return []; }
}

export function getPersona(id) {
    return listPersone().find(p => p.id === id) || null;
}

export function savePersona(data, origine = 'manuale') {
    const persone = listPersone();
    const now = new Date().toISOString();

    if (data.id) {
        // UPDATE
        const idx = persone.findIndex(p => p.id === data.id);
        if (idx === -1) return null;
        const old = { ...persone[idx] };
        const updated = { ...persone[idx], ...data, updatedAt: now };
        if (updated.cognome) updated.cognome = updated.cognome.toUpperCase();
        if (updated.codiceFiscale) updated.codiceFiscale = updated.codiceFiscale.toUpperCase();
        persone[idx] = updated;
        localStorage.setItem(PERSONE_KEY, JSON.stringify(persone));
        _audit('persona', data.id, 'update', old, updated, origine);
        return updated;
    }

    // CREATE — check duplicate CF
    if (data.codiceFiscale) {
        const cf = data.codiceFiscale.toUpperCase().trim();
        const dup = persone.find(p => p.codiceFiscale && p.codiceFiscale.toUpperCase() === cf);
        if (dup) return { error: `Codice fiscale già presente: ${dup.cognome} ${dup.nome}` };
    }

    const nuova = {
        codiceFiscale: '', cognome: '', nome: '',
        societa: '', bu: '', cdc: '', vdc: '', tdc: '',
        ruolo: '', tipoContratto: 'DIPENDENTE',
        dataAssunzione: '', dataTermine: '',
        costoMedioMese: 0, note: '', attivo: true, statoAssunzione: 'assunta',
        ...data,
        id: genId(),   // DOPO ...data: l'id generato non può essere sovrascritto da data
        createdAt: now, updatedAt: now,
    };
    if (nuova.cognome) nuova.cognome = nuova.cognome.toUpperCase();
    if (nuova.codiceFiscale) nuova.codiceFiscale = nuova.codiceFiscale.toUpperCase();

    persone.push(nuova);
    localStorage.setItem(PERSONE_KEY, JSON.stringify(persone));
    _audit('persona', nuova.id, 'create', null, nuova, origine);
    return nuova;
}

export function deletePersona(id) {
    const persone = listPersone().filter(p => p.id !== id);
    localStorage.setItem(PERSONE_KEY, JSON.stringify(persone));
    // Track and remove related allocations
    const allAlloc = listAllocazioni();
    allAlloc.filter(a => a.personaId === id).forEach(a => trackDeletion('allocazione', a.id));
    const remaining = allAlloc.filter(a => a.personaId !== id);
    localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify(remaining));
    _audit('persona', id, 'delete', null, null, 'manuale');
}

// ─── ALLOCAZIONI ────────────────────────────────────────────

export function listAllocazioni(filters = {}) {
    try {
        let all = JSON.parse(localStorage.getItem(ALLOCAZIONI_KEY) || '[]');
        // Migrazione: ripara allocazioni senza id proprio (stesso bug delle persone)
        let changed = false;
        for (const a of all) {
            if (!a.id) { a.id = genId(); changed = true; }
        }
        if (changed) localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify(all));

        if (filters.personaId !== undefined) all = all.filter(a => a.personaId === filters.personaId);
        if (filters.codiceCommessa !== undefined) all = all.filter(a => a.codiceCommessa === filters.codiceCommessa);
        if (filters.scenarioId !== undefined) all = all.filter(a => a.scenarioId === filters.scenarioId);
        return all;
    } catch { return []; }
}

export function getAllocazione(id) {
    return listAllocazioni().find(a => a.id === id) || null;
}

export function saveAllocazione(data, origine = 'manuale') {
    const all = listAllocazioni();
    const now = new Date().toISOString();

    if (data.id) {
        // UPDATE
        const idx = all.findIndex(a => a.id === data.id);
        if (idx === -1) return null;
        // Lock check: non modificare allocazioni di scenari bloccati
        if (_isScenarioLocked(all[idx].scenarioId)) return { error: 'Lo scenario è bloccato. Sblocca o duplica per modificare.' };
        const old = { ...all[idx] };
        const updated = { ...all[idx], ...data, updatedAt: now };
        const err = _validateAllocazione(updated) || _validateSaturation(updated, all);
        if (err) return { error: err };
        all[idx] = updated;
        localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify(all));
        _audit('allocazione', data.id, 'update', old, updated, origine);
        return updated;
    }

    // CREATE — lock check on target scenario
    const targetScenarioId = data.scenarioId !== undefined ? data.scenarioId : null;
    if (_isScenarioLocked(targetScenarioId)) return { error: 'Lo scenario è bloccato. Sblocca o duplica per modificare.' };

    const nuova = {
        personaId: '', codiceCommessa: '', scenarioId: null,
        percentuale: 100, dataInizio: '', dataFine: '',
        aggancioInizio: false, aggancioFine: false,
        deltaInizio: 0, deltaFine: 0,
        origine, isBase: false, note: '',
        ...data,
        id: genId(),   // DOPO ...data: l'id generato non può essere sovrascritto da data
        createdAt: now, updatedAt: now,
    };

    const err = _validateAllocazione(nuova) || _validateSaturation(nuova, all);
    if (err) return { error: err };

    all.push(nuova);
    localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify(all));
    _audit('allocazione', nuova.id, 'create', null, nuova, origine);
    return nuova;
}

export function deleteAllocazione(id) {
    // Lock check
    const alloc = getAllocazione(id);
    if (alloc && _isScenarioLocked(alloc.scenarioId)) return { error: 'Lo scenario è bloccato. Sblocca o duplica per modificare.' };
    const all = listAllocazioni().filter(a => a.id !== id);
    localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify(all));
    trackDeletion('allocazione', id);
    _audit('allocazione', id, 'delete', null, null, 'manuale');
}

/**
 * Copia tutte le allocazioni da uno scenario a un altro.
 * Restituisce il numero di allocazioni copiate.
 */
export function copyAllocazioniScenario(fromScenarioId, toScenarioId) {
    // Lock check: target scenario must not be locked (reading from source is fine)
    if (_isScenarioLocked(toScenarioId)) return { error: 'Lo scenario destinazione è bloccato.' };
    const src = listAllocazioni({ scenarioId: fromScenarioId });
    if (!src.length) return 0;
    const now = new Date().toISOString();
    const copies = src.map(a => ({
        ...a,
        id: genId(),
        scenarioId: toScenarioId,
        origine: 'copiato',
        createdAt: now,
        updatedAt: now,
    }));
    const all = listAllocazioni();
    localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify([...all, ...copies]));
    _audit('allocazione', toScenarioId, 'copy_from_scenario', fromScenarioId, copies.length, 'manuale');
    return copies.length;
}

export function deleteAllocazioniScenario(scenarioId) {
    // Lock check
    if (_isScenarioLocked(scenarioId)) return { error: 'Lo scenario è bloccato.' };
    const allAlloc = listAllocazioni();
    allAlloc.filter(a => a.scenarioId === scenarioId).forEach(a => trackDeletion('allocazione', a.id));
    const remaining = allAlloc.filter(a => a.scenarioId !== scenarioId);
    localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify(remaining));
}

/**
 * Aggiorna il codice commessa in tutte le allocazioni.
 * Restituisce il numero di allocazioni modificate.
 */
export function renameCommessaCodice(oldCodice, newCodice) {
    if (!oldCodice || !newCodice || oldCodice === newCodice) return 0;
    const all = listAllocazioni();
    let count = 0;
    for (const a of all) {
        if (a.codiceCommessa === oldCodice) {
            a.codiceCommessa = newCodice;
            count++;
        }
    }
    if (count > 0) localStorage.setItem(ALLOCAZIONI_KEY, JSON.stringify(all));
    return count;
}

// ─── VALIDATION ──────────────────────────────────────────────

function _validateAllocazione(a) {
    if (!a.personaId) return 'Persona obbligatoria';
    if (!a.codiceCommessa) return 'Commessa obbligatoria';
    if (!a.percentuale || a.percentuale <= 0) return 'Percentuale deve essere > 0';
    if (a.percentuale > 100) return 'Percentuale per riga non può superare 100%';
    if (a.dataInizio && a.dataFine && a.dataInizio > a.dataFine) return 'Data inizio > data fine';
    return null;
}

function _validateSaturation(alloc, existing) {
    if (!alloc.dataInizio || !alloc.dataFine) return null;
    const mesi = getMonthsInRange(alloc.dataInizio, alloc.dataFine);
    for (const mese of mesi) {
        const totale = existing
            .filter(a => a.id !== alloc.id && a.personaId === alloc.personaId && a.scenarioId === alloc.scenarioId)
            .filter(a => a.dataInizio && a.dataFine && isMonthInRange(mese, a.dataInizio, a.dataFine))
            .reduce((s, a) => s + (a.percentuale || 0), 0);
        if (totale + alloc.percentuale > 100) {
            return `Saturazione > 100% nel mese ${formatYM(mese)} (occupato: ${totale}%, da aggiungere: ${alloc.percentuale}%)`;
        }
    }
    return null;
}

export function checkWarnings(alloc, commesse = []) {
    const warnings = [];
    const persona = getPersona(alloc.personaId);
    if (persona) {
        if (!persona.costoMedioMese) warnings.push('Costo mensile non valorizzato');
        if (!persona.ruolo) warnings.push('Ruolo non valorizzato');
        if (persona.dataTermine && alloc.dataFine && alloc.dataFine > persona.dataTermine) {
            warnings.push(`Allocazione oltre data termine persona (${formatYM(persona.dataTermine)})`);
        }
    }
    const c = commesse.find(x => x.codice === alloc.codiceCommessa);
    if (c?.dataFine && alloc.dataFine && alloc.dataFine.slice(0, 7) > String(c.dataFine).slice(0, 7)) {
        warnings.push('Allocazione oltre data fine prevista della commessa');
    }
    return warnings;
}

// ─── AUDIT ───────────────────────────────────────────────────

export function listAudit(filters = {}) {
    try {
        let all = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]');
        if (filters.entita) all = all.filter(a => a.entita === filters.entita);
        if (filters.entitaId) all = all.filter(a => a.entitaId === filters.entitaId);
        return all.slice().reverse();
    } catch { return []; }
}

function _audit(entita, entitaId, operazione, old, nuova, origine) {
    try {
        const a = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]');
        a.push({ id: genId(), entita, entitaId, operazione, vecchioValore: old, nuovoValore: nuova, origine, timestamp: new Date().toISOString() });
        if (a.length > 1000) a.splice(0, a.length - 1000);
        localStorage.setItem(AUDIT_KEY, JSON.stringify(a));
    } catch { /* non-critical */ }
}

// ─── DATE HELPERS ─────────────────────────────────────────────

export function getMonthsInRange(dataInizio, dataFine) {
    if (!dataInizio || !dataFine) return [];
    const s = String(dataInizio).slice(0, 7);
    const e = String(dataFine).slice(0, 7);
    if (s > e) return [];
    const [sy, sm] = s.split('-').map(Number);
    const [ey, em] = e.split('-').map(Number);
    const months = [];
    let y = sy, m = sm;
    while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        if (++m > 12) { m = 1; y++; }
    }
    return months;
}

export function isMonthInRange(mese, dataInizio, dataFine) {
    if (!dataInizio || !dataFine) return false;
    return mese >= String(dataInizio).slice(0, 7) && mese <= String(dataFine).slice(0, 7);
}

export function excelSerialToYM(serial) {
    if (!serial || isNaN(serial)) return '';
    const d = new Date(Math.round((Number(serial) - 25569) * 86400 * 1000));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function formatYM(ym) {
    if (!ym) return '—';
    const s = String(ym).slice(0, 7);
    const [y, m] = s.split('-');
    return `${MESI_IT[parseInt(m) - 1] || m} ${y}`;
}

/**
 * Aggiunge n mesi a una stringa "YYYY-MM". Funziona anche con n negativi.
 */
export function addMonths(ym, n) {
    if (!ym || !n) return ym;
    const [y, m] = String(ym).slice(0, 7).split('-').map(Number);
    const total = y * 12 + (m - 1) + n;
    const ny = Math.floor(total / 12);
    const nm = (total % 12) + 1;
    return `${ny}-${String(nm).padStart(2, '0')}`;
}

export function formatEuro(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0, useGrouping: true }).format(n);
}

// ─── IMPORT HELPERS ───────────────────────────────────────────

export function importPersoneFromRows(rows) {
    const res = { created: 0, updated: 0, errors: [], warnings: [] };
    for (const row of rows) {
        const cognome = String(row.cognome || '').trim().toUpperCase();
        if (!cognome) { res.errors.push('Riga saltata: Cognome obbligatorio'); continue; }
        const cf = String(row.codiceFiscale || '').trim().toUpperCase();

        const existing = cf ? listPersone().find(p => p.codiceFiscale && p.codiceFiscale.toUpperCase() === cf) : null;
        const payload = {
            cognome,
            nome: String(row.nome || '').trim(),
            codiceFiscale: cf,
            ruolo: String(row.ruolo || '').trim(),
            tipoContratto: String(row.tipoContratto || 'DIPENDENTE').trim(),
            societa: String(row.societa || '').trim(),
            bu: String(row.bu || '').trim(),
            cdc: String(row.cdc || '').trim(),
            costoMedioMese: parseFloat(row.costoMedioMese) || 0,
            dataAssunzione: row.dataAssunzione ? (isNaN(row.dataAssunzione) ? String(row.dataAssunzione).slice(0, 7) : excelSerialToYM(row.dataAssunzione)) : '',
            dataTermine: row.dataTermine ? (isNaN(row.dataTermine) ? String(row.dataTermine).slice(0, 7) : excelSerialToYM(row.dataTermine)) : '',
            note: String(row.note || '').trim(),
            ...(row.statoAssunzione ? { statoAssunzione: String(row.statoAssunzione).trim().toLowerCase().replace(/\s+/g, '_') } : {}),
        };

        if (existing) {
            const r = savePersona({ ...payload, id: existing.id }, 'importato');
            if (r?.error) res.errors.push(r.error); else res.updated++;
        } else {
            const r = savePersona(payload, 'importato');
            if (r?.error) res.errors.push(r.error); else res.created++;
        }
    }
    return res;
}

export function importAllocazioniFromRows(rows, scenarioId, commesse = []) {
    const res = { created: 0, errors: [], warnings: [] };
    for (const row of rows) {
        const cf = String(row.codiceFiscale || '').trim().toUpperCase();
        const cognome = String(row.cognome || '').trim().toUpperCase();
        const nome = String(row.nome || '').trim().toLowerCase();

        let persona = null;
        if (cf) persona = listPersone().find(p => p.codiceFiscale && p.codiceFiscale.toUpperCase() === cf);
        if (!persona && cognome) persona = listPersone().find(p => p.cognome === cognome && (p.nome || '').toLowerCase() === nome);
        if (!persona) { res.errors.push(`Persona non trovata: ${cognome} ${nome}`); continue; }

        const percRaw = parseFloat(row.percentuale);
        const perc = percRaw <= 1 ? percRaw * 100 : percRaw;

        const diRaw = row.dataInizio;
        const dfRaw = row.dataFine;
        const di = diRaw ? (isNaN(diRaw) ? String(diRaw).slice(0, 7) : excelSerialToYM(diRaw)) : '';
        const df = dfRaw ? (isNaN(dfRaw) ? String(dfRaw).slice(0, 7) : excelSerialToYM(dfRaw)) : '';

        const parseBool = v => {
            if (typeof v === 'boolean') return v;
            const s = String(v).trim().toLowerCase();
            return s === 'sì' || s === 'si' || s === 'true' || s === '1' || s === 'yes';
        };
        const alloc = {
            personaId: persona.id,
            codiceCommessa: String(row.codiceCommessa || '').trim(),
            scenarioId: scenarioId || null,
            percentuale: perc,
            dataInizio: di,
            dataFine: df,
            aggancioInizio: row.aggancioInizio !== undefined ? parseBool(row.aggancioInizio) : false,
            aggancioFine:   row.aggancioFine   !== undefined ? parseBool(row.aggancioFine)   : false,
            deltaInizio:    row.deltaInizio     !== undefined ? parseInt(row.deltaInizio, 10) || 0 : 0,
            deltaFine:      row.deltaFine       !== undefined ? parseInt(row.deltaFine, 10)   || 0 : 0,
            note: String(row.note || '').trim(),
        };

        const w = checkWarnings(alloc, commesse);
        if (w.length) res.warnings.push(...w.map(x => `${persona.cognome}: ${x}`));

        const r = saveAllocazione(alloc, 'importato');
        if (r?.error) res.errors.push(`${persona.cognome} / ${alloc.codiceCommessa}: ${r.error}`);
        else res.created++;
    }
    return res;
}
