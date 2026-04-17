// ─── Sync Manager — Scenario Whatif ──────────────────────────
// Bidirectional sync between localStorage and Supabase.
// SHARED WORKSPACE: all authenticated users see the same data.
// localStorage remains source of truth; Supabase is the cloud mirror.
// Uses hash-polling to detect local changes (non-invasive).

import { supabase, getSession, getUserRole } from './supabaseClient.js';

// ─── Constants ───────────────────────────────────────────────

const SYNC_KEYS = [
    'whatif_baseline',
    'whatif_scenarios',
    'whatif_persone',
    'whatif_allocazioni',
    'whatif_audit',
    'whatif_ruoli'
];

const POLL_INTERVAL_MS = 2000;
const PERIODIC_SYNC_MS = 15 * 1000; // 15 sec
const MAX_RETRY = 3;
const QUEUE_KEY = 'whatif_sync_queue';
const LAST_SYNC_KEY = 'whatif_sync_last';
const DELETED_SCENARIOS_KEY = 'whatif_deleted_scenarios';
const DELETED_PERSONE_KEY = 'whatif_deleted_persone';
const DELETED_ALLOCAZIONI_KEY = 'whatif_deleted_allocazioni';
const DELETED_RUOLI_KEY = 'whatif_deleted_ruoli';

// Role-based write permissions per entity
const WRITE_ROLES = {
    'whatif_baseline':    ['admin', 'editor', 'commercial'],
    'whatif_scenarios':   ['admin', 'editor', 'commercial', 'tester'],
    'whatif_persone':     ['admin', 'editor', 'hr'],
    'whatif_allocazioni': ['admin', 'editor', 'commercial'],
    'whatif_audit':       ['admin', 'editor', 'hr', 'commercial'],
    'whatif_ruoli':       ['admin', 'editor', 'hr']
};

// ─── State ───────────────────────────────────────────────────

let _hashes = {};
let _pollTimer = null;
let _periodicTimer = null;
let _realtimeChannel = null;
let _presenceChannel = null;
let _syncing = false;
let _userRole = null;
let _userEmail = null;
let _userId = null;
let _onlineUsers = []; // { email, role, joinedAt }
let _presenceListeners = [];
let _pushBlocked = false; // true if app version is too old
let _appVersion = null;
let _status = { state: 'disconnected', lastSync: null, pending: 0, error: null };
let _listeners = [];

// ─── Public API ──────────────────────────────────────────────

export function getSyncStatus() {
    return { ..._status };
}

export function onSyncStatusChange(callback) {
    _listeners.push(callback);
    return () => { _listeners = _listeners.filter(l => l !== callback); };
}

function _notifyListeners() {
    _listeners.forEach(l => l({ ..._status }));
}

function _setStatus(updates) {
    Object.assign(_status, updates);
    _notifyListeners();
}

/**
 * Initialize sync after successful login.
 * Returns: 'pushed' | 'pulled' | 'synced' | 'empty'
 */
export async function initSync() {
    const session = await getSession();
    if (!session) return null;

    _setStatus({ state: 'syncing', error: null });

    try {
        const userId = session.user.id;
        _userEmail = session.user.email || '';
        _userRole = await getUserRole();

        // Check minimum version required for push
        await _checkMinVersion();

        const cloudHasData = await _cloudHasData();
        const localHasData = _localHasData();

        let result;

        if (localHasData && !cloudHasData && _userRole !== 'viewer' && canWrite('whatif_scenarios')) {
            // Solo locale ha dati: push iniziale al cloud
            await fullPush(userId);
            result = 'pushed';
        } else if (cloudHasData) {
            // Cloud ha dati: SEMPRE full pull all'avvio per allinearsi
            // Questo garantisce che si parta dalla fonte di verità (cloud)
            // e non si sovrascrivano modifiche di altri utenti con dati locali stale
            await fullPull(userId);
            result = 'pulled';
        } else {
            result = 'empty';
        }

        _userId = userId;
        _snapshotHashes();
        _startPolling(userId);
        _startPeriodicSync(userId);
        _startRealtime(userId);
        _startPresence(userId);

        window.addEventListener('online', () => _flushQueue(userId));
        window.addEventListener('offline', () => _setStatus({ state: 'offline' }));

        const serverNow = await _getServerTime();
        _setStatus({ state: 'connected', lastSync: serverNow });
        localStorage.setItem(LAST_SYNC_KEY, serverNow);

        return result;
    } catch (err) {
        console.error('[SyncManager] initSync error:', err);
        _setStatus({ state: 'error', error: err.message });
        return null;
    }
}

/**
 * Check if current role can write to a given entity.
 */
export function canWrite(localStorageKey) {
    if (!_userRole) return false;
    const allowed = WRITE_ROLES[localStorageKey];
    return allowed ? allowed.includes(_userRole) : false;
}

/**
 * Get current user role (cached after init).
 */
export function getCurrentRole() {
    return _userRole;
}

/**
 * Get list of currently online users (from Supabase Presence).
 * Returns: [{ email, role, joinedAt }]
 */
export function getOnlineUsers() {
    return [..._onlineUsers];
}

/**
 * Listen for changes in online users.
 * Callback receives the updated list of online users.
 */
export function onPresenceChange(callback) {
    _presenceListeners.push(callback);
    return () => { _presenceListeners = _presenceListeners.filter(l => l !== callback); };
}

/**
 * Check if the current app version meets the minimum required for pushing.
 * If not, blocks all push operations and shows a warning.
 */
async function _checkMinVersion() {
    try {
        // Get app version from package.json (injected by Vite at build time)
        _appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : null;

        const { data, error } = await supabase
            .from('app_config')
            .select('value')
            .eq('key', 'min_push_version')
            .maybeSingle();

        if (error || !data) return; // if table doesn't exist, don't block

        const minVersion = data.value;
        if (_appVersion && _compareVersions(_appVersion, minVersion) < 0) {
            _pushBlocked = true;
            console.warn(`[SyncManager] Push blocked: app version ${_appVersion} < minimum ${minVersion}. Update required.`);
            // Notify UI
            _setStatus({ state: 'connected', pushBlocked: true, minVersion });
        }
    } catch (err) {
        console.warn('[SyncManager] Version check failed (non-blocking):', err.message);
    }
}

/**
 * Compare two semver strings. Returns -1, 0, or 1.
 */
function _compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const va = pa[i] || 0;
        const vb = pb[i] || 0;
        if (va < vb) return -1;
        if (va > vb) return 1;
    }
    return 0;
}

/**
 * Track an explicit deletion so it can be pushed to cloud.
 * Call this when the user deletes a scenario/persona/allocazione locally.
 */
export function trackDeletion(type, localId, extra = null) {
    const keyMap = {
        'scenario': DELETED_SCENARIOS_KEY,
        'persona': DELETED_PERSONE_KEY,
        'allocazione': DELETED_ALLOCAZIONI_KEY,
        'ruolo': DELETED_RUOLI_KEY
    };
    const key = keyMap[type];
    if (!key) return;

    // For ruoli, store {id, nome} to allow cloud-side dedup deletion by name
    if (type === 'ruolo') {
        const list = JSON.parse(localStorage.getItem(key) || '[]');
        // Normalize: convert old plain-string entries to objects
        const normalized = list.map(item => typeof item === 'string' ? { id: item, nome: null } : item);
        if (!normalized.some(e => e.id === localId)) {
            normalized.push({ id: localId, nome: extra || null });
            localStorage.setItem(key, JSON.stringify(normalized));
        }
        return;
    }

    const list = JSON.parse(localStorage.getItem(key) || '[]');
    if (!list.includes(localId)) {
        list.push(localId);
        localStorage.setItem(key, JSON.stringify(list));
    }
}

