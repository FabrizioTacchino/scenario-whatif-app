/**
 * dataLoader.js — Parse Excel file and build structured dataset
 */
import * as XLSX from 'xlsx';

/**
 * Column name normalization map
 */
const COL_MAP = {
  'settore': 'settore',
  'probabilità': 'probabilitaAOP',
  'probabilita': 'probabilitaAOP',
  'type': 'type',
  'codice commessa': 'codice',
  'nome commessa': 'nome',
  'data': 'data',
  'vdp da aop': 'vdpAOP',
  'margine a vita intera aop': 'margineAOP',
  'margine a vita intera': 'margineAOP',
  'sil actual': 'silActual',
  'vdp actual': 'silActual',
  'sil remaining': 'silRemaining',
  'vdp remaining': 'silRemaining',
  'shiftstart_mesi (whatif)': 'shiftStartFile',
  'margine a vita intera (whatif)': 'margineWhatifFile',
  'probabilità (whatif)': 'probabilitaWhatifFile',
  'probabilita (whatif)': 'probabilitaWhatifFile',
  'ritardo_fine_mesi (whatif)': 'ritardoFile',
  'allungamento_mesi (whatif)': 'ritardoFile',
};

function normalizeHeader(h) {
  if (!h) return null;
  const lower = String(h).toLowerCase().trim();
  return COL_MAP[lower] || null;
}

/**
 * Parse a date value from Excel
 */
function parseDate(val) {
  if (!val) return null;
  if (val instanceof Date) return val;
  if (typeof val === 'number') {
    // Excel serial date
    const d = XLSX.SSF.parse_date_code(val);
    return new Date(d.y, d.m - 1, d.d);
  }
  return new Date(val);
}

/**
 * Build a unique key for a commessa (codice + nome combined for safety)
 */
function commessaKey(codice, nome) {
  return `${codice || ''}|||${nome || ''}`;
}

/**
 * Format a date to "YYYY-MM" string
 */
export function dateToMonth(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Parse uploaded file buffer -> structured data
 * Returns { commesse, monthlyData, allMonths, filters }
 */
/**
 * Parse uploaded file buffer -> structured data
 * Returns { commesse, monthlyData, allMonths, filters }
 */
export function parseExcel(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });

  // Try to find a sheet with "AOP" or "TOTALE" in the name, fallback to first
  const sheetName = wb.SheetNames.find(n => n.includes('AOP') || n.includes('TOTALE')) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null });

  if (!rawRows.length) throw new Error('Il file Excel è vuoto.');

  // Map headers
  const rawHeaders = Object.keys(rawRows[0]);
  const headerMap = {};
  for (const rh of rawHeaders) {
    const mapped = normalizeHeader(rh);
    if (mapped) headerMap[rh] = mapped;
  }

  // Parse rows
  const commessaMap = new Map(); // key -> commessa info
  const monthlyMap = new Map();  // key -> [{month, vdpAOP, vdpActual, vdpRemaining, ...}]

  const allMonthsSet = new Set();
  const settoriSet = new Set();
  const typesSet = new Set();

  for (const raw of rawRows) {
    const row = {};
    for (const [rh, mapped] of Object.entries(headerMap)) {
      row[mapped] = raw[rh];
    }

    const codice = row.codice ? String(row.codice).trim() : '';
    const nome = row.nome ? String(row.nome).trim() : '';
    if (!codice && !nome) continue;

    const key = commessaKey(codice, nome);
    const dt = parseDate(row.data);
    const month = dateToMonth(dt);
    if (month) allMonthsSet.add(month);

    const settore = row.settore ? String(row.settore).trim() : '';
    const type = row.type ? String(row.type).trim() : '';
    settoriSet.add(settore);
    if (type) typesSet.add(type);

    // Build commessa entry
    if (!commessaMap.has(key)) {
      commessaMap.set(key, {
        key,
        codice,
        nome,
        settore,
        type: type || 'Backlog',
        probabilitaAOP: row.probabilitaAOP != null ? Number(row.probabilitaAOP) : 1,
        margineAOP: null,
        vdpTotale: 0
      });

    }
    const commessa = commessaMap.get(key);
    if (!commessa.type && type) commessa.type = type;

    // Monthly data
    if (!monthlyMap.has(key)) monthlyMap.set(key, []);

    let vdpAOP = row.vdpAOP != null ? Number(row.vdpAOP) : 0;
    const silActual = row.silActual != null ? Number(row.silActual) : 0;
    const silRemaining = row.silRemaining != null ? Number(row.silRemaining) : 0;

    // Fallback: if vdpAOP is 0 but we have actual/remaining, use their sum as baseline
    if (vdpAOP === 0 && (silActual !== 0 || silRemaining !== 0)) {
      vdpAOP = silActual + silRemaining;
    }

    const margPerc = row.margineAOP != null ? Number(row.margineAOP) : null;

    if (margPerc != null && commessa.margineAOP == null) {
      commessa.margineAOP = margPerc;
    }

    commessa.vdpTotale += vdpAOP;

    monthlyMap.get(key).push({
      month,
      date: dt,
      vdpAOP: vdpAOP,
      vdpActual: silActual,
      vdpRemaining: silRemaining,
      marginePerc: margPerc,

      // File-provided what-if values
      shiftStartFile: row.shiftStartFile != null ? Number(row.shiftStartFile) : null,
      margineWhatifFile: row.margineWhatifFile != null ? Number(row.margineWhatifFile) : null,
      probabilitaWhatifFile: row.probabilitaWhatifFile != null ? Number(row.probabilitaWhatifFile) : null,
      ritardoFile: row.ritardoFile != null ? Number(row.ritardoFile) : null,
    });
  }

  // Sort and finalize
  for (const [key, months] of monthlyMap) {
    months.sort((a, b) => (a.date || 0) - (b.date || 0));
  }
  for (const c of commessaMap.values()) {
    if (c.margineAOP == null) c.margineAOP = 0;
  }

  return {
    commesse: Array.from(commessaMap.values()).sort((a, b) => a.codice.localeCompare(b.codice)),
    monthlyData: monthlyMap,
    allMonths: Array.from(allMonthsSet).sort(),
    filters: {
      settori: Array.from(settoriSet).filter(Boolean).sort(),
      types: Array.from(typesSet).filter(Boolean).sort(),
    },
  };
}

