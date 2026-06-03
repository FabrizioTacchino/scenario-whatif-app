/**
 * costEngine.js — calcolo dei valori mensili di costo per categoria,
 * applicando le modifiche dello scenario (probabilità, shift, ritardo).
 *
 * Pipeline (§5.2 della specifica):
 *   1. Base = AC storico + curva futuro (generata via curveEngine)
 *   2. Scala probabilità (solo OI)         → moltiplica tutti i valori
 *   3. Shift (shiftStart)                  → trasla i mesi
 *   4. Ritardo/smoothing (per categoria)   → estende la coda e ridistribuisce
 *
 * Se lo scenario è locked e ha costiSnapshot, si bypassa il calcolo e si
 * restituisce direttamente lo snapshot congelato (§10.2).
 *
 * NOTA: applyDelaySmoothing è duplicato fedelmente da scenarioEngine.js:91
 * per non modificare quel file. Se in futuro la duplicazione diventa un
 * problema (es. drift), valutare un piccolo refactor mirato.
 */

import { generateCurve, shiftMonth, monthsBetween } from './curveEngine.js';
import { getActiveDefaultCategoriesLive } from './costCategoriesStore.js';

/**
 * Smoothing identico a scenarioEngine.applyDelaySmoothing.
 * Lavora su array [{month, vdp}] — adatto i miei {mese, valore} prima/dopo.
 */
function applyDelaySmoothing(months, delay, intensity = 0.5) {
    if (delay === 0) return months;

    const withProd = months.filter(m => (m.vdp || 0) > 0);
    if (withProd.length === 0) return months;

    const totalVDP = withProd.reduce((s, m) => s + (m.vdp || 0), 0);
    const firstProdMonth = withProd[0].month;
    const lastProdMonth = withProd[withProd.length - 1].month;

    const monthsKeys = months.map(m => m.month);
    const extendedMonths = [...monthsKeys];
    let lastM = lastProdMonth;
    for (let i = 0; i < delay; i++) {
        lastM = shiftMonth(lastM, 1);
        if (!extendedMonths.includes(lastM)) {
            extendedMonths.push(lastM);
        }
    }
    extendedMonths.sort();

    const startIdx = extendedMonths.indexOf(firstProdMonth);
    const endIdx = extendedMonths.indexOf(lastM);
    const newProdRange = extendedMonths.slice(startIdx, endIdx + 1);
    const newLen = newProdRange.length;

    const baseVDPMap = {};
    for (const m of months) {
        baseVDPMap[m.month] = m.vdp || 0;
    }

    const origProdVDPs = [];
    for (const m of monthsKeys) {
        if (m >= firstProdMonth && m <= lastProdMonth) {
            origProdVDPs.push(baseVDPMap[m] || 0);
        }
    }
    const origLen = origProdVDPs.length;

    const newVDPs = new Array(newLen).fill(0);
    for (let i = 0; i < newLen; i++) {
        const origPos = (i / (newLen - 1 || 1)) * (origLen - 1);
        const lo = Math.floor(origPos);
        const hi = Math.min(lo + 1, origLen - 1);
        const frac = origPos - lo;
        newVDPs[i] = origProdVDPs[lo] * (1 - frac) + origProdVDPs[hi] * frac;
    }

    const rawSum = newVDPs.reduce((s, v) => s + v, 0);
    if (rawSum > 0) {
        const scale = totalVDP / rawSum;
        for (let i = 0; i < newLen; i++) newVDPs[i] *= scale;
    }

    const resultMap = {};
    for (const m of extendedMonths) resultMap[m] = baseVDPMap[m] || 0;
    for (const m of monthsKeys) {
        if (m >= firstProdMonth && m <= lastProdMonth) resultMap[m] = 0;
    }
    for (let i = 0; i < newLen; i++) {
        resultMap[newProdRange[i]] = newVDPs[i];
    }

    return extendedMonths.map(m => ({
        month: m,
        vdp: resultMap[m] || 0
    }));
}