export function stopSync() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    if (_periodicTimer) { clearInterval(_periodicTimer); _periodicTimer = null; }
    if (_realtimeChannel) {
        supabase.removeChannel(_realtimeChannel);
        _realtimeChannel = null;
    }
    if (_presenceChannel) {
        supabase.removeChannel(_presenceChannel);
        _presenceChannel = null;
    }
    _hashes = {};
    _userRole = null;
    _userEmail = null;
    _userId = null;
    _onlineUsers = [];
    _notifyPresenceListeners();
    _setStatus({ state: 'disconnected', lastSync: null, pending: 0, error: null });
}

/**
 * Full push: upload all localStorage data to Supabase (shared workspace).
 */
export async function fullPush(userId) {
    if (!userId) {
        const session = await getSession();
        if (!session) throw new Error('Not authenticated');
        userId = session.user.id;
    }

    // Version gate: block push if app is too old
    if (_pushBlocked) {
        throw new Error('Versione dell\'app troppo vecchia. Aggiorna per poter modificare i dati.');
    }

    // Role gating: viewers cannot push
    if (_userRole === 'viewer') {
        console.warn('[SyncManager] viewer cannot push data');
        return;
    }

    _setStatus({ state: 'syncing' });

    if (canWrite('whatif_baseline'))    await _pushBaseline(userId);
    if (canWrite('whatif_scenarios'))   await _pushScenarios(userId);
    if (canWrite('whatif_persone'))     await _pushPersone(userId);
    if (canWrite('whatif_allocazioni')) await _pushAllocazioni(userId);
    if (canWrite('whatif_audit'))       await _pushAudit(userId);
    if (canWrite('whatif_ruoli'))       await _pushRuoli(userId);
    await _pushPreferences(userId);
}

/**
 * Full pull: download all shared data from Supabase to localStorage.
 */
export async function fullPull(userId) {
    if (!userId) {
        const session = await getSession();
        if (!session) throw new Error('Not authenticated');
        userId = session.user.id;
    }

    _setStatus({ state: 'syncing' });
    _backupLocal();

    await _pullBaseline();
    await _pullScenarios();
    await _pullPersone();
    await _pullAllocazioni();
    _deduplicatePersone();
    _deduplicateAllocazioni();
    await _pullAudit();
    await _pullRuoli();
    _deduplicateRuoli();
    await _pullPreferences(userId); // preferences remain per-user
}

/**
 * Incremental sync: push local changes + pull remote changes.
 */
export async function incrementalSync(userId) {
    if (!userId) {
        const session = await getSession();
        if (!session) throw new Error('Not authenticated');
        userId = session.user.id;
    }

    if (_syncing) return;
    _syncing = true;

    try {
        // Push locally changed entities (role-based per entity)
        // Errors in push must NOT block the pull phase
        for (const key of SYNC_KEYS) {
            if (!canWrite(key)) continue;
            const currentHash = _hashString(localStorage.getItem(key) || '');
            if (currentHash !== _hashes[key]) {
                try {
                    await _pushEntity(key, userId);
                    _hashes[key] = currentHash;
                } catch (pushErr) {
                    console.warn(`[SyncManager] Push ${key} failed (non-blocking):`, pushErr.message);
                }
            }
        }

        // Snapshot hashes before pull to detect remote changes
        const hashesBeforePull = {};
        for (const key of SYNC_KEYS) {
            hashesBeforePull[key] = _hashString(localStorage.getItem(key) || '');
        }

        // Pull remote changes newer than last sync
        const lastSync = localStorage.getItem(LAST_SYNC_KEY) || '1970-01-01T00:00:00Z';
        await _pullIfNewer(lastSync);

        // Post-pull: deduplicate persone + allocazioni + ruoli (safety net)
        _deduplicatePersone();
        _deduplicateAllocazioni();
        _deduplicateRuoli();

        // Detect if pull changed any data
        let dataChanged = false;
        const changedKeys = [];
        for (const key of SYNC_KEYS) {
            const newHash = _hashString(localStorage.getItem(key) || '');
            if (newHash !== hashesBeforePull[key]) {
                _hashes[key] = newHash;
                dataChanged = true;
                changedKeys.push(key);
            }
        }

        const serverNow = await _getServerTime();
        localStorage.setItem(LAST_SYNC_KEY, serverNow);
        _setStatus({ state: 'connected', lastSync: serverNow, error: null, dataChanged, changedKeys });
    } catch (err) {
        console.error('[SyncManager] incrementalSync error:', err);
        _setStatus({ state: 'error', error: err.message });
    } finally {
        _syncing = false;
    }
}

// ─── Push helpers (shared workspace — no user_id filter) ─────

async function _pushBaseline(userId) {
    const raw = localStorage.getItem('whatif_baseline');
    if (!raw) return;

    const data = JSON.parse(raw);

    // Baseline is a singleton: check if one exists, then update or insert
    const { data: existing } = await supabase
        .from('baselines')
        .select('id')
        .limit(1)
        .maybeSingle();

    if (existing) {
        const { error } = await supabase
            .from('baselines')
            .update({ data: data, user_id: userId, updated_at: new Date().toISOString() })
            .eq('id', existing.id);
        if (error) throw new Error(`Push baseline failed: ${error.message}`);
    } else {
        const { error } = await supabase
            .from('baselines')
            .insert({ user_id: userId, data: data, updated_at: new Date().toISOString() });
        if (error) throw new Error(`Push baseline failed: ${error.message}`);
    }
}

async function _pushScenarios(userId) {
    const raw = localStorage.getItem('whatif_scenarios');
    if (!raw) return;

    let scenarios = JSON.parse(raw);
    if (!Array.isArray(scenarios) || scenarios.length === 0) return;

    // Tester can only push their own scenarios (RLS blocks updating others' rows)
    if (_userRole === 'tester') {
        scenarios = scenarios.filter(s => s.createdBy === _userEmail);
        if (scenarios.length === 0) return;
    }

    const rows = scenarios.map(s => ({
        user_id: userId,
        local_id: s.id,
        data: s,
        updated_at: s.updatedAt || new Date().toISOString(),
        deleted: false,
        draft: _userRole === 'tester' ? true : (s.draft || false),
        created_by_email: s.createdBy || _userEmail || ''
    }));

    const { error } = await supabase
        .from('scenarios')
        .upsert(rows, { onConflict: 'local_id' });

    if (error) throw new Error(`Push scenarios failed: ${error.message}`);

    // Soft-delete only explicitly deleted scenarios
    await _pushExplicitDeletions('scenarios', DELETED_SCENARIOS_KEY);
}

