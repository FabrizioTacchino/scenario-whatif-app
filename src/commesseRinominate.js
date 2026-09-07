/**
 * commesseRinominate.js — Storico delle rinomine di codice commessa.
 *
 * A cosa serve. Quando si cambia il codice di una commessa, l'app viene
 * allineata ovunque — baseline, scenari, allocazioni. Il file Excel AOP da cui
 * la baseline è nata, però, continua a riportare il codice vecchio: è un file
 * che vive fuori di qui. Ricaricando quel file, il codice vecchio rientrerebbe
 * come commessa nuova e quella rinominata resterebbe senza dati, senza che
 * nulla lo segnali.
 *
 * Questo registro esiste per riconoscere quel caso e fermarsi. Non impedisce
 * di caricare un file: chiede.
 *
 * Sincronizzato via app_config come l'ordine degli scenari, così l'avviso
 * raggiunge anche i colleghi e non solo chi ha eseguito la rinomina.
 */

import { safeSetItem } from './storage.js';
import { supabase } from './supabaseClient.js';

const STORAGE_KEY = 'whatif_commesse_rinominate';
const APP_CONFIG_KEY = 'commesse_rinominate';
const MAX_VOCI = 200;

export function listaRinomine() {
    try {
        const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(arr) ? arr : [];
    } catch {
        return [];
    }
}

/** Aggiunge una rinomina allo storico. Restituisce l'elenco aggiornato. */
export function registraRinomina({ oldCodice, oldNome, newCodice, newNome, chi }) {
    if (!oldCodice || !newCodice) return listaRinomine();
    const voci = listaRinomine();
    voci.push({
        oldCodice, oldNome: oldNome || '',
        newCodice, newNome: newNome || '',
        quando: new Date().toISOString(),
        chi: chi || '',
    });
    if (voci.length > MAX_VOCI) voci.splice(0, voci.length - MAX_VOCI);
    safeSetItem(STORAGE_KEY, JSON.stringify(voci));
    return voci;
}

/**
 * Data una lista di commesse appena lette da un file, restituisce quelle il cui
 * codice risulta rinominato in passato.
 *
 * Il confronto è sul solo codice: il nome può essere stato ritoccato nel file
 * senza che questo tolga valore all'avviso — anzi, un nome diverso rende ancora
 * più probabile che si tratti di una svista.
 */
export function rilevaCodiciSuperati(commesse) {
    const voci = listaRinomine();
    if (!voci.length || !Array.isArray(commesse)) return [];

    // L'ultima rinomina per ciascun codice di partenza è quella che vale
    const perVecchio = new Map();
    for (const v of voci) perVecchio.set(v.oldCodice, v);

    // Una rinomina "a catena" (A→B, poi B→C) non deve segnalare B se B è ormai
    // il codice di arrivo di nessuno: si segue la catena fino in fondo.
    const risolvi = (codice) => {
        const visti = new Set();
        let corrente = codice;
        while (perVecchio.has(corrente) && !visti.has(corrente)) {
            visti.add(corrente);
            corrente = perVecchio.get(corrente).newCodice;
        }
        return corrente;
    };

    const trovate = [];
    for (const c of commesse) {
        if (!perVecchio.has(c.codice)) continue;
        const finale = risolvi(c.codice);
        if (finale === c.codice) continue;
        const voce = perVecchio.get(c.codice);
        trovate.push({
            codiceNelFile: c.codice,
            nomeNelFile: c.nome,
            codiceAttuale: finale,
            nomeAttuale: voce.newNome,
            quando: voce.quando,
            chi: voce.chi,
        });
    }
    return trovate;
}

// ─────────────────────────────────────────────────────
// Sincronizzazione cloud (best effort, non deve mai bloccare)
// ─────────────────────────────────────────────────────

export async function pullRinomineFromCloud() {
    try {
        const { data, error } = await supabase
            .from('app_config')
            .select('value')
            .eq('key', APP_CONFIG_KEY)
            .maybeSingle();
        if (error || !data) return;
        const arr = JSON.parse(data.value);
        if (!Array.isArray(arr)) return;
        // Unione per (vecchio codice + istante): due persone possono aver
        // rinominato commesse diverse senza essersi ancora sincronizzate.
        const viste = new Set();
        const unite = [];
        for (const v of [...listaRinomine(), ...arr]) {
            const k = `${v.oldCodice}|${v.quando}`;
            if (viste.has(k)) continue;
            viste.add(k);
            unite.push(v);
        }
        unite.sort((a, b) => String(a.quando).localeCompare(String(b.quando)));
        if (JSON.stringify(unite) !== JSON.stringify(listaRinomine())) {
            safeSetItem(STORAGE_KEY, JSON.stringify(unite));
        }
    } catch (err) {
        console.warn('[commesseRinominate] pull non riuscito:', err.message);
    }
}

export async function pushRinomineToCloud() {
    const voci = listaRinomine();
    if (!voci.length) return;
    try {
        const { error } = await supabase
            .from('app_config')
            .upsert({
                key: APP_CONFIG_KEY,
                value: JSON.stringify(voci),
                updated_at: new Date().toISOString(),
            }, { onConflict: 'key' });
        if (error) throw error;
    } catch (err) {
        console.warn('[commesseRinominate] push non riuscito:', err.message);
    }
}