/**
 * Parse an Excel file for an "Imported Scenario"
 * Returns { [commessaKey]: [{month, actual, remaining}] }
 */
export function parseImportedScenario(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('scen') || n.toLowerCase().includes('agg') || n.toLowerCase().includes('upd')) || wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null });

  if (!rawRows.length) return {};

  const rawHeaders = Object.keys(rawRows[0]);
  const headerMap = {};
  for (const rh of rawHeaders) {
    const mapped = normalizeHeader(rh);
    if (mapped) headerMap[rh] = mapped;
  }

  const result = {};
  const typeFromFile = {};
  const inputOverrides = {}; // { key: { probabilita, margine } } — valori in % (0-100)

  for (const raw of rawRows) {
    const row = {};
    for (const [rh, mapped] of Object.entries(headerMap)) {
      row[mapped] = raw[rh];
    }
    const codice = row.codice ? String(row.codice).trim() : '';
    const nome = row.nome ? String(row.nome).trim() : '';
    if (!codice && !nome) continue;

    const key = commessaKey(codice, nome);
    const dt = parseDate(row.data);
    const month = dateToMonth(dt);
    if (!month) continue;

    const actual = row.silActual != null ? Number(row.silActual) : 0;
    const remaining = row.silRemaining != null ? Number(row.silRemaining) : 0;

    // Capture first non-empty type value per commessa key
    if (!typeFromFile[key] && row.type) {
      typeFromFile[key] = String(row.type).trim();
    }

    // Capture WhatIf probability and margin overrides (prima riga valida per commessa).
    // Il file scenario può avere colonne esplicite "*(WhatIf)" oppure le stesse colonne
    // dell'AOP ("Probabilità", "Margine a vita Intera AOP") usate però con i valori scenario.
    if (!inputOverrides[key]) {
      const ov = {};
      // Probabilità: colonna WhatIf esplicita, altrimenti colonna standard del file scenario
      const rawProb = row.probabilitaWhatifFile ?? row.probabilitaAOP;
      if (rawProb != null && rawProb !== '') {
        const n = Number(rawProb);
        ov.probabilita = n <= 1 ? Math.round(n * 100) : Math.round(n);
      }
      // Margine: colonna WhatIf esplicita, altrimenti colonna standard del file scenario
      const rawMargine = row.margineWhatifFile ?? row.margineAOP;
      if (rawMargine != null && rawMargine !== '') {
        const n = Number(rawMargine);
        ov.margine = n <= 1 ? parseFloat((n * 100).toFixed(2)) : parseFloat(n.toFixed(2));
      }
      if (Object.keys(ov).length) inputOverrides[key] = ov;
    }

    if (!result[key]) result[key] = [];
    result[key].push({ month, actual, remaining });
  }

  return { monthlyData: result, typeFromFile, inputOverrides };
}