async function _pushPersone(userId) {
    const raw = localStorage.getItem('whatif_persone');
    if (!raw) return;

    const persone = JSON.parse(raw);
    if (!Array.isArray(persone) || persone.length === 0) return;

    const pushTime = new Date().toISOString();
    const rows = persone.map(p => ({
        user_id: userId,
        local_id: p.id,
        codice_fiscale: p.codiceFiscale || '',
        cognome: p.cognome || '',
        nome: p.nome || '',
        societa: p.societa || '',
        bu: p.bu || '',
        cdc: p.cdc || '',
        vdc: p.vdc || '',
        tdc: p.tdc || '',
        ruolo: p.ruolo || '',
        tipo_contratto: p.tipoContratto || 'DIPENDENTE',
        data_assunzione: p.dataAssunzione || '',
        data_termine: p.dataTermine || '',
        costo_medio_mese: p.costoMedioMese || 0,
        note: p.note || '',
        attivo: p.attivo !== false,
        stato_assunzione: p.statoAssunzione || 'assunta',
        created_at: p.createdAt || pushTime,
        updated_at: pushTime, // sempre timestamp fresco per garantire propagazione
        deleted: false
    }));

    for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const { error } = await supabase
            .from('persone')
            .upsert(batch, { onConflict: 'local_id' });
        if (error) throw new Error(`Push persone failed: ${error.message}`);
    }

    // Soft-delete only explicitly deleted persone
    await _pushExplicitDeletions('persone', DELETED_PERSONE_KEY);

    // Cloud-side dedup persone by codice_fiscale or cognome+nome
    await _dedupPersoneCloud();
}

async function _dedupPersoneCloud() {
    try {
        const { data, error } = await supabase
            .from('persone')
            .select('id, local_id, codice_fiscale, cognome, nome, updated_at')
            .eq('deleted', false)
            .order('updated_at', { ascending: false });

        if (error || !data) return;

        const seen = new Map();
        const toDelete = [];

        for (const row of data) {
            const cf = (row.codice_fiscale || '').toUpperCase().trim();
            const key = cf || `${(row.cognome || '').toUpperCase()}|${(row.nome || '').toLowerCase()}`;
            if (!key || key === '|') continue;

            if (seen.has(key)) {
                toDelete.push(row.id);
            } else {
                seen.set(key, row.id);
            }
        }

        if (toDelete.length === 0) return;
        console.info(`[SyncManager] Cloud dedup: marking ${toDelete.length} duplicate persone as deleted`);

        for (let i = 0; i < toDelete.length; i += 50) {
            const batch = toDelete.slice(i, i + 50);
            await supabase
                .from('persone')
                .update({ deleted: true, updated_at: new Date().toISOString() })
                .in('id', batch);
        }
    } catch (err) {
        console.warn('[SyncManager] Cloud dedup persone error:', err.message);
    }
}

async function _pushAllocazioni(userId) {
    const raw = localStorage.getItem('whatif_allocazioni');
    if (!raw) return;

    const allocazioni = JSON.parse(raw);
    if (!Array.isArray(allocazioni) || allocazioni.length === 0) return;

    const pushTime = new Date().toISOString();
    const rows = allocazioni.map(a => ({
        user_id: userId,
        local_id: a.id,
        persona_local_id: a.personaId || '',
        codice_commessa: a.codiceCommessa || '',
        scenario_local_id: a.scenarioId || null,
        percentuale: a.percentuale || 100,
        data_inizio: a.dataInizio || '',
        data_fine: a.dataFine || '',
        aggancio_inizio: a.aggancioInizio || false,
        aggancio_fine: a.aggancioFine || false,
        delta_inizio: a.deltaInizio || 0,
        delta_fine: a.deltaFine || 0,
        origine: a.origine || 'manuale',
        is_base: a.isBase || false,
        note: a.note || '',
        created_at: a.createdAt || pushTime,
        updated_at: pushTime, // sempre timestamp fresco per garantire propagazione
        deleted: false
    }));

    for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const { error } = await supabase
            .from('allocazioni')
            .upsert(batch, { onConflict: 'local_id' });
        if (error) throw new Error(`Push allocazioni failed: ${error.message}`);
    }

    // Soft-delete only explicitly deleted allocazioni
    await _pushExplicitDeletions('allocazioni', DELETED_ALLOCAZIONI_KEY);

    // Cloud-side dedup: remove duplicate allocazioni by content
    // Keeps the most recent row per group (persona+commessa+scenario+%+dates)
    await _dedupAllocazioniCloud();
}

/**
 * Cloud-side deduplication of allocazioni.
 * Groups by (persona_local_id, codice_commessa, scenario_local_id, percentuale, data_inizio, data_fine).
 * Within each group, marks all but the most recent (by updated_at) as deleted=true.
 * Runs as a single SQL query server-side — safe, idempotent, soft-delete only.
 */
async function _dedupAllocazioniCloud() {
    try {
        const { error } = await supabase.rpc('dedup_allocazioni');
        if (error) {
            // If RPC doesn't exist yet, use fallback approach
            if (error.message.includes('dedup_allocazioni')) {
                await _dedupAllocazioniCloudFallback();
            } else {
                console.warn('[SyncManager] Cloud dedup allocazioni failed:', error.message);
            }
        }
    } catch (err) {
        console.warn('[SyncManager] Cloud dedup allocazioni error:', err.message);
    }
}

/**
 * Fallback cloud dedup: fetch duplicates, then mark old ones as deleted.
 * Used when the RPC function doesn't exist on the database.
 */
async function _dedupAllocazioniCloudFallback() {
    try {
        // Step 1: find all duplicate groups
        const { data, error } = await supabase
            .from('allocazioni')
            .select('id, local_id, persona_local_id, codice_commessa, scenario_local_id, percentuale, data_inizio, data_fine, updated_at')
            .eq('deleted', false)
            .order('updated_at', { ascending: false });

        if (error || !data) return;

        // Step 2: group by content key, keep most recent
        const seen = new Map();
        const toDelete = [];

        for (const row of data) {
            const key = `${row.persona_local_id}|${row.codice_commessa}|${row.scenario_local_id}|${row.percentuale}|${row.data_inizio}|${row.data_fine}`;
            if (seen.has(key)) {
                // This row is older (data is ordered by updated_at DESC), mark for deletion
                toDelete.push(row.id);
            } else {
                seen.set(key, row.id);
            }
        }

        if (toDelete.length === 0) return;

        console.info(`[SyncManager] Cloud dedup: marking ${toDelete.length} duplicate allocazioni as deleted`);

        // Step 3: soft-delete in batches of 50
        for (let i = 0; i < toDelete.length; i += 50) {
            const batch = toDelete.slice(i, i + 50);
            const { error: delErr } = await supabase
                .from('allocazioni')
                .update({ deleted: true, updated_at: new Date().toISOString() })
                .in('id', batch);
            if (delErr) console.warn('[SyncManager] Cloud dedup batch error:', delErr.message);
        }
    } catch (err) {
        console.warn('[SyncManager] Cloud dedup fallback error:', err.message);
    }
}

async function _pushRuoli(userId) {
    const raw = localStorage.getItem('whatif_ruoli');
    if (!raw) return;

    const ruoli = JSON.parse(raw);
    if (!Array.isArray(ruoli) || ruoli.length === 0) return;

    const pushTime = new Date().toISOString();
    const rows = ruoli.map(r => ({
        user_id: userId,
        local_id: r.id,
        nome: r.nome || '',
        codice: r.codice || '',
        tipo: r.tipo || 'necessario',
        costo_medio: r.costoMedio || 0,
        updated_at: pushTime, // sempre timestamp fresco per garantire propagazione
        deleted: false
    }));

    const { error } = await supabase
        .from('ruoli')
        .upsert(rows, { onConflict: 'local_id' });

    if (error) throw new Error(`Push ruoli failed: ${error.message}`);

    // Soft-delete only explicitly deleted ruoli (by id AND by name to handle cloud duplicates)
    await _pushRuoliDeletions();

    // Cloud-side dedup ruoli by nome
    await _dedupRuoliCloud();
}