/**
 * Calcola i valori mensili di una categoria di costo per una commessa,
 * applicando le modifiche dello scenario.
 *
 * @param {object} scenario     - lo scenario corrente (può non avere campo costi)
 * @param {string} commessaKey  - chiave commessa (codice|nome)
 * @param {string} categoriaId  - id categoria (es. 'sub_contratti')
 * @param {object} commessa     - oggetto commessa per type/probabilitaAOP/margineAOP
 * @returns {Array<{mese: string, valore: number}>} mesi ordinati cronologicamente
 *
 * Garanzie:
 *   - Se scenario è null/undefined → []
 *   - Se scenario.costi assente → []
 *   - Se commessa non ha dati per la categoria → []
 *   - Se locked && costiSnapshot disponibile → snapshot diretto (no calcolo)
 */
export function computeCategoriaMensile(scenario, commessaKey, categoriaId, commessa) {
    if (!scenario || !commessaKey || !categoriaId) return [];

    // ── Snapshot bypass (scenario locked) ──
    if (scenario.locked && scenario.costiSnapshot) {
        const snap = scenario.costiSnapshot[commessaKey]?.[categoriaId];
        if (snap) {
            return Object.entries(snap)
                .map(([mese, valore]) => ({ mese, valore: Number(valore) || 0 }))
                .sort((a, b) => a.mese.localeCompare(b.mese));
        }
        // Locked ma snapshot mancante → procedo con calcolo live
    }

    // ── Guards: dati assenti ──
    const costi = scenario.costi || {};
    const costiComm = costi[commessaKey];
    if (!costiComm) return [];
    const cat = costiComm.categorie?.[categoriaId];
    if (!cat) return [];

    // ── 1. Base: AC storico + curva futuro ──
    const baseMap = {};

    // AC storico (immodificabile dall'utente)
    const acMap = cat.acStorico || {};
    for (const [mese, valore] of Object.entries(acMap)) {
        const v = Number(valore);
        if (Number.isFinite(v)) {
            baseMap[mese] = (baseMap[mese] || 0) + v;
        }
    }

    // Futuro: priorità a remainingStorico (R0) → distribuzione puntuale dal BI
    // preservata. Se assente, fallback alla curva (cold-start, suggerisci, edit manuale).
    const remainingStoricoMap = cat.remainingStorico && typeof cat.remainingStorico === 'object'
        ? cat.remainingStorico
        : null;
    const hasRemainingStorico = remainingStoricoMap && Object.keys(remainingStoricoMap).length > 0;

    if (hasRemainingStorico) {
        // Usa valori puntuali dal BI senza ridistribuire con la curva
        for (const [mese, valore] of Object.entries(remainingStoricoMap)) {
            const v = Number(valore);
            if (!Number.isFinite(v)) continue;
            if (baseMap[mese] === undefined) {
                baseMap[mese] = v;
            }
        }
    } else if (cat.dataInizio && cat.dataFine && cat.importoFuturo) {
        // R2: la curva si applica da cutoffMese+1 (se presente) a dataFine.
        // Se cutoffMese è null/undefined → curva da dataInizio (caso cold-start senza AC,
        // backward-compatible per scenari pre-fix R1).
        const curveStart = cat.cutoffMese
            ? shiftMonth(cat.cutoffMese, 1)
            : cat.dataInizio;
        // Se cutoffMese è già >= dataFine, niente da generare (categoria già "consumata")
        if (curveStart && curveStart <= cat.dataFine) {
            const curveDurata = monthsBetween(curveStart, cat.dataFine);
            if (curveDurata > 0) {
                const futuro = generateCurve(
                    curveStart,
                    curveDurata,
                    cat.tipoCurva || 'uniforme',
                    cat.importoFuturo
                );
                for (const { mese, valore } of futuro) {
                    if (baseMap[mese] === undefined) {
                        baseMap[mese] = valore;
                    }
                }
            }
        }
    }

    let result = Object.entries(baseMap)
        .map(([mese, valore]) => ({ mese, valore }))
        .sort((a, b) => a.mese.localeCompare(b.mese));

    if (result.length === 0) return [];

    // ── 2. Scala probabilità (solo OI) ──
    const inputs = scenario.inputs?.[commessaKey] || {};
    const isOI = commessa?.type === 'Order Intake';
    if (isOI) {
        const probAOP = commessa?.probabilitaAOP != null ? commessa.probabilitaAOP : 1;
        let probNuova = probAOP;
        if (inputs.probabilita != null && inputs.probabilita !== '') {
            probNuova = Number(inputs.probabilita) / 100;
        }
        // probFile = riferimento di partenza dei dati. Per scenari calculated è probabilitaAOP.
        // Per scenari imported può esserci inputs.probabilitaFile (allineato con scenarioEngine).
        const probFile = inputs.probabilitaFile != null
            ? Number(inputs.probabilitaFile) / 100
            : (probAOP > 0 ? probAOP : 1);
        const probScale = probFile > 0 ? probNuova / probFile : probNuova;
        if (probScale !== 1) {
            result = result.map(m => ({ mese: m.mese, valore: m.valore * probScale }));
        }
    }

    // ── 3. Shift (shiftStart) ──
    const shift = Number(inputs.shiftStart) || 0;
    if (shift !== 0) {
        result = result.map(m => ({ mese: shiftMonth(m.mese, shift), valore: m.valore }));
        result.sort((a, b) => a.mese.localeCompare(b.mese));
    }

    // ── 4. Ritardo/smoothing (per categoria) ──
    const ritardo = Number(inputs.ritardo) || 0;
    if (ritardo > 0) {
        const intensity = (inputs.smussamento != null && inputs.smussamento !== '')
            ? Number(inputs.smussamento) / 100
            : 0.5;
        // Adatto a {month, vdp} richiesto da applyDelaySmoothing
        const adapted = result.map(m => ({ month: m.mese, vdp: m.valore }));
        const smoothed = applyDelaySmoothing(adapted, ritardo, intensity);
        result = smoothed.map(m => ({ mese: m.month, valore: m.vdp }));
    }

    return result;
}

