/**
 * curveEngine.js — generazione della distribuzione mensile di un importo
 * secondo uno dei profili di curva definiti in costProfili.js.
 *
 * Modulo PURO: nessuna dipendenza da scenarioEngine, scenarioManager, ecc.
 * Volutamente isolato per evitare qualsiasi rischio di regressione sul
 * dominio ricavi esistente.
 *
 * Algoritmo (§5.1 della specifica):
 *   1. Costruisci array di mesi consecutivi a partire da dataInizio
 *   2. Se profilo == "uniforme" → peso[i] = 1/N
 *   3. Altrimenti gaussiana:
 *        μ = paramA × (N - 1)
 *        σ = N × paramKSigma
 *        w[i] = exp(-((i - μ)^2) / (2σ^2))
 *        peso[i] = w[i] / Σ w[j]
 *   4. valore[i] = totale × peso[i]
 */

import { getProfileById } from './costProfili.js';

/**
 * Sposta una stringa "YYYY-MM" di N mesi (positivo o negativo).
 * Logica equivalente a scenarioEngine.shiftMonth ma duplicata qui per
 * mantenere il modulo costi self-contained (no modifiche a scenarioEngine).
 * Esportata per riuso da altri moduli del pacchetto costi.
 */
export function shiftMonth(monthStr, shift) {
    if (!monthStr) return monthStr;
    if (!shift) return monthStr;
    const [yStr, mStr] = monthStr.split('-');
    let y = Number(yStr);
    let m = Number(mStr) + shift;
    while (m > 12) { m -= 12; y++; }
    while (m < 1)  { m += 12; y--; }
    return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Calcola il numero di mesi inclusivi tra start ed end (entrambi "YYYY-MM").
 * Es: monthsBetween("2026-01", "2026-12") === 12
 *     monthsBetween("2026-01", "2026-01") === 1
 * Ritorna 0 se uno dei due è null/invalid o se end < start.
 */
export function monthsBetween(start, end) {
    if (!start || !end) return 0;
    const [sy, sm] = start.split('-').map(Number);
    const [ey, em] = end.split('-').map(Number);
    if (!Number.isFinite(sy) || !Number.isFinite(sm) || !Number.isFinite(ey) || !Number.isFinite(em)) return 0;
    const diff = (ey - sy) * 12 + (em - sm) + 1;
    return diff > 0 ? diff : 0;
}

/** Genera N mesi consecutivi a partire da dataInizio compresa. */
function generateMonthList(dataInizio, durata) {
    const months = [];
    for (let i = 0; i < durata; i++) {
        months.push(shiftMonth(dataInizio, i));
    }
    return months;
}

/**
 * Calcola i pesi normalizzati [0..1] per ogni mese della durata,
 * secondo il profilo richiesto. La somma dei pesi è 1.
 */
function calculateWeights(durata, tipoCurva) {
    if (durata <= 0) return [];
    if (durata === 1) return [1];

    const profile = getProfileById(tipoCurva);
    if (!profile || profile.id === 'uniforme') {
        return Array(durata).fill(1 / durata);
    }

    const mu = profile.paramA * (durata - 1);
    const sigma = durata * profile.paramKSigma;
    const w = [];
    for (let i = 0; i < durata; i++) {
        w.push(Math.exp(-((i - mu) ** 2) / (2 * sigma * sigma)));
    }
    const sum = w.reduce((s, x) => s + x, 0);
    return w.map(x => x / sum);
}

/**
 * Genera la distribuzione mensile di un importo.
 *
 * @param {string} dataInizio - "YYYY-MM" del primo mese
 * @param {number} durata - numero di mesi (>= 1)
 * @param {string} tipoCurva - id del profilo (uniforme | s_curve | s_curve_inizio | s_curve_fine | custom_1|2|3)
 * @param {number} totale - importo totale da distribuire
 * @returns {Array<{mese: string, valore: number}>}
 *
 * Edge cases:
 *   - durata <= 0          → []
 *   - totale == 0          → array di mesi con valore 0
 *   - tipoCurva sconosciuto → fallback a uniforme (silente, non lancia eccezione)
 *   - dataInizio mancante  → []
 */
export function generateCurve(dataInizio, durata, tipoCurva, totale) {
    if (!dataInizio || durata <= 0) return [];
    const months = generateMonthList(dataInizio, durata);
    const weights = calculateWeights(durata, tipoCurva);
    return months.map((mese, i) => ({
        mese,
        valore: (totale || 0) * weights[i],
    }));
}

/**
 * Helper esposto per testabilità: ritorna i pesi normalizzati senza moltiplicarli per il totale.
 * Utile per test/debug e per eventuali grafici di profilo (es. anteprima curva).
 */
export function getCurveWeights(durata, tipoCurva) {
    return calculateWeights(durata, tipoCurva);
}