async function _dedupRuoliCloud() {
    try {
        const { data, error } = await supabase
            .from('ruoli')
            .select('id, local_id, nome, updated_at')
            .eq('deleted', false)
            .order('updated_at', { ascending: false });

        if (error || !data) return;

        const seen = new Map();
        const toDelete = [];

        for (const row of data) {
            const key = (row.nome || '').toLowerCase().trim();
            if (!key) continue;
            if (seen.has(key)) {
                toDelete.push(row.id);
            } else {
                seen.set(key, row.id);
            }
        }

        if (toDelete.length === 0) return;
        console.info(`[SyncManager] Cloud dedup: marking ${toDelete.length} duplicate ruoli as deleted`);

        for (let i = 0; i < toDelete.length; i += 50) {
            const batch = toDelete.slice(i, i + 50);
            await supabase
                .from('ruoli')
                .update({ deleted: true, updated_at: new Date().toISOString() })
                .in('id', batch);
        }
    } catch (err) {
        console.warn('[SyncManager] Cloud dedup ruoli error:', err.message);
    }
}

async function _pushRuoliDeletions() {
    const raw = localStorage.getItem(DELETED_RUOLI_KEY);
    if (!raw) return;

    let entries;
    try { entries = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(entries) || entries.length === 0) return;

    // Normalize entries (some may be plain strings from old version)
    const normalized = entries.map(e => typeof e === 'string' ? { id: e, nome: null } : e);
    const ids = normalized.map(e => e.id).filter(Boolean);
    const names = normalized.map(e => e.nome).filter(Boolean);

    const nowIso = new Date().toISOString();

    // 1. Delete by local_id
    if (ids.length > 0) {
        const { error } = await supabase
            .from('ruoli')
            .update({ deleted: true, updated_at: nowIso })
            .in('local_id', ids);
        if (error) {
            console.warn('[SyncManager] Push ruoli deletions by id failed:', error.message);
            return;
        }
    }

    // 2. Delete by nome (case-insensitive) — covers cloud duplicates with different local_id
    for (const nome of names) {
        const { error } = await supabase
            .from('ruoli')
            .update({ deleted: true, updated_at: nowIso })
            .ilike('nome', nome);
        if (error) {
            console.warn(`[SyncManager] Push ruoli deletion by name "${nome}" failed:`, error.message);
            return;
        }
    }

    localStorage.removeItem(DELETED_RUOLI_KEY);
}

async function _pushAudit(userId) {
    const raw = localStorage.getItem('whatif_audit');
    if (!raw) return;

    const audit = JSON.parse(raw);
    if (!Array.isArray(audit) || audit.length === 0) return;

    const rows = audit.map(a => ({
        user_id: userId,
        local_id: a.id || `audit_${a.timestamp}`,
        entita: a.entita || '',
        entita_id: a.entitaId || '',
        operazione: a.operazione || '',
        vecchio_valore: a.vecchioValore || null,
        nuovo_valore: a.nuovoValore || null,
        origine: a.origine || 'manuale',
        timestamp: a.timestamp || new Date().toISOString()
    }));

    for (let i = 0; i < rows.length; i += 100) {
        const batch = rows.slice(i, i + 100);
        const { error } = await supabase
            .from('audit_log')
            .upsert(batch, { onConflict: 'local_id', ignoreDuplicates: true });
        if (error) console.warn('[SyncManager] Push audit partial error:', error.message);
    }
}

async function _pushPreferences(userId) {
    const prefs = [
        { key: 'theme', value: localStorage.getItem('theme') },
        { key: 'appZoomLevel', value: localStorage.getItem('appZoomLevel') }
    ].filter(p => p.value != null);

    if (prefs.length === 0) return;

    const rows = prefs.map(p => ({
        user_id: userId,
        key: p.key,
        value: p.value,
        updated_at: new Date().toISOString()
    }));

    const { error } = await supabase
        .from('preferences')
        .upsert(rows, { onConflict: 'user_id,key' });

    if (error) console.warn('[SyncManager] Push preferences error:', error.message);
}

// ─── Pull helpers (shared — no user_id filter) ──────────────

async function _pullBaseline() {
    const { data, error } = await supabase
        .from('baselines')
        .select('data')
        .limit(1)
        .maybeSingle();

    if (error) throw new Error(`Pull baseline failed: ${error.message}`);
    if (data?.data) {
        localStorage.setItem('whatif_baseline', JSON.stringify(data.data));
    }
}

async function _pullScenarios() {
    const { data, error } = await supabase
        .from('scenarios')
        .select('local_id, data')
        .eq('deleted', false);

    if (error) throw new Error(`Pull scenarios failed: ${error.message}`);
    if (data && data.length > 0) {
        const scenarios = data.map(row => row.data);
        localStorage.setItem('whatif_scenarios', JSON.stringify(scenarios));
    }
}