/**
 * Cold-start OI: genera la struttura costi di una commessa Order Intake
 * a partire da margine e date della baseline ricavi (§5.3).
 *
 * Costo totale = vdpTotal × (1 − margineAOP), distribuito sulle categorie
 * con peso > 0 secondo i pesi default (§4). Le categorie con peso 0
 * (penali_riaddebito, non_allocato) non vengono generate.
 *
 * @param {object} params
 * @param {number} params.vdpTotal             - somma del VDP della commessa nella baseline
 * @param {number} params.margineAOP           - margine atteso [0..1] (0.2 = 20%)
 * @param {string} params.dataInizioCommessa   - "YYYY-MM" primo mese baseline ricavi
 * @param {string} params.dataFineCommessa     - "YYYY-MM" ultimo mese baseline ricavi
 * @returns {{categorie: object, meta: object}} struttura pronta per scenario.costi[commessaKey]
 *
 * Edge cases:
 *   - margineAOP >= 1 → costo totale = 0, ritorna { categorie: {} } (warning console)
 *   - vdpTotal <= 0   → ritorna { categorie: {} }
 *   - date mancanti o invalide → ritorna { categorie: {} }
 */
export function generateCostsFromMargin({ vdpTotal, margineAOP, dataInizioCommessa, dataFineCommessa }) {
    const meta = {
        costoTotaleCommessa: 0,
        durata: 0,
        skipped: false,
        skippedReason: null,
    };

    // ── Validazione input ──
    if (!Number.isFinite(vdpTotal) || vdpTotal <= 0) {
        meta.skipped = true;
        meta.skippedReason = 'vdpTotal <= 0';
        return { categorie: {}, meta };
    }
    if (!Number.isFinite(margineAOP)) {
        meta.skipped = true;
        meta.skippedReason = 'margineAOP non valido';
        return { categorie: {}, meta };
    }
    if (margineAOP >= 1) {
        // §14.10: margine ≥ 100% → costi = 0, nessuna generazione
        console.warn('[costEngine] generateCostsFromMargin: margineAOP >= 1, nessuna generazione costi');
        meta.skipped = true;
        meta.skippedReason = 'margineAOP >= 1';
        return { categorie: {}, meta };
    }

    const durata = monthsBetween(dataInizioCommessa, dataFineCommessa);
    if (durata <= 0) {
        meta.skipped = true;
        meta.skippedReason = 'date commessa non valide o invertite';
        return { categorie: {}, meta };
    }

    const costoTotale = vdpTotal * (1 - margineAOP);
    meta.costoTotaleCommessa = costoTotale;
    meta.durata = durata;

    if (costoTotale <= 0) {
        meta.skipped = true;
        meta.skippedReason = 'costoTotale <= 0';
        return { categorie: {}, meta };
    }

    // ── Distribuisci sulle categorie con peso > 0 ──
    const categorie = {};
    for (const cat of getActiveDefaultCategoriesLive()) {
        categorie[cat.id] = {
            dataInizio: dataInizioCommessa,
            durata: durata,
            dataFine: dataFineCommessa,
            cutoffMese: null, // R1: cold-start senza AC → curva su tutto il range
            tipoCurva: cat.curvaDefault,
            importoFuturo: costoTotale * cat.peso,
            acStorico: {},
            remainingStorico: {}, // R0: cold-start non ha distribuzione puntuale → curva
            baselineCostoOriginale: null,
            origine: 'cold_start_margine',
        };
    }

    return { categorie, meta };
}

