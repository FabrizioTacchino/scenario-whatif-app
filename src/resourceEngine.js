/**
 * resourceEngine.js — Calcoli risorse: saturazione, costi, FTE
 * Completamente separato dalla logica scenari esistente.
 */

import { listAllocazioni, listPersone, getMonthsInRange, addMonths } from './resourceManager.js';

/**
 * Matrice mensile completa per uno scenario.
 * Restituisce: Map<personaId, Map<mese, CellData>>
 * CellData: { allocazioni[], totalePerc, costoTotale, costoProb, fte, saturazione }
 */
/**
 * Risolve le date effettive di un'allocazione tenendo conto dei flag di aggancio.
 * @param {object} alloc
 * @param {function} getEffectiveDates - _ctx.getEffectiveCommessaDates
 */
function _resolveAllocDates(alloc, getEffectiveDates) {
    if (!getEffectiveDates || (!alloc.aggancioInizio && !alloc.aggancioFine)) {
        return { di: alloc.dataInizio, df: alloc.dataFine };
    }
    const eff = getEffectiveDates(alloc.codiceCommessa);
    const applyDelta = (ym, delta) => (delta && ym) ? addMonths(ym, delta) : ym;
    return {
        di: alloc.aggancioInizio && eff?.dataInizio
            ? applyDelta(eff.dataInizio, alloc.deltaInizio || 0)
            : alloc.dataInizio,
        df: alloc.aggancioFine && eff?.dataFine
            ? applyDelta(eff.dataFine, alloc.deltaFine || 0)
            : alloc.dataFine,
    };
}

export function computeResourceMatrix(scenarioId, commesse = [], months = [], getEffectiveDates = null) {
    const allocazioni = listAllocazioni({ scenarioId });
    const persone = listPersone();
    const matrix = new Map();

    for (const alloc of allocazioni) {
        const persona = persone.find(p => p.id === alloc.personaId);
        if (!persona) continue;

        const { di, df } = _resolveAllocDates(alloc, getEffectiveDates);
        if (!di || !df) continue;

        // Limite contratto: non contare costi fuori dal periodo di assunzione della persona
        const assunzione = persona.dataAssunzione ? persona.dataAssunzione.slice(0, 7) : null;
        const termine = persona.dataTermine ? persona.dataTermine.slice(0, 7) : null;

        const commessa = commesse.find(c => c.codice === alloc.codiceCommessa);
        const prob = commessa ? ((commessa.probabilita ?? 100) / 100) : 1;
        const costo = persona.costoMedioMese || 0;
        const perc = alloc.percentuale / 100;

        if (!matrix.has(alloc.personaId)) matrix.set(alloc.personaId, new Map());
        const pMap = matrix.get(alloc.personaId);

        for (const mese of getMonthsInRange(di, df)) {
            if (months.length && !months.includes(mese)) continue;
            if (assunzione && mese < assunzione) continue; // persona non ancora assunta, skip
            if (termine && mese > termine) continue; // persona cessata, skip
            if (!pMap.has(mese)) {
                pMap.set(mese, { allocazioni: [], totalePerc: 0, costoTotale: 0, costoProb: 0, fte: 0, saturazione: 'ok' });
            }
            const cell = pMap.get(mese);
            cell.allocazioni.push({
                allocazioneId: alloc.id,
                codiceCommessa: alloc.codiceCommessa,
                nomeCommessa: commessa?.nome || alloc.codiceCommessa,
                tipo: commessa?.tipo || '',
                percentuale: alloc.percentuale,
                costo: costo * perc,
                costoProb: costo * perc * prob,
            });
            cell.totalePerc += alloc.percentuale;
            cell.costoTotale += costo * perc;
            cell.costoProb += costo * perc * prob;
            cell.fte += perc;
        }
    }

    // Assign saturation status
    for (const [, pMap] of matrix) {
        for (const [, cell] of pMap) {
            if (cell.totalePerc === 0) cell.saturazione = 'disponibile';
            else if (cell.totalePerc < 100) cell.saturazione = 'sotto';
            else if (cell.totalePerc === 100) cell.saturazione = 'ok';
            else cell.saturazione = 'sovra';
        }
    }

    return matrix;
}

/**
 * Saturazione aggregata mensile.
 * Restituisce: { [mese]: { disponibile, sotto, ok, sovra, totale } }
 */
export function computeSaturationSummary(matrix, months, persone) {
    const totalPersone = persone.length;
    const summary = {};
    for (const mese of months) {
        summary[mese] = { disponibile: 0, sotto: 0, ok: 0, sovra: 0, totale: totalPersone };
    }
    for (const [personaId, pMap] of matrix) {
        for (const mese of months) {
            if (!summary[mese]) continue;
            const cell = pMap.get(mese);
            summary[mese][cell ? cell.saturazione : 'disponibile']++;
        }
    }
    // Persons not in matrix at all → disponibile
    for (const p of persone) {
        if (!matrix.has(p.id)) {
            for (const mese of months) {
                if (summary[mese]) summary[mese].disponibile++;
            }
        }
    }
    return summary;
}

/**
 * Dati risorse aggregati per una singola commessa.
 * Restituisce: Map<mese, { persone[], fte, costo, costoProb }>
 */