async function _pullPersone() {
    const { data, error } = await supabase
        .from('persone')
        .select('*')
        .eq('deleted', false);

    if (error) throw new Error(`Pull persone failed: ${error.message}`);
    if (data && data.length > 0) {
        const persone = data.map(row => ({
            id: row.local_id,
            codiceFiscale: row.codice_fiscale,
            cognome: row.cognome,
            nome: row.nome,
            societa: row.societa,
            bu: row.bu,
            cdc: row.cdc,
            vdc: row.vdc,
            tdc: row.tdc,
            ruolo: row.ruolo,
            tipoContratto: row.tipo_contratto,
            dataAssunzione: row.data_assunzione,
            dataTermine: row.data_termine,
            costoMedioMese: Number(row.costo_medio_mese),
            note: row.note,
            attivo: row.attivo,
            statoAssunzione: row.stato_assunzione || 'assunta',
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
        localStorage.setItem('whatif_persone', JSON.stringify(persone));
    }
}

async function _pullAllocazioni() {
    const { data, error } = await supabase
        .from('allocazioni')
        .select('*')
        .eq('deleted', false);

    if (error) throw new Error(`Pull allocazioni failed: ${error.message}`);
    if (data && data.length > 0) {
        const allocazioni = data.map(row => ({
            id: row.local_id,
            personaId: row.persona_local_id,
            codiceCommessa: row.codice_commessa,
            scenarioId: row.scenario_local_id,
            percentuale: Number(row.percentuale),
            dataInizio: row.data_inizio,
            dataFine: row.data_fine,
            aggancioInizio: row.aggancio_inizio,
            aggancioFine: row.aggancio_fine,
            deltaInizio: row.delta_inizio,
            deltaFine: row.delta_fine,
            origine: row.origine,
            isBase: row.is_base,
            note: row.note,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
        localStorage.setItem('whatif_allocazioni', JSON.stringify(allocazioni));
    }
}

async function _pullAudit() {
    const { data, error } = await supabase
        .from('audit_log')
        .select('*')
        .order('timestamp', { ascending: false })
        .limit(1000);

    if (error) throw new Error(`Pull audit failed: ${error.message}`);
    if (data && data.length > 0) {
        const audit = data.map(row => ({
            id: row.local_id,
            entita: row.entita,
            entitaId: row.entita_id,
            operazione: row.operazione,
            vecchioValore: row.vecchio_valore,
            nuovoValore: row.nuovo_valore,
            origine: row.origine,
            timestamp: row.timestamp
        }));
        localStorage.setItem('whatif_audit', JSON.stringify(audit));
    }
}

async function _pullRuoli() {
    const { data, error } = await supabase
        .from('ruoli')
        .select('*')
        .eq('deleted', false);

    if (error) throw new Error(`Pull ruoli failed: ${error.message}`);
    if (data && data.length > 0) {
        const ruoli = data.map(row => ({
            id: row.local_id,
            nome: row.nome,
            codice: row.codice || '',
            tipo: row.tipo || 'necessario',
            costoMedio: Number(row.costo_medio),
            createdAt: row.updated_at,
            updatedAt: row.updated_at
        }));
        localStorage.setItem('whatif_ruoli', JSON.stringify(ruoli));
    }
}

async function _pullPreferences(userId) {
    // Preferences remain per-user
    const { data, error } = await supabase
        .from('preferences')
        .select('key, value')
        .eq('user_id', userId);

    if (error) return;
    if (data) {
        data.forEach(row => {
            if (row.value != null) {
                localStorage.setItem(row.key, row.value);
            }
        });
    }
}

// ─── Pull if newer (periodic sync — shared) ─────────────────

async function _pullIfNewer(since) {
    // Apply a 5-minute buffer to tolerate clock drift between clients
    // (timestamp on cloud is set by the pushing client's local clock)
    if (since && since !== '1970-01-01T00:00:00Z') {
        const buffered = new Date(new Date(since).getTime() - 5 * 60 * 1000).toISOString();
        since = buffered;
    }

    // Baseline
    const { data: bl } = await supabase
        .from('baselines')
        .select('data, updated_at')
        .gt('updated_at', since)
        .limit(1)
        .maybeSingle();

    if (bl?.data) {
        localStorage.setItem('whatif_baseline', JSON.stringify(bl.data));
    }

    // Scenarios
    const { data: sc } = await supabase
        .from('scenarios')
        .select('local_id, data, deleted')
        .gt('updated_at', since);

    if (sc && sc.length > 0) {
        const raw = localStorage.getItem('whatif_scenarios');
        let localScenarios = raw ? JSON.parse(raw) : [];

        for (const remote of sc) {
            if (remote.deleted) {
                localScenarios = localScenarios.filter(s => s.id !== remote.local_id);
            } else {
                const idx = localScenarios.findIndex(s => s.id === remote.local_id);
                if (idx >= 0) {
                    const localUpdated = localScenarios[idx].updatedAt || '';
                    const remoteUpdated = remote.data.updatedAt || '';
                    if (remoteUpdated > localUpdated) {
                        localScenarios[idx] = remote.data;
                    }
                } else {
                    localScenarios.push(remote.data);
                }
            }
        }
        localStorage.setItem('whatif_scenarios', JSON.stringify(localScenarios));
    }

    // Persone
    const { data: pe } = await supabase
        .from('persone')
        .select('*')
        .gt('updated_at', since);

    if (pe && pe.length > 0) {
        const raw = localStorage.getItem('whatif_persone');
        let localPersone = raw ? JSON.parse(raw) : [];

        for (const remote of pe) {
            if (remote.deleted) {
                localPersone = localPersone.filter(p => p.id !== remote.local_id);
            } else {
                const mapped = {
                    id: remote.local_id,
                    codiceFiscale: remote.codice_fiscale,
                    cognome: remote.cognome,
                    nome: remote.nome,
                    societa: remote.societa,
                    bu: remote.bu,
                    cdc: remote.cdc,
                    vdc: remote.vdc,
                    tdc: remote.tdc,
                    ruolo: remote.ruolo,
                    tipoContratto: remote.tipo_contratto,
                    dataAssunzione: remote.data_assunzione,
                    dataTermine: remote.data_termine,
                    costoMedioMese: Number(remote.costo_medio_mese),
                    note: remote.note,
                    attivo: remote.attivo,
                    statoAssunzione: remote.stato_assunzione || 'assunta',
                    createdAt: remote.created_at,
                    updatedAt: remote.updated_at
                };
                const idx = localPersone.findIndex(p => p.id === remote.local_id);
                if (idx >= 0) {
                    if ((remote.updated_at || '') > (localPersone[idx].updatedAt || '')) {
                        localPersone[idx] = mapped;
                    }
                } else {
                    // Dedup: check if same person exists locally with a different ID
                    // Match by codice fiscale (primary) or cognome+nome (fallback)
                    const cf = (mapped.codiceFiscale || '').toUpperCase().trim();
                    const dupIdx = cf
                        ? localPersone.findIndex(p => p.id !== mapped.id && (p.codiceFiscale || '').toUpperCase().trim() === cf && cf !== '')
                        : localPersone.findIndex(p => p.id !== mapped.id &&
                            (p.cognome || '').toUpperCase() === (mapped.cognome || '').toUpperCase() &&
                            (p.nome || '').toLowerCase() === (mapped.nome || '').toLowerCase() &&
                            (mapped.cognome || '') !== '');

                    if (dupIdx >= 0) {
                        const oldLocalId = localPersone[dupIdx].id;
                        console.info(`[SyncManager] Persona dedup: merging local ${oldLocalId} → remote ${mapped.id} (${mapped.cognome} ${mapped.nome})`);
                        localPersone[dupIdx] = mapped;

                        // Remap allocazioni that referenced the old local ID
                        try {
                            const allocRaw = localStorage.getItem('whatif_allocazioni');
                            if (allocRaw) {
                                const allocs = JSON.parse(allocRaw);
                                let remapped = 0;
                                for (const a of allocs) {
                                    if (a.personaId === oldLocalId) {
                                        a.personaId = mapped.id;
                                        remapped++;
                                    }
                                }
                                if (remapped > 0) {
                                    console.info(`[SyncManager] Remapped ${remapped} allocazioni from ${oldLocalId} → ${mapped.id}`);
                                    localStorage.setItem('whatif_allocazioni', JSON.stringify(allocs));
                                }
                            }
                        } catch (e) { console.warn('[SyncManager] Remap allocazioni error:', e); }
                    } else {
                        localPersone.push(mapped);
                    }
                }
            }
        }
        localStorage.setItem('whatif_persone', JSON.stringify(localPersone));
    }

    // Allocazioni
    const { data: al } = await supabase
        .from('allocazioni')
        .select('*')
        .gt('updated_at', since);

    if (al && al.length > 0) {
        const raw = localStorage.getItem('whatif_allocazioni');
        let localAlloc = raw ? JSON.parse(raw) : [];

        for (const remote of al) {
            if (remote.deleted) {
                localAlloc = localAlloc.filter(a => a.id !== remote.local_id);
            } else {
                const mapped = {
                    id: remote.local_id,
                    personaId: remote.persona_local_id,
                    codiceCommessa: remote.codice_commessa,
                    scenarioId: remote.scenario_local_id,
                    percentuale: Number(remote.percentuale),
                    dataInizio: remote.data_inizio,
                    dataFine: remote.data_fine,
                    aggancioInizio: remote.aggancio_inizio,
                    aggancioFine: remote.aggancio_fine,
                    deltaInizio: remote.delta_inizio,
                    deltaFine: remote.delta_fine,
                    origine: remote.origine,
                    isBase: remote.is_base,
                    note: remote.note,
                    createdAt: remote.created_at,
                    updatedAt: remote.updated_at
                };
                const idx = localAlloc.findIndex(a => a.id === remote.local_id);
                if (idx >= 0) {
                    if ((remote.updated_at || '') > (localAlloc[idx].updatedAt || '')) {
                        localAlloc[idx] = mapped;
                    }
                } else {
                    // Dedup: check if an allocation with same content already exists locally
                    // (different local_id but same persona+commessa+scenario+period+percentage)
                    const dupIdx = localAlloc.findIndex(a =>
                        a.id !== mapped.id &&
                        a.personaId === mapped.personaId &&
                        a.codiceCommessa === mapped.codiceCommessa &&
                        a.scenarioId === mapped.scenarioId &&
                        a.dataInizio === mapped.dataInizio &&
                        a.dataFine === mapped.dataFine &&
                        a.percentuale === mapped.percentuale
                    );
                    if (dupIdx >= 0) {
                        // Replace the old local copy with the remote version (keeps remote id as canonical)
                        console.info(`[SyncManager] Dedup allocazione: replacing local ${localAlloc[dupIdx].id} with remote ${mapped.id}`);
                        localAlloc[dupIdx] = mapped;
                    } else {
                        localAlloc.push(mapped);
                    }
                }
            }
        }
        localStorage.setItem('whatif_allocazioni', JSON.stringify(localAlloc));
    }

    // Ruoli
    const { data: ru } = await supabase
        .from('ruoli')
        .select('*')
        .gt('updated_at', since);

    if (ru && ru.length > 0) {
        const raw = localStorage.getItem('whatif_ruoli');
        let localRuoli = raw ? JSON.parse(raw) : [];

        for (const remote of ru) {
            if (remote.deleted) {
                localRuoli = localRuoli.filter(r => r.id !== remote.local_id);
            } else {
                const mapped = {
                    id: remote.local_id,
                    nome: remote.nome,
                    codice: remote.codice || '',
                    tipo: remote.tipo || 'necessario',
                    costoMedio: Number(remote.costo_medio),
                    createdAt: remote.updated_at,
                    updatedAt: remote.updated_at
                };
                const idx = localRuoli.findIndex(r => r.id === remote.local_id);
                if (idx >= 0) {
                    if ((remote.updated_at || '') > (localRuoli[idx].updatedAt || '')) {
                        localRuoli[idx] = mapped;
                    }
                } else {
                    // Dedup: check if a role with the same name already exists locally
                    const dupIdx = localRuoli.findIndex(r =>
                        r.id !== mapped.id &&
                        r.nome && mapped.nome &&
                        r.nome.toLowerCase() === mapped.nome.toLowerCase()
                    );
                    if (dupIdx >= 0) {
                        console.info(`[SyncManager] Ruolo dedup: merging local ${localRuoli[dupIdx].id} → remote ${mapped.id} (${mapped.nome})`);
                        localRuoli[dupIdx] = mapped;
                    } else {
                        localRuoli.push(mapped);
                    }
                }
            }
        }
        localStorage.setItem('whatif_ruoli', JSON.stringify(localRuoli));
    }
}

// ─── Deduplication (safety net) ─────────────────────────────

/**
 * Remove duplicate allocazioni from localStorage.
 * Two allocations are considered duplicates if they share the same
 * personaId + codiceCommessa + scenarioId + dataInizio + dataFine + percentuale.
 * Keeps the one with the most recent updatedAt (i.e. the remote/canonical version).
 */
function _deduplicateAllocazioni() {
    const raw = localStorage.getItem('whatif_allocazioni');
    if (!raw) return;

    let alloc;
    try { alloc = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(alloc) || alloc.length === 0) return;

    const seen = new Map(); // key → index of best entry
    const toRemove = new Set();

    for (let i = 0; i < alloc.length; i++) {
        const a = alloc[i];
        const key = `${a.personaId}|${a.codiceCommessa}|${a.scenarioId}|${a.dataInizio}|${a.dataFine}|${a.percentuale}`;
        if (seen.has(key)) {
            const prevIdx = seen.get(key);
            const prev = alloc[prevIdx];
            // Keep the one with more recent updatedAt
            if ((a.updatedAt || '') > (prev.updatedAt || '')) {
                toRemove.add(prevIdx);
                seen.set(key, i);
            } else {
                toRemove.add(i);
            }
        } else {
            seen.set(key, i);
        }
    }

    if (toRemove.size > 0) {
        console.warn(`[SyncManager] Dedup: removing ${toRemove.size} duplicate allocazioni`);
        const cleaned = alloc.filter((_, i) => !toRemove.has(i));
        localStorage.setItem('whatif_allocazioni', JSON.stringify(cleaned));
    }
}

/**
 * Remove duplicate persone from localStorage and remap orphaned allocazioni.
 * Two persone are duplicates if they share the same codice fiscale (if present)
 * or same cognome+nome. Keeps the one with the most recent updatedAt.
 */
function _deduplicatePersone() {
    const raw = localStorage.getItem('whatif_persone');
    if (!raw) return;

    let persone;
    try { persone = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(persone) || persone.length === 0) return;

    const seen = new Map();
    const idRemap = new Map(); // oldId → survivorId
    const toRemove = new Set();

    for (let i = 0; i < persone.length; i++) {
        const p = persone[i];
        const cf = (p.codiceFiscale || '').toUpperCase().trim();
        const key = cf || `${(p.cognome || '').toUpperCase()}|${(p.nome || '').toLowerCase()}`;
        if (!key || key === '|') continue;

        if (seen.has(key)) {
            const prevIdx = seen.get(key);
            const prev = persone[prevIdx];
            if ((p.updatedAt || '') > (prev.updatedAt || '')) {
                toRemove.add(prevIdx);
                idRemap.set(prev.id, p.id);
                seen.set(key, i);
            } else {
                toRemove.add(i);
                idRemap.set(p.id, prev.id);
            }
        } else {
            seen.set(key, i);
        }
    }

    if (toRemove.size > 0) {
        console.warn(`[SyncManager] Dedup: removing ${toRemove.size} duplicate persone`);
        const cleaned = persone.filter((_, i) => !toRemove.has(i));
        localStorage.setItem('whatif_persone', JSON.stringify(cleaned));

        // Remap allocazioni referencing removed persone IDs
        try {
            const allocRaw = localStorage.getItem('whatif_allocazioni');
            if (allocRaw) {
                const allocs = JSON.parse(allocRaw);
                let remapped = 0;
                for (const a of allocs) {
                    const newId = idRemap.get(a.personaId);
                    if (newId) { a.personaId = newId; remapped++; }
                }
                if (remapped > 0) {
                    console.info(`[SyncManager] Remapped ${remapped} allocazioni after persona dedup`);
                    localStorage.setItem('whatif_allocazioni', JSON.stringify(allocs));
                }
            }
        } catch (e) { console.warn('[SyncManager] Remap after persona dedup error:', e); }
    }
}

/**
 * Remove duplicate ruoli from localStorage.
 * Two ruoli are duplicates if they share the same nome (case-insensitive).
 * Keeps the one with the most recent updatedAt.
 */
function _deduplicateRuoli() {
    const raw = localStorage.getItem('whatif_ruoli');
    if (!raw) return;

    let ruoli;
    try { ruoli = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(ruoli) || ruoli.length === 0) return;

    const seen = new Map();
    const toRemove = new Set();

    for (let i = 0; i < ruoli.length; i++) {
        const r = ruoli[i];
        const key = (r.nome || '').toLowerCase().trim();
        if (!key) continue;

        if (seen.has(key)) {
            const prevIdx = seen.get(key);
            const prev = ruoli[prevIdx];
            if ((r.updatedAt || '') > (prev.updatedAt || '')) {
                toRemove.add(prevIdx);
                seen.set(key, i);
            } else {
                toRemove.add(i);
            }
        } else {
            seen.set(key, i);
        }
    }

    if (toRemove.size > 0) {
        console.warn(`[SyncManager] Dedup: removing ${toRemove.size} duplicate ruoli`);
        const cleaned = ruoli.filter((_, i) => !toRemove.has(i));
        localStorage.setItem('whatif_ruoli', JSON.stringify(cleaned));
    }
}

/**
 * Direct push without conflict detection. Used by _triggerRealtimeSync
 * to ensure local data reaches the cloud BEFORE fullPull replaces localStorage.
 */
async function _pushEntityDirect(localStorageKey, userId) {
    if (_pushBlocked) return;
    if (!canWrite(localStorageKey) || !navigator.onLine) return;
    switch (localStorageKey) {
        case 'whatif_baseline': await _pushBaseline(userId); break;
        case 'whatif_scenarios': await _pushScenarios(userId); break;
        case 'whatif_persone': await _pushPersone(userId); break;
        case 'whatif_allocazioni': await _pushAllocazioni(userId); break;
        case 'whatif_audit': await _pushAudit(userId); break;
        case 'whatif_ruoli': await _pushRuoli(userId); break;
    }
}

// ─── Explicit deletion push (shared-safe) ──────────────────

async function _pushExplicitDeletions(table, deletedKey) {
    const raw = localStorage.getItem(deletedKey);
    if (!raw) return;

    const deletedIds = JSON.parse(raw);
    if (!Array.isArray(deletedIds) || deletedIds.length === 0) return;

    const { error } = await supabase
        .from(table)
        .update({ deleted: true, updated_at: new Date().toISOString() })
        .in('local_id', deletedIds);

    if (error) {
        console.warn(`[SyncManager] Push deletions for ${table} failed:`, error.message);
        return; // Keep the list for retry
    }

    // Clear the deletion tracking list after successful push
    localStorage.removeItem(deletedKey);
}

// ─── Generic push entity (for polling) ──────────────────────

async function _pushEntity(localStorageKey, userId) {
    // Version gate: block push if app is too old
    if (_pushBlocked) return;

    // Role-based gating: check per-entity permissions
    if (!canWrite(localStorageKey)) return;

    if (!navigator.onLine) {
        _queueOffline({ op: 'push', key: localStorageKey, timestamp: new Date().toISOString() });
        return;
    }

    try {
        // Conflict detection: check if remote data changed since our last sync
        const conflict = await _detectConflict(localStorageKey);
        if (conflict) {
            console.warn(`[SyncManager] Conflict detected on ${localStorageKey} — pulling remote first`);
            _setStatus({ state: 'connected', conflict: localStorageKey });
            // Pull remote changes first, then re-push
            const lastSync = localStorage.getItem(LAST_SYNC_KEY) || '1970-01-01T00:00:00Z';
            await _pullIfNewer(lastSync);
            _deduplicatePersone();
            _deduplicateAllocazioni();
            _deduplicateRuoli();
        }

        switch (localStorageKey) {
            case 'whatif_baseline': await _pushBaseline(userId); break;
            case 'whatif_scenarios': await _pushScenarios(userId); break;
            case 'whatif_persone': await _pushPersone(userId); break;
            case 'whatif_allocazioni': await _pushAllocazioni(userId); break;
            case 'whatif_audit': await _pushAudit(userId); break;
            case 'whatif_ruoli': await _pushRuoli(userId); break;
        }
        const serverNow = await _getServerTime();
        _setStatus({ state: 'connected', lastSync: serverNow, error: null, conflict: null });
        localStorage.setItem(LAST_SYNC_KEY, serverNow);
    } catch (err) {
        console.error(`[SyncManager] Push ${localStorageKey} failed:`, err);
        _queueOffline({ op: 'push', key: localStorageKey, timestamp: new Date().toISOString() });
        _setStatus({ state: 'error', error: err.message });
    }
}

/**
 * Conflict detection: check if the remote table has rows updated
 * after our last sync timestamp by a different user.
 */
async function _detectConflict(localStorageKey) {
    const lastSync = localStorage.getItem(LAST_SYNC_KEY);
    if (!lastSync) return false;

    const tableMap = {
        'whatif_baseline': 'baseline',
        'whatif_scenarios': 'scenarios',
        'whatif_persone': 'persone',
        'whatif_allocazioni': 'allocazioni',
        'whatif_ruoli': 'ruoli',
    };
    const table = tableMap[localStorageKey];
    if (!table) return false;

    try {
        const { count, error } = await supabase
            .from(table)
            .select('*', { count: 'exact', head: true })
            .gt('updated_at', lastSync)
            .neq('user_id', _userId || '');

        if (error) return false;
        return (count || 0) > 0;
    } catch {
        return false;
    }
}

// ─── Polling ─────────────────────────────────────────────────

function _snapshotHashes() {
    for (const key of SYNC_KEYS) {
        _hashes[key] = _hashString(localStorage.getItem(key) || '');
    }
}

function _startPolling(userId) {
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(() => {
        if (_syncing || !navigator.onLine) return;

        for (const key of SYNC_KEYS) {
            const current = _hashString(localStorage.getItem(key) || '');
            if (current !== _hashes[key]) {
                _hashes[key] = current;
                _pushEntity(key, userId);
            }
        }
    }, POLL_INTERVAL_MS);
}

function _startPeriodicSync(userId) {
    if (_periodicTimer) clearInterval(_periodicTimer);
    _periodicTimer = setInterval(() => {
        if (!navigator.onLine) return;
        incrementalSync(userId).catch(err => {
            console.warn('[SyncManager] Periodic sync failed:', err);
        });
    }, PERIODIC_SYNC_MS);
}

// ─── Supabase Realtime ──────────────────────────────────────

const REALTIME_TABLES = ['baseline', 'scenarios', 'persone', 'allocazioni', 'ruoli'];
let _realtimeDebounce = null;
let _realtimePending = false; // tracks if a sync should run after current one finishes

function _startRealtime(userId) {
    if (_realtimeChannel) {
        supabase.removeChannel(_realtimeChannel);
        _realtimeChannel = null;
    }

    try {
        _realtimeChannel = supabase.channel('sync-changes');

        for (const table of REALTIME_TABLES) {
            _realtimeChannel.on(
                'postgres_changes',
                { event: '*', schema: 'public', table },
                (payload) => {
                    // Ignore changes made by this user (already in localStorage)
                    if (payload.new?.user_id === userId) return;

                    console.info(`[Realtime] Change on ${table} by another user`);

                    // Debounce: multiple changes often arrive in rapid succession
                    if (_realtimeDebounce) clearTimeout(_realtimeDebounce);
                    _realtimeDebounce = setTimeout(() => {
                        _realtimeDebounce = null;
                        _triggerRealtimeSync(userId);
                    }, 800); // wait 0.8s to batch rapid changes
                }
            );
        }

        _realtimeChannel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.info('[Realtime] Connected — listening for remote changes');
            } else if (status === 'CHANNEL_ERROR') {
                console.warn('[Realtime] Channel error — falling back to polling');
            }
        });
    } catch (err) {
        console.warn('[Realtime] Failed to start — falling back to polling:', err.message);
    }
}

/**
 * Triggered by Realtime events. Uses fullPull instead of incrementalSync
 * to bypass timestamp-based filtering issues. Handles concurrent calls
 * by queuing a follow-up sync if one is already running.
 */
async function _triggerRealtimeSync(userId) {
    if (_syncing) {
        // A sync is already running. Mark that we need another one after.
        _realtimePending = true;
        return;
    }

    _syncing = true;
    try {
        // STEP 1: Push local data to cloud FIRST (protect unpushed changes)
        for (const key of SYNC_KEYS) {
            if (!canWrite(key)) continue;
            try {
                await _pushEntityDirect(key, userId);
            } catch (e) {
                console.warn(`[Realtime] Pre-pull push ${key} failed (non-blocking):`, e.message);
            }
        }

        // Snapshot before pull
        const hashesBefore = {};
        for (const key of SYNC_KEYS) {
            hashesBefore[key] = _hashString(localStorage.getItem(key) || '');
        }

        // STEP 2: fullPull (no timestamp filtering) for max reliability
        await _pullBaseline();
        await _pullScenarios();
        await _pullPersone();
        await _pullAllocazioni();
        _deduplicatePersone();
        _deduplicateAllocazioni();
        await _pullRuoli();
        _deduplicateRuoli();

        // Detect data change for UI refresh
        let dataChanged = false;
        const changedKeys = [];
        for (const key of SYNC_KEYS) {
            const newHash = _hashString(localStorage.getItem(key) || '');
            if (newHash !== hashesBefore[key]) {
                _hashes[key] = newHash;
                dataChanged = true;
                changedKeys.push(key);
            }
        }

        const serverNow = await _getServerTime();
        localStorage.setItem(LAST_SYNC_KEY, serverNow);
        _setStatus({ state: 'connected', lastSync: serverNow, error: null, dataChanged, changedKeys });
    } catch (err) {
        console.warn('[Realtime] Sync failed:', err);
    } finally {
        _syncing = false;
        // If another sync was requested while we were running, trigger it now
        if (_realtimePending) {
            _realtimePending = false;
            setTimeout(() => _triggerRealtimeSync(userId), 100);
        }
    }
}

// ─── Presence ───────────────────────────────────────────────

function _notifyPresenceListeners() {
    _presenceListeners.forEach(l => l([..._onlineUsers]));
}

function _startPresence(userId) {
    if (_presenceChannel) {
        supabase.removeChannel(_presenceChannel);
        _presenceChannel = null;
    }

    try {
        _presenceChannel = supabase.channel('online-users', {
            config: { presence: { key: userId } }
        });

        _presenceChannel.on('presence', { event: 'sync' }, () => {
            const state = _presenceChannel.presenceState();
            const users = [];
            for (const [, presences] of Object.entries(state)) {
                for (const p of presences) {
                    // Don't include self
                    if (p.user_id === userId) continue;
                    users.push({
                        email: p.email || '?',
                        role: p.role || 'viewer',
                        joinedAt: p.joined_at || '',
                    });
                }
            }
            _onlineUsers = users;
            _notifyPresenceListeners();
        });

        _presenceChannel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                await _presenceChannel.track({
                    user_id: userId,
                    email: _userEmail,
                    role: _userRole,
                    joined_at: new Date().toISOString(),
                });
                console.info('[Presence] Tracking started');
            }
        });
    } catch (err) {
        console.warn('[Presence] Failed to start:', err.message);
    }
}

