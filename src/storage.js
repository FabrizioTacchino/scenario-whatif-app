/**
 * storage.js — Scrittura sicura su localStorage + tracciamento delle righe modificate.
 *
 * Due responsabilità, entrambe senza dipendenze da altri moduli (nessun rischio di ciclo):
 *
 * 1. safeSetItem(): sostituisce localStorage.setItem() intercettando QuotaExceededError.
 *    Prima di questo modulo 57 delle 60 scritture erano scoperte: a quota piena l'eccezione
 *    interrompeva il gestore del click e l'utente non vedeva alcun errore (la modale restava
 *    semplicemente aperta), credendo di aver salvato.
 *
 * 2. trackChange(): registra l'id delle righe toccate localmente, così il push può inviare
 *    SOLO quelle invece dell'intera tabella. È lo stesso schema di trackDeletion() in
 *    syncManager.js, applicato alle modifiche invece che alle cancellazioni.
 */

// ─── Scrittura sicura ────────────────────────────────────────

const _errorListeners = [];

/**
 * Registra un callback invocato quando una scrittura fallisce.
 * @param {(info: {key: string, error: Error, usage: object}) => void} cb
 */
export function onStorageError(cb) {
    if (typeof cb === 'function') _errorListeners.push(cb);
}

function _isQuotaError(err) {
    if (!err) return false;
    // Nomi/codici usati dai vari browser per lo stesso errore
    return err.name === 'QuotaExceededError'
        || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || err.code === 22
        || err.code === 1014;
}

/**
 * Scrive su localStorage segnalando l'esito.
 * @returns {boolean} true se salvato, false se la scrittura è fallita.
 */
export function safeSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (err) {
        const usage = getStorageUsage();
        const quota = _isQuotaError(err);
        console.error(
            `[storage] Scrittura di "${key}" FALLITA${quota ? ' (spazio esaurito)' : ''}:`,
            err.message, usage
        );
        const info = { key, error: err, usage, quotaExceeded: quota };
        if (_errorListeners.length) {
            for (const cb of _errorListeners) {
                try { cb(info); } catch { /* un listener rotto non deve bloccare gli altri */ }
            }
        } else {
            _fallbackNotify(info);
        }
        return false;
    }
}

/**
 * Avviso di emergenza se nessuno ha registrato un listener: senza questo il fallimento
 * resterebbe invisibile, che è esattamente il problema da eliminare.
 */
function _fallbackNotify({ key, quotaExceeded, usage }) {
    const msg = quotaExceeded
        ? `SPAZIO ESAURITO: i dati NON sono stati salvati (${key}).\n\n`
          + `Occupati ${usage.megabytes} MB su un limite di circa 5-10 MB.\n\n`
          + `Non chiudere l'applicazione: esporta subito un backup dal menu e avvisa l'amministratore.`
        : `I dati NON sono stati salvati (${key}). Esporta un backup e avvisa l'amministratore.`;
    try {
        if (typeof window !== 'undefined' && typeof window.alert === 'function') window.alert(msg);
    } catch { /* ambiente senza window */ }
}

/**
 * Occupazione approssimativa di localStorage.
 * @returns {{characters: number, megabytes: string, byKey: object}}
 */
export function getStorageUsage() {
    let total = 0;
    const byKey = {};
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            const len = (localStorage.getItem(k) || '').length + k.length;
            byKey[k] = len;
            total += len;
        }
    } catch { /* storage non accessibile */ }
    return {
        characters: total,
        megabytes: (total / 1024 / 1024).toFixed(2),
        byKey
    };
}

// ─── Tracciamento delle righe modificate ─────────────────────

const DIRTY_KEYS = {
    scenario:   'whatif_dirty_scenarios',
    persona:    'whatif_dirty_persone',
    allocazione:'whatif_dirty_allocazioni',
    ruolo:      'whatif_dirty_ruoli'
};

/** Mappa chiave-localStorage → tipo, per l'uso dal lato sync. */
export const DIRTY_TYPE_BY_SYNC_KEY = {
    whatif_scenarios:   'scenario',
    whatif_persone:     'persona',
    whatif_allocazioni: 'allocazione',
    whatif_ruoli:       'ruolo'
};