/**
 * Deriva dataInizio e dataFine di una commessa dai suoi mesi della baseline ricavi.
 * Considera solo i mesi con vdpAOP > 0 (i mesi a zero non contano).
 *
 * @param {Array} baselineMonths - array di {month, vdpAOP, ...} dalla baseline
 * @returns {{dataInizio: string|null, dataFine: string|null}}
 */
export function deriveCommessaDates(baselineMonths) {
    if (!Array.isArray(baselineMonths) || baselineMonths.length === 0) {
        return { dataInizio: null, dataFine: null };
    }
    const productive = baselineMonths.filter(m => Number(m?.vdpAOP) > 0);
    if (productive.length === 0) return { dataInizio: null, dataFine: null };
    productive.sort((a, b) => String(a.month).localeCompare(String(b.month)));
    return {
        dataInizio: productive[0].month,
        dataFine: productive[productive.length - 1].month,
    };
}

/**
 * Trova lo scenario precedente più recente che ha dati costi per la commessa indicata.
 * "Precedente" = qualsiasi altro scenario salvato (non identifica una relazione genitore/figlio,
 * ma l'ultimo modificato disponibile, ordinato per updatedAt desc).
 *
 * @returns {object|null} scenario sorgente o null
 */
function findCostsInPreviousScenario(commessaKey, currentScenarioId, allScenarios) {
    if (!Array.isArray(allScenarios)) return null;
    const candidates = allScenarios
        .filter(s => s && s.id !== currentScenarioId)
        .filter(s => {
            const c = s.costi?.[commessaKey];
            return c && c.categorie && Object.keys(c.categorie).length > 0;
        })
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return candidates[0] || null;
}

/**
 * Cold-start da margine usando i mesi sorgente forniti. Riusato sia per scenari
 * imported (mesi da importedData) che per OI calculated (mesi baseline).
 *
 *   - vdpTotal: prima dal campo commessa.vdpTotale; se 0/mancante (caso commesse
 *     extra di scenari imported), deriva sommando i vdpAOP dei mesi sorgente
 *   - margine: prima override da inputs[key].margine (anche per scenari imported
 *     dove il file può portare un margine WhatIf), altrimenti commessa.margineAOP
 */