// ─── Offline queue ───────────────────────────────────────────

function _queueOffline(operation) {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    queue.push(operation);
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    _setStatus({ pending: queue.length });
}

async function _flushQueue(userId) {
    const queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    if (queue.length === 0) return;

    _setStatus({ state: 'syncing' });
    const failed = [];

    for (const op of queue) {
        let retries = 0;
        let success = false;

        while (retries < MAX_RETRY && !success) {
            try {
                if (op.op === 'push') {
                    await _pushEntity(op.key, userId);
                }
                success = true;
            } catch {
                retries++;
                if (retries < MAX_RETRY) {
                    await new Promise(r => setTimeout(r, 1000 * retries));
                }
            }
        }

        if (!success) failed.push(op);
    }

    localStorage.setItem(QUEUE_KEY, JSON.stringify(failed));
    _setStatus({
        state: failed.length > 0 ? 'error' : 'connected',
        pending: failed.length,
        error: failed.length > 0 ? `${failed.length} operazioni fallite` : null,
        lastSync: new Date().toISOString()
    });
}

// ─── Server time ────────────────────────────────────────────

async function _getServerTime() {
    try {
        const { data, error } = await supabase.rpc('get_server_time');
        if (!error && data) return data;
    } catch { /* fallback */ }
    // Fallback: local time minus 5 seconds safety margin to avoid clock skew
    return new Date(Date.now() - 5000).toISOString();
}