/**
 * Il registro delle righe in attesa non è un semplice elenco di id ma una mappa
 * id -> numero di versione, incrementato a ogni modifica.
 *
 * Serve a un caso preciso: il push fotografa le righe da inviare, le manda a lotti
 * di 100 e alla fine le toglie dal registro. Se durante il volo l'utente modifica
 * di nuovo una di quelle righe, con un semplice elenco la modifica veniva
 * registrata e subito dopo cancellata dal clearDirty — restava in locale e non
 * partiva più. Confrontando la versione, una riga toccata nel frattempo resta
 * in attesa e riparte al giro successivo.
 *
 * Il formato vecchio (array di id) viene letto e convertito senza perdite.
 */
function _readVersions(type) {
    const key = DIRTY_KEYS[type];
    if (!key) return null;
    try {
        const grezzo = JSON.parse(localStorage.getItem(key) || '{}');
        if (Array.isArray(grezzo)) {
            // formato precedente: ogni id parte dalla versione 1
            const m = {};
            for (const id of grezzo) if (id) m[id] = 1;
            return m;
        }
        return (grezzo && typeof grezzo === 'object') ? grezzo : {};
    } catch {
        return {};
    }
}

function _writeVersions(type, versions) {
    const key = DIRTY_KEYS[type];
    if (!key) return;
    safeSetItem(key, JSON.stringify(versions));
}

/**
 * Segna una riga come modificata localmente e non ancora sincronizzata.
 * Va chiamata da ogni funzione che crea o modifica una riga.
 */
export function trackChange(type, localId) {
    if (!localId || !DIRTY_KEYS[type]) return;
    const v = _readVersions(type);
    v[localId] = (v[localId] || 0) + 1;
    _writeVersions(type, v);
}

/** Segna più righe in una sola scrittura (per copie e import massivi). */
export function trackChanges(type, localIds = []) {
    if (!DIRTY_KEYS[type] || !localIds.length) return;
    const v = _readVersions(type);
    let cambiato = false;
    for (const id of localIds) {
        if (!id) continue;
        v[id] = (v[id] || 0) + 1;
        cambiato = true;
    }
    if (cambiato) _writeVersions(type, v);
}

/** Id delle righe da sincronizzare. */
export function getDirty(type) {
    return new Set(Object.keys(_readVersions(type) || {}));
}

/**
 * Fotografia delle righe in attesa, con la loro versione. Va passata a
 * clearDirtySynced() al termine del push.
 */
export function snapshotDirty(type) {
    return { ...(_readVersions(type) || {}) };
}

/**
 * Toglie dal registro SOLO le righe la cui versione non è cambiata dalla
 * fotografia: quelle modificate mentre il push era in volo restano in attesa.
 * @returns {number} quante righe sono rimaste in attesa perché modificate nel frattempo
 */
export function clearDirtySynced(type, snapshot) {
    const v = _readVersions(type);
    if (!v || !snapshot) return 0;
    let riMarcate = 0;
    for (const [id, versioneInviata] of Object.entries(snapshot)) {
        if (v[id] === undefined) continue;
        if (v[id] === versioneInviata) delete v[id];
        else riMarcate++;   // toccata durante il volo: resta da inviare
    }
    _writeVersions(type, v);
    return riMarcate;
}

/** Rimuove dal registro gli id indicati (o tutti, se null). */
export function clearDirty(type, localIds = null) {
    const v = _readVersions(type);
    if (!v) return;
    if (localIds === null) { _writeVersions(type, {}); return; }
    for (const id of localIds) delete v[id];
    _writeVersions(type, v);
}

/**
 * Azzera tutti i registri. Da usare dopo un fullPull riuscito: a quel punto il
 * locale coincide con il cloud e non c'è nulla di non sincronizzato.
 */
export function clearAllDirty() {
    for (const type of Object.keys(DIRTY_KEYS)) _writeVersions(type, {});
}

/** Numero totale di righe in attesa di sincronizzazione (per l'indicatore in UI). */
export function countPendingChanges() {
    let n = 0;
    for (const type of Object.keys(DIRTY_KEYS)) n += Object.keys(_readVersions(type) || {}).length;
    return n;
}
