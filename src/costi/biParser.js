/**
 * biParser.js — parser dell'export Business Intelligence (BI) per i costi.
 *
 * Atteso formato Excel con foglio "Export" (o primo foglio) e colonne:
 *   Codice Commessa | Nome Commessa | Data - Anno | Data - Mese
 *   Descrizione | Baseline Costo | AC | Remaining Costo BAC
 *
 * Comportamenti chiave:
 *   - Header normalizzati (lowercase, trim, spazi multipli compressi)
 *   - Righe di metadata/footer del BI (es. codice "Filtri applicati:..." o "Total")
 *     vengono skippate silenziosamente
 *   - Mese in italiano → "YYYY-MM"
 *   - Descrizione vuota → categoria "non_allocato" (14ª, §4)
 *   - Descrizione "RIS" o "DI CUI RISERVE" → skip silente (non è un costo, §4)
 *   - Descrizione non riconosciuta → errore bloccante con lista delle ignote (§7.2)
 *
 * Output: { commesse: [...], meta: {...}, warnings: [...] }
 */

import * as XLSX from 'xlsx';
import { getCategoryAliasMap, getArchivedLabelsSet } from './costCategoriesStore.js';

const HEADER_MAP = {
    'codice commessa':       'codice',
    'nome commessa':         'nome',
    'data - anno':           'anno',
    'data - mese':           'mese',
    'descrizione':           'descrizione',
    'baseline costo':        'baselineCosto',
    'ac':                    'ac',
    'remaining costo bac':   'remaining',
};

/** Mappa label → id interno per le 13 categorie del Piano dei Conti (§4). */
const CATEGORY_LABEL_TO_ID = {
    'VALORE SUB-CONTRATTI':                'sub_contratti',
    'MATERIALE ACQUISTATO DIRETTO':        'materiale_diretto',
    'MATERIALE INDIRETTO':                 'materiale_indiretto',
    'COSTO PERSONALE DIRETTO':             'personale_diretto',
    'CONSULENZE PROGETTAZIONE':            'consulenze_progettazione',
    'CONSULENZE GENERALI':                 'consulenze_generali',
    'CONSULENZE TECNICHE/SPECIALISTICHE':  'consulenze_tecniche',
    'CONSULENZE HSE E TQM':                'consulenze_hse_tqm',
    'NOLEGGI DIRETTI':                     'noleggi_diretti',
    'COSTI UTENZE':                        'costi_utenze',
    'PENALI RIADDEBITO FORNITORI [-]':     'penali_riaddebito',
    'PENALI [-]':                          'penali_riaddebito', // alias osservato in alcuni export
    'CONTINGENCY COSTI':                   'contingency',
};

/** Categorie che il BI esporta ma che non sono costi (§4): vengono skippate.
 *  In P19 questa lista sarà gestita dal pannello admin. */
const IGNORED_CATEGORIES = new Set([
    'RIS',
    // 'RISERVE',          // commentato per ora — riattivare se serve
    'DI CUI RISERVE',
]);

const MONTH_IT_TO_NUM = {
    'gennaio': 1, 'febbraio': 2, 'marzo': 3, 'aprile': 4,
    'maggio': 5, 'giugno': 6, 'luglio': 7, 'agosto': 8,
    'settembre': 9, 'ottobre': 10, 'novembre': 11, 'dicembre': 12,
};

function normalizeHeader(h) {
    if (h == null) return null;
    return String(h).toLowerCase().trim().replace(/\s+/g, ' ');
}

function isMetadataCodice(cod) {
    if (cod == null) return true;
    const s = String(cod).trim();
    if (!s) return true;
    const lower = s.toLowerCase();
    if (lower.startsWith('filtri')) return true;
    if (lower === 'total' || lower === 'totale' || lower.startsWith('total ')) return true;
    return false;
}

function parseMonthIt(meseStr, anno) {
    if (!meseStr || anno == null) return null;
    const key = String(meseStr).trim().toLowerCase();
    const m = MONTH_IT_TO_NUM[key];
    if (!m) return null;
    const y = Number(anno);
    if (!Number.isFinite(y)) return null;
    return `${y}-${String(m).padStart(2, '0')}`;
}