// ─── Utilities ───────────────────────────────────────────────

function _hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xFFFFFFFF;
    }
    return hash.toString(36);
}

async function _cloudHasData() {
    const { data } = await supabase
        .from('baselines')
        .select('id')
        .limit(1)
        .maybeSingle();

    if (data) return true;

    const { count } = await supabase
        .from('scenarios')
        .select('id', { count: 'exact', head: true })
        .eq('deleted', false);

    return (count || 0) > 0;
}

function _localHasData() {
    return !!(localStorage.getItem('whatif_baseline') || localStorage.getItem('whatif_scenarios'));
}

// ─── Admin functions (Gestione Scenari) ─────────────────────

/**
 * Fetch all scenarios from cloud (admin sees drafts via RLS).
 */
export async function fetchAllScenariosFromCloud() {
    const { data, error } = await supabase
        .from('scenarios')
        .select('local_id, data, draft, deleted, updated_at, user_id, created_by_email')
        .order('updated_at', { ascending: false });
    if (error) throw new Error(`Fetch all scenarios failed: ${error.message}`);
    return data || [];
}

/**
 * Approve or un-approve a draft scenario (admin only).
 */
export async function pushScenarioApproval(localId, draftValue) {
    const { error } = await supabase
        .from('scenarios')
        .update({ draft: draftValue, updated_at: new Date().toISOString() })
        .eq('local_id', localId);
    if (error) throw new Error(`Approve scenario failed: ${error.message}`);
}

