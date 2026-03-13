/**
 * scenarioEngine.js — Compute scenario results from baseline + inputs
 */
import { dateToMonth } from './dataLoader.js';

/**
 * Shift a month string by N months
 * @param {string} monthStr "YYYY-MM"
 * @param {number} shift months to add (can be negative)
 * @returns {string} shifted "YYYY-MM"
 */
function shiftMonth(monthStr, shift) {
    if (!monthStr || !shift) return monthStr;
    const [y, m] = monthStr.split('-').map(Number);
    const d = new Date(y, m - 1 + shift, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Compute scenario for a single commessa
 * @param {object} commessa - commessa metadata
 * @param {Array} baselineMonths - array of {month, vdp, marginePerc, ...}
 * @param {object} inputs - scenario inputs {shiftStart, probabilita, margine, ritardo, smussamento}
 * @returns {Array} scenarioMonths [{month, vdp, margine}]
 */
function computeCommessa(commessa, baselineMonths, inputs) {
    const type = commessa.type;
    const isOI = type === 'Order Intake';
    const isBL = type === 'Backlog';

    if (isOI) {
        return computeOrderIntake(commessa, baselineMonths, inputs);
    } else if (isBL) {
        return computeBacklog(commessa, baselineMonths, inputs);
    }
    // Unknown type — pass through baseline
    return baselineMonths.map(m => {
        const val = m.vdpAOP != null ? m.vdpAOP : (m.vdp || 0);
        return {
            month: m.month,
            vdp: val,
            margine: val * (commessa.margineAOP || 0),
        };
    });
}

/**
 * ORDER INTAKE scenario
 */
function computeOrderIntake(commessa, baselineMonths, inputs) {
    const shift = inputs.shiftStart || 0;

    // Probability: whatif -> AOP -> 100%
    let prob = 1;
    if (inputs.probabilita != null && inputs.probabilita !== '') {
        prob = Number(inputs.probabilita) / 100;
    } else {
        prob = commessa.probabilitaAOP != null ? commessa.probabilitaAOP : 1;
    }

    // Margin: whatif -> AOP
    let margPerc = commessa.margineAOP || 0;
    if (inputs.margine != null && inputs.margine !== '') {
        margPerc = Number(inputs.margine) / 100;
    }

    const probAOP = commessa.probabilitaAOP != null ? commessa.probabilitaAOP : 1;

    return baselineMonths.map(m => {
        const newMonth = shiftMonth(m.month, shift);
        // Normalize: restore 100% value if baseline was already weighted
        const baseVdp = m.vdpAOP != null ? m.vdpAOP : (m.vdp || 0);
        const normalizedVdp = probAOP > 0 ? baseVdp / probAOP : baseVdp;
        const vdp = normalizedVdp * prob;

        return {
            month: newMonth,
            vdp,
            margine: vdp * margPerc,
        };
    });
}

/**
 * Reusable logic to extend production range and redistribute VDP (smoothing)
 * @param {Array} months - array of {month, vdp}
 * @param {number} delay - months to add to the end
 * @param {number} intensity - smoothing intensity (0-1)
 * @returns {Array} newMonths [{month, vdp}]
 */
function applyDelaySmoothing(months, delay, intensity = 0.5) {
    if (delay === 0) return months;

    const withProd = months.filter(m => (m.vdp || 0) > 0);
    if (withProd.length === 0) return months;

    const totalVDP = withProd.reduce((s, m) => s + (m.vdp || 0), 0);
    const firstProdMonth = withProd[0].month;
    const lastProdMonth = withProd[withProd.length - 1].month;

    // Build extended month list
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

    // Build baseline VDP map
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

    // Linear stretching
    const newVDPs = new Array(newLen).fill(0);
    for (let i = 0; i < newLen; i++) {
        const origPos = (i / (newLen - 1 || 1)) * (origLen - 1);
        const lo = Math.floor(origPos);
        const hi = Math.min(lo + 1, origLen - 1);
        const frac = origPos - lo;
        const interpolated = origProdVDPs[lo] * (1 - frac) + origProdVDPs[hi] * frac;
        newVDPs[i] = interpolated;
    }

    // Normalize
    const rawSum = newVDPs.reduce((s, v) => s + v, 0);
    if (rawSum > 0) {
        const scale = totalVDP / rawSum;
        for (let i = 0; i < newLen; i++) newVDPs[i] *= scale;
    }

    // Build final map
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
 * BACKLOG scenario — extend tail, redistribute VDP smoothly
 */
function computeBacklog(commessa, baselineMonths, inputs) {
    const ritardo = inputs.ritardo || 0;

    // Margin override
    let margPerc = commessa.margineAOP || 0;
    if (inputs.margine != null && inputs.margine !== '') {
        margPerc = Number(inputs.margine) / 100;
    }

    // If no delay, pass through
    if (ritardo === 0) {
        return baselineMonths.map(m => {
            const val = m.vdpAOP != null ? m.vdpAOP : (m.vdp || 0);
            return {
                month: m.month,
                vdp: val,
                margine: val * margPerc,
            };
        });
    }

    const intensity = (inputs.smussamento != null && inputs.smussamento !== '') ? Number(inputs.smussamento) / 100 : 0.5;

    const vdpList = baselineMonths.map(m => ({
        month: m.month,
        vdp: m.vdpAOP != null ? m.vdpAOP : (m.vdp || 0)
    }));

    const smoothed = applyDelaySmoothing(vdpList, ritardo, intensity);

    return smoothed.map(m => ({
        month: m.month,
        vdp: m.vdp,
        margine: m.vdp * margPerc
    }));
}


/**
 * Compute full scenario across all commesse
 * @param {Array} commesse - list of commessa objects
 * @param {Map} monthlyData - Map<key, [{month, vdpAOP, vdpActual, vdpRemaining, ...}]>
 * @param {object} scenario - {id, name, type, inputs, importedData}
 * @param {object} filters - {settori:[], types:[], commesse:[], dateFrom, dateTo}
 * @returns {object} { monthly: [{month, baselineVDP, scenarioVDP, vdpActual, vdpRemaining, baselineMargine, scenarioMargine}], kpis, commessaResults }
 */
export function computeScenario(commesse, monthlyData, scenario = {}, filters = {}) {
    const isImported = scenario.type === 'imported';
    const scenarioInputs = scenario.inputs || {};
    const importedData = scenario.importedData || {};

    const baselineAgg = {};  // month -> {vdp, margine, actual, remaining}
    const scenarioAgg = {};  // month -> {vdp, margine, actual, remaining}
    const allMonthsSet = new Set();
    const commessaResults = [];

    for (const comm of commesse) {
        // Apply filters
        if (filters.settori && filters.settori.length && !filters.settori.includes(comm.settore)) continue;
        const effectiveTypeForFilter = (scenarioInputs[comm.key] || {}).type || comm.type;
        if (filters.types && filters.types.length && !filters.types.includes(effectiveTypeForFilter)) continue;
        if (filters.commesse && filters.commesse.length && !filters.commesse.includes(comm.key)) continue;

        const baseline = monthlyData.get(comm.key) || [];

        let scenarioMonths = [];
        if (isImported) {
            // Use imported data if available for this commessa
            const data = importedData[comm.key] || [];
            const inputs = scenarioInputs[comm.key] || {};

            // Margin: input override -> AOP
            let margPerc = (comm.margineAOP || 0);
            if (inputs.margine != null && inputs.margine !== '') {
                margPerc = Number(inputs.margine) / 100;
            }

            // Per scenari importati il VDP del file è già calcolato alla probabilità
            // del file stesso — non va riscalato rispetto alla probabilità AOP.
            // probScale resta sempre 1: inputs.probabilita serve solo per la visualizzazione
            // nella tabella Assunzioni, non per scalare i valori.
            const probScale = 1;
            const isOI = comm.type === 'Order Intake';
            const shift = inputs.shiftStart || 0;
            const ritardo = inputs.ritardo || 0;
            const intensity = (inputs.smussamento != null && inputs.smussamento !== '') ? Number(inputs.smussamento) / 100 : 0.5;

            const baseImported = data.map(d => ({
                month: shift !== 0 ? shiftMonth(d.month, shift) : d.month,
                vdp: ((d.actual || 0) + (d.remaining || 0)) * probScale,
                actual: (d.actual || 0) * probScale,
                remaining: (d.remaining || 0) * probScale
            }));

            // Apply delay if specified
            let processed = baseImported;
            if (ritardo > 0) {
                const smoothed = applyDelaySmoothing(baseImported, ritardo, intensity);
                // After smoothing, we need to re-map actual/remaining proportion
                // For simplicity, for now we treat smoothed VDP as all remaining
                processed = smoothed.map(m => {
                    const orig = baseImported.find(o => o.month === m.month);
                    return {
                        ...m,
                        actual: orig ? orig.actual : 0,
                        remaining: m.vdp - (orig ? orig.actual : 0)
                    };
                });
            }

            scenarioMonths = processed.map(m => ({
                month: m.month,
                vdp: m.vdp,
                actual: m.actual || 0,
                remaining: m.remaining || 0,
                margine: m.vdp * margPerc
            }));
        } else {
            // Calculated logic
            const inputs = scenarioInputs[comm.key] || {};
            scenarioMonths = computeCommessa(comm, baseline, inputs).map(m => ({
                ...m,
                actual: 0, // Calculated doesn't have intrinsic actuals unless we say so
                remaining: m.vdp
            }));
        }

        let baseVdpTot = 0, baseMarTot = 0, scenVdpTot = 0, scenMarTot = 0;

        // Aggregate baseline
        for (const m of baseline) {
            if (filters.dateFrom && m.month < filters.dateFrom) continue;
            if (filters.dateTo && m.month > filters.dateTo) continue;
            allMonthsSet.add(m.month);
            if (!baselineAgg[m.month]) baselineAgg[m.month] = { vdp: 0, margine: 0, actual: 0, remaining: 0 };

            const baseMargine = (m.vdpAOP || 0) * (m.marginePerc != null ? m.marginePerc : (comm.margineAOP || 0));

            baselineAgg[m.month].vdp += (m.vdpAOP || 0);
            baselineAgg[m.month].margine += baseMargine;
            baselineAgg[m.month].actual += (m.vdpActual || 0);
            baselineAgg[m.month].remaining += (m.vdpRemaining || 0);

            baseVdpTot += (m.vdpAOP || 0);
            baseMarTot += baseMargine;
        }

        // Aggregate scenario
        for (const m of scenarioMonths) {
            if (filters.dateFrom && m.month < filters.dateFrom) continue;
            if (filters.dateTo && m.month > filters.dateTo) continue;
            allMonthsSet.add(m.month);
            if (!scenarioAgg[m.month]) scenarioAgg[m.month] = { vdp: 0, margine: 0, actual: 0, remaining: 0 };

            scenarioAgg[m.month].vdp += m.vdp;
            scenarioAgg[m.month].margine += m.margine;
            scenarioAgg[m.month].actual += (m.actual || 0);
            scenarioAgg[m.month].remaining += (m.remaining || 0);

            scenVdpTot += m.vdp;
            scenMarTot += m.margine;
        }

        // Effective inputs for export
        const commInputs = scenarioInputs[comm.key] || {};
        let effectiveProbabilita = comm.probabilitaAOP != null ? comm.probabilitaAOP : 1;
        if (comm.type === 'Order Intake' && commInputs.probabilita != null && commInputs.probabilita !== '') {
            effectiveProbabilita = Number(commInputs.probabilita) / 100;
        }
        let effectiveMargine = comm.margineAOP || 0;
        if (commInputs.margine != null && commInputs.margine !== '') {
            effectiveMargine = Number(commInputs.margine) / 100;
        }
        const effectiveType = commInputs.type || comm.type;
        const filteredScenMonths = scenarioMonths.filter(m => {
            if (filters.dateFrom && m.month < filters.dateFrom) return false;
            if (filters.dateTo && m.month > filters.dateTo) return false;
            return true;
        });

        commessaResults.push({
            ...comm,
            baseVdpTot,
            baseMarTot,
            scenVdpTot,
            scenMarTot,
            deltaVdp: scenVdpTot - baseVdpTot,
            deltaMar: scenMarTot - baseMarTot,
            scenarioMonths: filteredScenMonths,
            effectiveProbabilita,
            effectiveMargine,
            effectiveType,
        });
    }

    const allMonths = Array.from(allMonthsSet).sort();

    const monthly = allMonths.map(m => ({
        month: m,
        baselineVDP: (baselineAgg[m] || {}).vdp || 0,
        baselineActual: (baselineAgg[m] || {}).actual || 0,
        baselineRemaining: (baselineAgg[m] || {}).remaining || 0,

        scenarioVDP: (scenarioAgg[m] || {}).vdp || 0,
        scenarioActual: (scenarioAgg[m] || {}).actual || 0,
        scenarioRemaining: (scenarioAgg[m] || {}).remaining || 0,

        baselineMargine: (baselineAgg[m] || {}).margine || 0,
        scenarioMargine: (scenarioAgg[m] || {}).margine || 0,
    }));

    // KPIs
    const totalBaseVDP = monthly.reduce((s, m) => s + m.baselineVDP, 0);
    const totalScenVDP = monthly.reduce((s, m) => s + m.scenarioVDP, 0);
    const totalBaseMar = monthly.reduce((s, m) => s + m.baselineMargine, 0);
    const totalScenMar = monthly.reduce((s, m) => s + m.scenarioMargine, 0);

    return {
        monthly,
        kpis: {
            totalBaseVDP,
            totalScenVDP,
            deltaVDP: totalScenVDP - totalBaseVDP,
            deltaVDPPerc: totalBaseVDP ? ((totalScenVDP - totalBaseVDP) / totalBaseVDP * 100) : 0,
            totalBaseMar,
            totalScenMar,
            deltaMar: totalScenMar - totalBaseMar,
            deltaMarPerc: totalBaseMar ? ((totalScenMar - totalBaseMar) / totalBaseMar * 100) : 0,
        },
        commessaResults,
    };
}

/**
 * Compute multiple scenarios for comparison
 */
export function computeMultiScenario(commesse, monthlyData, scenarioList, filters = {}) {
    return scenarioList.map(scen => ({
        id: scen.id,
        name: scen.name,
        result: computeScenario(commesse, monthlyData, scen, filters),
    }));
}

