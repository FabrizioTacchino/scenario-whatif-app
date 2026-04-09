/**
 * exportManager.js — Export scenario results to Excel/CSV
 */
import * as XLSX from 'xlsx';

/**
 * Format number as EUR-style string
 */
function fmtNum(n) {
    if (n == null) return '';
    return Math.round(n).toLocaleString('it-IT');
}

/**
 * Export an array of row-objects to a single-sheet XLSX file
 * @param {string} filename  — senza estensione
 * @param {Array}  rows      — array di oggetti { colonna: valore }
 */
export function exportChartToExcel(filename, rows) {
    if (!rows || rows.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dati');
    XLSX.writeFile(wb, filename + '.xlsx');
}

/**
 * Export scenario results to XLSX
 */
export function exportToExcel(monthly, commessaResults, scenarioName) {
    const wb = XLSX.utils.book_new();

    // Sheet 1: Monthly data
    const monthlyRows = monthly.map(m => ({
        'Mese': m.month,
        'VDP Baseline': Math.round(m.baselineVDP),
        'VDP Scenario': Math.round(m.scenarioVDP),
        'Delta VDP': Math.round(m.scenarioVDP - m.baselineVDP),
        'Margine Baseline': Math.round(m.baselineMargine),
        'Margine Scenario': Math.round(m.scenarioMargine),
        'Delta Margine': Math.round(m.scenarioMargine - m.baselineMargine),
    }));
    const ws1 = XLSX.utils.json_to_sheet(monthlyRows);
    XLSX.utils.book_append_sheet(wb, ws1, 'Dati Mensili');

    // Sheet 2: Commessa summary
    const commRows = commessaResults.map(c => ({
        'Settore': c.settore,
        'Tipo': c.effectiveType || c.type,
        'Codice': c.codice,
        'Commessa': c.nome,
        'VDP Baseline': Math.round(c.baseVdpTot),
        'VDP Scenario': Math.round(c.scenVdpTot),
        'Delta VDP': Math.round(c.deltaVdp),
        'Margine Baseline': Math.round(c.baseMarTot),
        'Margine Scenario': Math.round(c.scenMarTot),
        'Delta Margine': Math.round(c.deltaMar),
    }));
    const ws2 = XLSX.utils.json_to_sheet(commRows);
    XLSX.utils.book_append_sheet(wb, ws2, 'Per Commessa');

    // Download
    const filename = `Scenario_${scenarioName || 'export'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
}

/**
 * Export in template-compatible layout (re-importable as new baseline)
 * One row per commessa per month, columns matching Baseline_Template.xlsx
 */
export function exportToTemplate(commessaResults, scenarioName) {
    const rows = [];

    for (const comm of commessaResults) {
        const months = comm.scenarioMonths || [];
        const prob = comm.effectiveProbabilita != null ? comm.effectiveProbabilita : (comm.probabilitaAOP != null ? comm.probabilitaAOP : 1);
        const marg = comm.effectiveMargine != null ? comm.effectiveMargine : (comm.margineAOP || 0);

        // scenarioMonths actual/remaining are already weighted by probability.
        // The reimport parser sees "VDP Remaining" → assumes data is at 100% (unweighted)
        // and the engine re-applies the probability. To avoid double-weighting,
        // we must export the unweighted values (divide by prob for Order Intake).
        const isOI = (comm.effectiveType || comm.type) === 'Order Intake';
        const unweightDiv = (isOI && prob > 0) ? prob : 1;

        for (const m of months) {
            const [y, mo] = m.month.split('-').map(Number);
            const dt = new Date(y, mo - 1, 1);

            rows.push({
                'Settore': comm.settore || '',
                'Probabilità': prob,
                'Type': comm.effectiveType || comm.type || '',
                'Codice Commessa': comm.codice || '',
                'Nome Commessa': comm.nome || '',
                'Data': dt,
                'VDP Actual': (m.actual || 0) / unweightDiv,
                'VDP Remaining': (m.remaining || 0) / unweightDiv,
                'Margine a vita Intera': marg,
            });
        }
    }

    if (!rows.length) return;

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows, { cellDates: true });

    ws['!cols'] = [
        { wch: 15 }, // Settore
        { wch: 12 }, // Probabilità
        { wch: 14 }, // Type
        { wch: 18 }, // Codice Commessa
        { wch: 35 }, // Nome Commessa
        { wch: 12 }, // Data
        { wch: 14 }, // VDP Actual
        { wch: 15 }, // VDP Remaining
        { wch: 22 }, // Margine a vita Intera
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Scenario');

    const filename = `Scenario_Template_${scenarioName || 'export'}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
}

/**
 * Export to CSV (monthly data)
 */
export function exportToCSV(monthly, scenarioName) {
    const headers = ['Mese', 'VDP Baseline', 'VDP Scenario', 'Delta VDP', 'Margine Baseline', 'Margine Scenario', 'Delta Margine'];
    const rows = monthly.map(m => [
        m.month,
        Math.round(m.baselineVDP),
        Math.round(m.scenarioVDP),
        Math.round(m.scenarioVDP - m.baselineVDP),
        Math.round(m.baselineMargine),
        Math.round(m.scenarioMargine),
        Math.round(m.scenarioMargine - m.baselineMargine),
    ]);

    let csv = headers.join(';') + '\n';
    for (const row of rows) {
        csv += row.join(';') + '\n';
    }

    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Scenario_${scenarioName || 'export'}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}