/**
 * Soft-delete a scenario from cloud (admin only).
 */
export async function pushScenarioDelete(localId) {
    const { error } = await supabase
        .from('scenarios')
        .update({ deleted: true, updated_at: new Date().toISOString() })
        .eq('local_id', localId);
    if (error) throw new Error(`Delete scenario failed: ${error.message}`);
}

/**
 * Restore a soft-deleted scenario in cloud (admin only).
 */
export async function pushScenarioRestore(localId) {
    const { error } = await supabase
        .from('scenarios')
        .update({ deleted: false, updated_at: new Date().toISOString() })
        .eq('local_id', localId);
    if (error) throw new Error(`Restore scenario failed: ${error.message}`);
}

/**
 * Push a single scenario's data to cloud (e.g. after lock/unlock).
 */
export async function pushSingleScenario(localId, scenarioData) {
    const session = await getSession();
    if (!session) return;
    const { error } = await supabase
        .from('scenarios')
        .update({ data: scenarioData, updated_at: new Date().toISOString() })
        .eq('local_id', localId);
    if (error) throw new Error(`Push scenario update failed: ${error.message}`);
}

function _backupLocal() {
    const backup = {};
    for (const key of SYNC_KEYS) {
        const val = localStorage.getItem(key);
        if (val) backup[key] = val;
    }
    if (Object.keys(backup).length > 0) {
        localStorage.setItem('whatif_pre_sync_backup', JSON.stringify(backup));
    }
}