export function computeCommessaResources(codiceCommessa, scenarioId, commesse) {
    const allocazioni = listAllocazioni({ codiceCommessa, scenarioId });
    const persone = listPersone();
    const commessa = commesse.find(c => c.codice === codiceCommessa);
    const prob = commessa ? ((commessa.probabilita ?? 100) / 100) : 1;
    const byMonth = new Map();

    for (const alloc of allocazioni) {
        const persona = persone.find(p => p.id === alloc.personaId);
        if (!persona || !alloc.dataInizio || !alloc.dataFine) continue;
        const costo = persona.costoMedioMese || 0;
        const perc = alloc.percentuale / 100;

        for (const mese of getMonthsInRange(alloc.dataInizio, alloc.dataFine)) {
            if (!byMonth.has(mese)) byMonth.set(mese, { persone: [], fte: 0, costo: 0, costoProb: 0 });
            const cell = byMonth.get(mese);
            cell.persone.push({
                personaId: alloc.personaId,
                nome: `${persona.cognome} ${persona.nome}`,
                ruolo: persona.ruolo,
                percentuale: alloc.percentuale,
                costo: costo * perc,
            });
            cell.fte += perc;
            cell.costo += costo * perc;
            cell.costoProb += costo * perc * prob;
        }
    }

    return byMonth;
}

/**
 * KPI globali risorse per uno scenario.
 */
export function computeResourceKpis(matrix, months) {
    let costoTotale = 0, costoProb = 0, fte = 0, personeAllocate = 0;
    for (const [, pMap] of matrix) {
        let allocata = false;
        for (const [mese, cell] of pMap) {
            if (!months.length || months.includes(mese)) {
                costoTotale += cell.costoTotale;
                costoProb += cell.costoProb;
                fte += cell.fte;
                if (cell.totalePerc > 0) allocata = true;
            }
        }
        if (allocata) personeAllocate++;
    }
    return { costoTotale, costoProb, fte, personeAllocate };
}

const DEFAULT_DATA_TERMINE = '2030-12';

/**
 * Costo Personale Totale: costoMedioMese × mesi sotto contratto nel periodo.
 * Per persone senza dataTermine, usa 2030-12 come default.
 * Restituisce: { costoPersonaleTotale, mesiPersonaTotali, dettaglio: Map<personaId, { mesi, costo }> }
 */
export function computeCostoPersonaleTotale(persone, months) {
    if (!months.length) return { costoPersonaleTotale: 0, mesiPersonaTotali: 0, dettaglio: new Map(), costoAttivi: 0, costoInIngresso: 0, costoDaRicercare: 0 };

    const firstMonth = months[0];
    const oggi = new Date().toISOString().slice(0, 7);

    let costoPersonaleTotale = 0;
    let mesiPersonaTotali = 0;
    let costoAttivi = 0;
    let costoInIngresso = 0;
    let costoDaRicercare = 0;
    const dettaglio = new Map();

    for (const p of persone) {
        const da = p.dataAssunzione ? p.dataAssunzione.slice(0, 7) : firstMonth;
        const a = p.dataTermine ? p.dataTermine.slice(0, 7) : DEFAULT_DATA_TERMINE;

        let mesiContratto = 0;
        for (const mese of months) {
            if (mese >= da && mese <= a) {
                mesiContratto++;
            }
        }

        const costo = (p.costoMedioMese || 0) * mesiContratto;
        costoPersonaleTotale += costo;
        mesiPersonaTotali += mesiContratto;
        dettaglio.set(p.id, { mesi: mesiContratto, costo });

        // Breakdown per stato assunzione (solo persone future)
        if (da > oggi) {
            const stato = p.statoAssunzione || 'assunta';
            if (stato === 'in_ingresso') costoInIngresso += costo;
            else if (stato === 'da_ricercare') costoDaRicercare += costo;
            else costoAttivi += costo; // assunta con data futura = confermata
        } else {
            costoAttivi += costo;
        }
    }

    return { costoPersonaleTotale, mesiPersonaTotali, dettaglio, costoAttivi, costoInIngresso, costoDaRicercare };
}

/**
 * Costo personale mensilizzato: per ogni mese, somma dei costoMedioMese
 * delle persone sotto contratto in quel mese.
 * Include anche chi viene assunto e chi cessa in quel mese specifico.
 */
export function computeCostoPersonaleMensile(persone, months) {
    const result = new Map();
    const firstMonth = months[0] || '';

    for (const mese of months) {
        let costoMese = 0;
        let numPersone = 0;
        const assunte = [];
        const cessate = [];

        for (const p of persone) {
            const da = p.dataAssunzione ? p.dataAssunzione.slice(0, 7) : firstMonth;
            const a = p.dataTermine ? p.dataTermine.slice(0, 7) : DEFAULT_DATA_TERMINE;
            if (mese >= da && mese <= a) {
                costoMese += (p.costoMedioMese || 0);
                numPersone++;
            }
            // Persona assunta questo mese (dataAssunzione inizia con questo mese)
            if (p.dataAssunzione && p.dataAssunzione.substring(0, 7) === mese) {
                assunte.push(`${p.cognome || ''} ${p.nome || ''}`.trim() || p.id);
            }
            // Persona cessata questo mese (dataTermine cade in questo mese)
            if (p.dataTermine && p.dataTermine.substring(0, 7) === mese) {
                cessate.push(`${p.cognome || ''} ${p.nome || ''}`.trim() || p.id);
            }
        }
        result.set(mese, { costo: costoMese, numPersone, assunte, cessate });
    }
    return result;
}
