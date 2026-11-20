/**
 * commessePaese.js — Paese di ciascuna commessa (Italia / Francia / Altro).
 *
 * Perche' non sta nella baseline. La baseline viene ricostruita dal file Excel
 * AOP a ogni caricamento, e quel file vive fuori di qui: un AOP rigenerato
 * senza il paese lo cancellerebbe per tutte le commesse senza che nulla lo
 * segnali — lo stesso motivo per cui esiste commesseRinominate.js. La mappa
 * sta quindi in app_config, come l'ordine degli scenari e lo storico delle
 * rinomine: fuori dalla baseline, quindi un ricarico non la tocca, e condivisa
 * con tutti. In lettura entrano tutti, in scrittura solo l'admin: lo dicono le
 * policy della tabella, non questo file.
 *
 * La chiave e' il CODICE della commessa, non "codice|||nome": il nome nel file
 * cambia senza che la commessa sia un'altra. Quando cambia il codice ci pensa
 * rinominaPaese(), chiamata dalla rinomina insieme a tutto il resto.
 *
 * Tre valori e non due. Rovigno e Umago sono in Croazia: con un interruttore
 * Italia/Francia finirebbero dalla parte sbagliata, e un totale sbagliato non
 * si vede guardandolo.
 */

import { safeSetItem } from './storage.js';
import { supabase } from './supabaseClient.js';

const STORAGE_KEY = 'whatif_commesse_paese';
const APP_CONFIG_KEY = 'commesse_paese';

export const PAESI = ['Italia', 'Francia', 'Altro'];

/** Mappa { codice: paese } presa dal deposito locale. Sempre un oggetto. */
export function listaPaesi() {
    try {
        const o = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
    } catch {
        return {};
    }
}

function _salva(mappa) {
    safeSetItem(STORAGE_KEY, JSON.stringify(mappa));
    try {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('whatif:commessePaeseChanged'));
        }
    } catch { /* ignore */ }
}

/** Solo le voci con un paese riconosciuto: il resto si butta. */
function _ripulisci(mappa) {
    const pulita = {};
    for (const [k, v] of Object.entries(mappa || {})) {
        const c = String(k || '').trim();
        if (c && PAESI.includes(v)) pulita[c] = v;
    }
    return pulita;
}

/** Paese di una commessa, '' se non assegnato. */
export function getPaese(codice) {
    if (!codice) return '';
    const p = listaPaesi()[String(codice).trim()];
    return PAESI.includes(p) ? p : '';
}

/** Imposta il paese, oppure lo toglie passando ''. */
export function setPaese(codice, paese) {
    const c = String(codice || '').trim();
    if (!c) return listaPaesi();
    const mappa = listaPaesi();
    if (PAESI.includes(paese)) mappa[c] = paese;
    else delete mappa[c];
    _salva(mappa);
    return mappa;
}

/** Sostituisce l'intera mappa (tabella admin). */
export function setMappa(mappa) {
    const pulita = _ripulisci(mappa);
    _salva(pulita);
    return pulita;
}

/**
 * Il codice cambia (rinomina admin): il paese lo segue. Senza questo la
 * commessa rinominata resterebbe senza paese e uscirebbe dal filtro, che e'
 * peggio di un filtro assente perche' non si vede.
 */
export function rinominaPaese(oldCodice, newCodice) {
    const vecchio = String(oldCodice || '').trim();
    const nuovo = String(newCodice || '').trim();
    if (!vecchio || !nuovo || vecchio === nuovo) return listaPaesi();
    const mappa = listaPaesi();
    if (!(vecchio in mappa)) return mappa;
    mappa[nuovo] = mappa[vecchio];
    delete mappa[vecchio];
    _salva(mappa);
    return mappa;
}

/** Codici senza paese fra quelli passati: vanno mostrati, non nascosti. */
export function codiciDaAssegnare(commesse) {
    const mappa = listaPaesi();
    return (commesse || [])
        .map(c => String((c && c.codice) || '').trim())
        .filter(c => c && !PAESI.includes(mappa[c]));
}

// ─────────────────────────────────────────────────────
// Sincronizzazione cloud (best effort, non deve mai bloccare)
// ─────────────────────────────────────────────────────

/**
 * Il cloud vince. La mappa ha un solo scrittore — l'admin — e la tabella
 * la lascia modificare solo a lui: una copia locale diversa e' roba vecchia,
 * non una modifica da conservare. Stesso comportamento dell'ordine scenari.
 */
export async function pullPaesiFromCloud() {
    try {
        const { data, error } = await supabase
            .from('app_config')
            .select('value')
            .eq('key', APP_CONFIG_KEY)
            .maybeSingle();
        if (error || !data) return;
        const obj = JSON.parse(data.value);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        const cloud = _ripulisci(obj);
        if (JSON.stringify(cloud) !== JSON.stringify(listaPaesi())) {
            _salva(cloud);
        }
    } catch (err) {
        console.warn('[commessePaese] pull non riuscito:', err.message);
    }
}

/** Push della mappa corrente (solo admin: la policy rifiuta gli altri). */
export async function pushPaesiToCloud() {
    try {
        const { error } = await supabase
            .from('app_config')
            .upsert({
                key: APP_CONFIG_KEY,
                value: JSON.stringify(listaPaesi()),
                updated_at: new Date().toISOString(),
            }, { onConflict: 'key' });
        if (error) throw error;
        return { ok: true };
    } catch (err) {
        console.warn('[commessePaese] push non riuscito:', err.message);
        return { ok: false, errore: err.message };
    }
}