function coldStartFromMargin(scenario, commessaKey, commessa, baselineMonths) {
    const dates = deriveCommessaDates(baselineMonths);
    let vdpTotal = Number(commessa?.vdpTotale) || 0;
    if (vdpTotal <= 0 && Array.isArray(baselineMonths)) {
        vdpTotal = baselineMonths.reduce((s, m) => s + (Number(m.vdpAOP) || 0), 0);
    }
    const inputs = scenario?.inputs?.[commessaKey] || {};
    let margine = Number(commessa?.margineAOP) || 0;
    if (inputs.margine != null && inputs.margine !== '') {
        margine = Number(inputs.margine) / 100;
    }
    const result = generateCostsFromMargin({
        vdpTotal,
        margineAOP: margine,
        dataInizioCommessa: dates.dataInizio,
        dataFineCommessa: dates.dataFine,
    });
    return {
        categorie: result.categorie,
        origine: result.meta.skipped ? 'vuoto' : 'cold_start_margine',
        meta: result.meta,
    };
}

/**
 * Fallback chain (§5.4) per ottenere i costi di una commessa in uno scenario.
 * Distingue scenari imported da calculated:
 *   - imported  → "ogni scenario vive di luce propria": skip copia da scenario
 *                 precedente. Cold-start direttamente dai mesi importati.
 *   - calculated → fallback chain originale: scenario corrente → scenario
 *                  precedente → cold-start OI da margine → vuoto.
 *
 * @param {object} params
 * @param {object} params.scenario       - scenario corrente
 * @param {string} params.commessaKey    - chiave commessa
 * @param {object} params.commessa       - oggetto commessa (type, vdpTotale, margineAOP)
 * @param {Array}  params.baselineMonths - mesi sorgente per la commessa (importedData
 *                                          per scenari imported, baseline ricavi altrimenti)
 * @param {Array}  params.allScenarios   - tutti gli scenari salvati
 * @returns {{categorie: object, origine: string, sourceScenarioId?: string, sourceScenarioName?: string, meta?: object}}
 */
export function getCostsForCommessa({ scenario, commessaKey, commessa, baselineMonths, allScenarios }) {
    // 1. Scenario corrente ha già una struttura per questa commessa ──
    //    Rispetta la scelta dell'utente: se categorie esiste (anche vuoto = Azzera),
    //    ritorna quello. Solo se la struttura proprio non esiste (mai materializzata)
    //    si passa al fallback chain.
    const existing = scenario?.costi?.[commessaKey];
    if (existing && existing.categorie != null) {
        return {
            categorie: existing.categorie,
            origine: 'scenario_corrente',
        };
    }

    // 2a. Scenari IMPORTED: cold-start diretto dai mesi importati.
    //     Niente "copia da scenario precedente": gli scenari imported sono
    //     fotografie autonome e devono usare le date del proprio file.
    if (scenario?.type === 'imported') {
        return coldStartFromMargin(scenario, commessaKey, commessa, baselineMonths);
    }

    // 2b. Scenari CALCULATED: copia da scenario precedente (deep clone) ──
    const prev = findCostsInPreviousScenario(commessaKey, scenario?.id, allScenarios);
    if (prev) {
        const cloned = JSON.parse(JSON.stringify(prev.costi[commessaKey]));
        return {
            categorie: cloned.categorie || {},
            origine: 'copiato_da_scenario',
            sourceScenarioId: prev.id,
            sourceScenarioName: prev.name || '',
        };
    }

    // 3. Cold-start OI da margine (per calculated OI senza precedenti) ──
    if (commessa?.type === 'Order Intake') {
        return coldStartFromMargin(scenario, commessaKey, commessa, baselineMonths);
    }

    // 4. Backlog calculated senza dati né precedenti → vuoto ──
    return { categorie: {}, origine: 'vuoto' };
}