function toNumberOrZero(v) {
    if (v == null || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Parsa il buffer del file BI.
 *
 * @param {ArrayBuffer} arrayBuffer
 * @param {object} [options]
 * @param {string} [options.fileName] - nome file per metadata
 * @returns {{commesse: Array, meta: object, warnings: Array<string>}}
 *
 * @throws {Error} se mancano colonne obbligatorie o se ci sono categorie ignote.
 */
export function parseBIExport(arrayBuffer, options = {}) {
    const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: false });

    // Sheet preferito "Export", altrimenti il primo
    const sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'export') || wb.SheetNames[0];
    if (!sheetName) throw new Error('Il file BI non contiene fogli.');

    const ws = wb.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null });
    if (!rawRows.length) throw new Error('Il foglio BI è vuoto.');

    // Carica configurazione dinamica delle categorie (override del pannello admin).
    // Le mappe contengono label + alias delle categorie ATTIVE.
    const dynamicAliasMap = getCategoryAliasMap();
    const dynamicArchivedLabels = getArchivedLabelsSet();

    // ── Header validation ──
    const rawHeaders = Object.keys(rawRows[0]);
    const headerToField = {};
    for (const rh of rawHeaders) {
        const norm = normalizeHeader(rh);
        if (HEADER_MAP[norm]) {
            headerToField[rh] = HEADER_MAP[norm];
        }
    }
    const requiredFields = ['codice', 'nome', 'anno', 'mese', 'descrizione', 'baselineCosto', 'ac', 'remaining'];
    const presentFields = new Set(Object.values(headerToField));
    const missing = requiredFields.filter(f => !presentFields.has(f));
    if (missing.length > 0) {
        throw new Error(
            `Colonne mancanti nel file BI: ${missing.join(', ')}. ` +
            `Header attesi: Codice Commessa | Nome Commessa | Data - Anno | Data - Mese | Descrizione | Baseline Costo | AC | Remaining Costo BAC.`
        );
    }

    // ── Row parsing ──
    const commesseMap = new Map();   // codice|||nome → { codice, nome, mesi: [...] }
    const unknownCategories = new Set();
    const warnings = [];
    const stats = {
        righeTotali: rawRows.length,
        righeMetadata: 0,
        righeSenzaCodice: 0,
        righeSenzaAnno: 0,
        righeMeseInvalido: 0,
        righeIgnorateCategoria: 0, // RIS, DI CUI RISERVE
        righeNonAllocato: 0,
        righeImportate: 0,
        righeRemainingNegativo: 0, // edge case §14.6: normalizzato a 0
    };

    for (const raw of rawRows) {
        const row = {};
        for (const [rh, field] of Object.entries(headerToField)) {
            row[field] = raw[rh];
        }

        // Skip metadata/footer rows (es. "Filtri applicati:..." o "Total")
        if (isMetadataCodice(row.codice)) {
            stats.righeMetadata++;
            continue;
        }
        if (row.codice == null || String(row.codice).trim() === '') {
            stats.righeSenzaCodice++;
            continue;
        }

        const codice = String(row.codice).trim();
        const nome = (row.nome != null ? String(row.nome).trim() : '');
        const mese = parseMonthIt(row.mese, row.anno);
        if (!mese) {
            if (row.anno == null || !Number.isFinite(Number(row.anno))) stats.righeSenzaAnno++;
            else stats.righeMeseInvalido++;
            continue;
        }

        // Categoria
        const descRaw = row.descrizione == null ? '' : String(row.descrizione).trim();
        let categoriaId = null;
        if (descRaw === '') {
            categoriaId = 'non_allocato';
            stats.righeNonAllocato++;
        } else if (IGNORED_CATEGORIES.has(descRaw.toUpperCase())) {
            // Hardcoded ignorate (RIS, DI CUI RISERVE)
            stats.righeIgnorateCategoria++;
            continue;
        } else if (dynamicArchivedLabels.has(descRaw.toUpperCase())) {
            // Categoria archiviata via pannello admin → ignora silenziosamente
            stats.righeIgnorateCategoria++;
            continue;
        } else {
            const upper = descRaw.toUpperCase();
            // Prima cerca nella mappa dinamica (label + alias delle categorie attive)
            categoriaId = dynamicAliasMap[upper] || CATEGORY_LABEL_TO_ID[upper];
            if (!categoriaId) {
                unknownCategories.add(descRaw);
                continue;
            }
        }

        const key = `${codice}|||${nome}`;
        if (!commesseMap.has(key)) {
            commesseMap.set(key, { codice, nome, mesi: [] });
        }
        // I remaining negativi sono valori reali nel BI (storni / correzioni):
        // li preserviamo così come sono. Il contatore stats.righeRemainingNegativo
        // resta come informazione diagnostica (visibile nel summary).
        const remainingVal = toNumberOrZero(row.remaining);
        if (remainingVal < 0) stats.righeRemainingNegativo++;
        commesseMap.get(key).mesi.push({
            mese,
            descrizione: descRaw || '(vuoto)',
            categoriaId,
            baselineCosto: toNumberOrZero(row.baselineCosto),
            ac: toNumberOrZero(row.ac),
            remaining: remainingVal,
        });
        stats.righeImportate++;
    }

    // ── Categorie sconosciute → errore bloccante (§7.2) ──
    if (unknownCategories.size > 0) {
        const list = Array.from(unknownCategories).map(c => `"${c}"`).join(', ');
        throw new Error(
            `Categorie merceologiche non riconosciute nel file BI: ${list}. ` +
            `Aggiorna il file BI o segnala al supporto per aggiungere alias.`
        );
    }

    // ── Calcola cutoffMese: max mese con AC > 0 su tutte le righe ──
    let cutoffMese = null;
    for (const c of commesseMap.values()) {
        for (const m of c.mesi) {
            if (m.ac > 0) {
                if (!cutoffMese || m.mese > cutoffMese) cutoffMese = m.mese;
            }
        }
    }

    // ── Ordina i mesi di ciascuna commessa ──
    for (const c of commesseMap.values()) {
        c.mesi.sort((a, b) => a.mese.localeCompare(b.mese));
    }

    // ── Warnings non bloccanti ──
    if (stats.righeIgnorateCategoria > 0) {
        warnings.push(`${stats.righeIgnorateCategoria} righe con categoria RIS/DI CUI RISERVE ignorate (non costi).`);
    }
    if (stats.righeMeseInvalido > 0) {
        warnings.push(`${stats.righeMeseInvalido} righe con mese non valido scartate.`);
    }
    if (stats.righeNonAllocato > 0) {
        warnings.push(`${stats.righeNonAllocato} righe senza descrizione → categoria "NON ALLOCATO".`);
    }
    if (stats.righeRemainingNegativo > 0) {
        warnings.push(`${stats.righeRemainingNegativo} righe con Remaining negativo normalizzate a 0.`);
    }

    return {
        commesse: Array.from(commesseMap.values()).sort((a, b) => a.codice.localeCompare(b.codice)),
        meta: {
            sheetName,
            fileName: options.fileName || null,
            cutoffMese,
            stats,
        },
        warnings,
    };
}
