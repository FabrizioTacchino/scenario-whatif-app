/**
 * reportGenerator.js — Genera report PDF A4 con jsPDF + AutoTable + html2canvas
 */
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import html2canvas from 'html2canvas';

// ─── Costanti layout A4 ─────────────────────────────────────
const PAGE_W = 297;   // landscape A4 width mm
const PAGE_H = 210;   // landscape A4 height mm
const MARGIN = 12;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_H = 14;
const FOOTER_H = 10;
const CONTENT_TOP = MARGIN + HEADER_H + 2;
const CONTENT_BOTTOM = PAGE_H - MARGIN - FOOTER_H;

const COLORS = {
    primary:   [16, 185, 129],  // emerald
    danger:    [239, 68, 68],
    warning:   [245, 158, 11],
    text:      [30, 30, 30],
    textLight: [120, 120, 120],
    border:    [200, 200, 200],
    headerBg:  [240, 253, 244],
    white:     [255, 255, 255],
};

// ─── Utilità formattazione ───────────────────────────────────
function fmtEuro(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return n.toLocaleString('it-IT', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtYM(ym) {
    if (!ym) return '—';
    const [y, m] = ym.split('-');
    const mesi = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
    return `${mesi[parseInt(m)-1]} ${y}`;
}

function fmtPerc(n) { return n !== null && n !== undefined ? `${n.toFixed(1)}%` : '—'; }

// ─── Helper PDF ──────────────────────────────────────────────
function addHeader(doc, title, scenarioName, periodo) {
    const page = doc.internal.getNumberOfPages();
    doc.setPage(page);
    doc.setFillColor(...COLORS.primary);
    doc.rect(MARGIN, MARGIN, CONTENT_W, HEADER_H, 'F');
    doc.setTextColor(...COLORS.white);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.text(`Scenario Whatif — ${title}`, MARGIN + 4, MARGIN + 5.5);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.text(`Scenario: ${scenarioName}    |    Periodo: ${periodo}`, MARGIN + 4, MARGIN + 10.5);
}

function addFooter(doc, generatedAt) {
    const pages = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
        doc.setPage(i);
        doc.setFontSize(7);
        doc.setTextColor(...COLORS.textLight);
        doc.text(`Generato il ${generatedAt}`, MARGIN, PAGE_H - MARGIN + 2);
        doc.text(`Pagina ${i} / ${pages}`, PAGE_W - MARGIN, PAGE_H - MARGIN + 2, { align: 'right' });
    }
}

function addSectionTitle(doc, y, title) {
    if (y + 14 > CONTENT_BOTTOM) {
        doc.addPage();
        y = CONTENT_TOP;
    }
    doc.setFillColor(...COLORS.headerBg);
    doc.roundedRect(MARGIN, y, CONTENT_W, 8, 1, 1, 'F');
    doc.setTextColor(...COLORS.primary);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(title, MARGIN + 4, y + 5.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...COLORS.text);
    return y + 11;
}

function addKpiRow(doc, y, kpis) {
    if (y + 12 > CONTENT_BOTTOM) { doc.addPage(); y = CONTENT_TOP; }
    const boxW = 55;
    const gap = 8;
    const startX = MARGIN + (CONTENT_W - (kpis.length * boxW + (kpis.length - 1) * gap)) / 2;
    kpis.forEach((kpi, i) => {
        const x = startX + i * (boxW + gap);
        doc.setDrawColor(...COLORS.border);
        doc.setFillColor(250, 250, 250);
        doc.roundedRect(x, y, boxW, 10, 1.5, 1.5, 'FD');
        doc.setFontSize(6.5);
        doc.setTextColor(...COLORS.textLight);
        doc.text(kpi.label, x + boxW / 2, y + 3.5, { align: 'center' });
        doc.setFontSize(9);
        doc.setTextColor(...(kpi.color || COLORS.text));
        doc.setFont('helvetica', 'bold');
        doc.text(kpi.value, x + boxW / 2, y + 8, { align: 'center' });
        doc.setFont('helvetica', 'normal');
    });
    return y + 14;
}

async function captureChart(selector, maxWidth = CONTENT_W) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const canvas = await html2canvas(el, {
        scale: 2,
        backgroundColor: '#ffffff',
        logging: false,
        useCORS: true,
    });
    const imgData = canvas.toDataURL('image/png');
    const ratio = canvas.width / canvas.height;
    let w = maxWidth;
    let h = w / ratio;
    if (h > CONTENT_BOTTOM - CONTENT_TOP - 10) {
        h = CONTENT_BOTTOM - CONTENT_TOP - 10;
        w = h * ratio;
    }
    return { imgData, w, h };
}

function newPageWithHeader(doc, title, scenarioName, periodo) {
    doc.addPage();
    addHeader(doc, title, scenarioName, periodo);
    return CONTENT_TOP;
}

// ─── Sezione: Copertina ──────────────────────────────────────
function addCover(doc, scenarioName, periodo, sections) {
    doc.setFillColor(...COLORS.primary);
    doc.rect(0, 0, PAGE_W, PAGE_H, 'F');

    doc.setTextColor(...COLORS.white);
    doc.setFontSize(28);
    doc.setFont('helvetica', 'bold');
    doc.text('Scenario Whatif', PAGE_W / 2, 55, { align: 'center' });
    doc.setFontSize(16);
    doc.setFont('helvetica', 'normal');
    doc.text('Report Completo', PAGE_W / 2, 68, { align: 'center' });

    doc.setFontSize(12);
    doc.text(`Scenario: ${scenarioName}`, PAGE_W / 2, 90, { align: 'center' });
    doc.text(`Periodo: ${periodo}`, PAGE_W / 2, 100, { align: 'center' });

    const now = new Date();
    doc.setFontSize(9);
    doc.text(`Generato il ${now.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' })} alle ${now.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`, PAGE_W / 2, 115, { align: 'center' });

    // Sommario
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Contenuto del report:', PAGE_W / 2 - 30, 135);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    sections.forEach((s, i) => {
        doc.text(`${i + 1}. ${s}`, PAGE_W / 2 - 25, 145 + i * 7);
    });
}

// ─── Sezione: Dashboard KPIs ─────────────────────────────────
function addDashboardSection(doc, y, data, scenarioName, periodo) {
    y = addSectionTitle(doc, y, 'Dashboard — KPI Principali');
    const { kpis } = data;
    y = addKpiRow(doc, y, [
        { label: 'VDP Baseline', value: fmtEuro(kpis.totalBaseVDP) },
        { label: 'VDP Scenario', value: fmtEuro(kpis.totalScenVDP) },
        { label: 'Delta VDP', value: `${fmtEuro(kpis.deltaVDP)} (${fmtPerc(kpis.deltaVDPPerc)})`, color: kpis.deltaVDP >= 0 ? COLORS.primary : COLORS.danger },
        { label: 'Margine Scenario', value: fmtEuro(kpis.totalScenMar) },
    ]);
    return y;
}

// ─── Sezione: Dettaglio Scenario (tabella commesse) ──────────
function addScenarioSection(doc, y, data, scenarioName, periodo) {
    y = addSectionTitle(doc, y, 'Dettaglio Scenario — Commesse');

    const rows = data.commessaResults.map(c => [
        c.codice,
        c.nome?.substring(0, 25) || '',
        c.effectiveType || c.tipo || '',
        `${c.effectiveProbabilita ?? c.probabilitaAOP ?? 100}%`,
        fmtEuro(c.baseVdpTot),
        fmtEuro(c.scenVdpTot),
        fmtEuro(c.deltaVdp),
        fmtEuro(c.scenMarTot),
    ]);

    const _at = autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Codice', 'Commessa', 'Tipo', 'Prob.', 'VDP Base', 'VDP Scenario', 'Delta VDP', 'Margine Scen.']],
        body: rows,
        styles: { fontSize: 7, cellPadding: 1.5, textColor: COLORS.text },
        headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold', fontSize: 7 },
        alternateRowStyles: { fillColor: [248, 248, 248] },
        columnStyles: {
            0: { cellWidth: 22 },
            1: { cellWidth: 45 },
            2: { cellWidth: 22 },
            3: { cellWidth: 15, halign: 'center' },
            4: { cellWidth: 30, halign: 'right' },
            5: { cellWidth: 30, halign: 'right' },
            6: { cellWidth: 28, halign: 'right' },
            7: { cellWidth: 30, halign: 'right' },
        },
        didParseCell: (data) => {
            if (data.section === 'body' && data.column.index === 6) {
                const val = parseFloat(data.cell.raw?.replace(/[^-\d,]/g, '').replace(',', '.'));
                if (!isNaN(val) && val < 0) data.cell.styles.textColor = COLORS.danger;
                else if (!isNaN(val) && val > 0) data.cell.styles.textColor = COLORS.primary;
            }
        },
    });

    return (_at?.finalY ?? doc.lastAutoTable?.finalY ?? y) + 4;
}

// ─── Sezione: Economics (costi risorse per commessa) ─────────
function addEconomicsSection(doc, y, resourceData, scenarioName, periodo) {
    y = addSectionTitle(doc, y, 'Economics — Costi Risorse per Commessa');

    const { commesse, persone, allocazioni, dateRange, getEffectiveDates } = resourceData;

    let grandTeorico = 0, grandProb = 0;
    const rows = [];

    for (const commessa of commesse) {
        const commAllocs = allocazioni.filter(a => a.codiceCommessa === commessa.codice);
        if (!commAllocs.length) continue;
        const prob = (commessa.probabilita ?? 100) / 100;
        let costoComm = 0, costoCommProb = 0;

        for (const a of commAllocs) {
            const p = persone.find(x => x.id === a.personaId);
            if (!p) continue;
            const di = a.dataInizio;
            const df = a.dataFine;
            if (!di || !df) continue;
            // Calcola mesi nel range
            let mesi = 0;
            let cur = di;
            while (cur <= df) {
                if ((!dateRange?.from || cur >= dateRange.from) && (!dateRange?.to || cur <= dateRange.to)) mesi++;
                const [yy, mm] = cur.split('-').map(Number);
                const t = yy * 12 + mm;
                cur = `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
            }
            if (mesi === 0) continue;
            const costoMese = (p.costoMedioMese || 0) * a.percentuale / 100;
            costoComm += costoMese * mesi;
            costoCommProb += costoMese * mesi * prob;
        }

        if (costoComm > 0) {
            rows.push([
                commessa.codice,
                commessa.nome?.substring(0, 30) || '',
                `${commessa.probabilita ?? 100}%`,
                `${commAllocs.length}`,
                fmtEuro(costoComm),
                fmtEuro(costoCommProb),
            ]);
            grandTeorico += costoComm;
            grandProb += costoCommProb;
        }
    }

    // Riga totale
    rows.push(['', 'TOTALE', '', '', fmtEuro(grandTeorico), fmtEuro(grandProb)]);

    const _at = autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Codice', 'Commessa', 'Prob.', 'Risorse', 'Costo Personale Allocato', 'Costo Personale Probabilizzato']],
        body: rows,
        styles: { fontSize: 7, cellPadding: 1.5, textColor: COLORS.text },
        headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold', fontSize: 7 },
        alternateRowStyles: { fillColor: [248, 248, 248] },
        columnStyles: {
            0: { cellWidth: 25 },
            1: { cellWidth: 65 },
            2: { cellWidth: 20, halign: 'center' },
            3: { cellWidth: 20, halign: 'center' },
            4: { cellWidth: 45, halign: 'right' },
            5: { cellWidth: 45, halign: 'right' },
        },
        didParseCell: (data) => {
            // Bold last row (totale)
            if (data.section === 'body' && data.row.index === rows.length - 1) {
                data.cell.styles.fontStyle = 'bold';
                data.cell.styles.fillColor = COLORS.headerBg;
            }
        },
    });

    return (_at?.finalY ?? doc.lastAutoTable?.finalY ?? y) + 4;
}

// ─── Sezione: Capacity ───────────────────────────────────────
async function addCapacitySection(doc, y, resourceData, scenarioName, periodo) {
    y = addSectionTitle(doc, y, 'Capacity — Saturazione Team');

    const { persone, matrix, months, kpis } = resourceData;

    // KPIs
    y = addKpiRow(doc, y, [
        { label: 'Persone allocate', value: `${kpis.personeAllocate} / ${persone.length}` },
        { label: 'Costo Personale Allocato', value: fmtEuro(kpis.costoTotale) },
        { label: 'Costo Personale Probabilizzato', value: fmtEuro(kpis.costoProb), color: COLORS.primary },
        { label: 'FTE Equivalenti', value: kpis.fte.toFixed(1) },
    ]);

    // Tabella saturazione per persona (max ~50 colonne mesi visibili)
    const displayMonths = months.length > 24 ? months.slice(0, 24) : months;
    const head = ['Persona', 'Ruolo', ...displayMonths.map(m => m.slice(5) + '\n' + m.slice(2, 4))];

    const rows = persone.map(p => {
        const pMap = matrix.get(p.id);
        const cols = displayMonths.map(mese => {
            const cell = pMap?.get(mese);
            if (!cell || cell.totalePerc === 0) return '—';
            return `${cell.totalePerc}%`;
        });
        return [`${p.cognome} ${p.nome}`, p.ruolo || '—', ...cols];
    });

    const _at = autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [head],
        body: rows,
        styles: { fontSize: 5.5, cellPadding: 1, textColor: COLORS.text, overflow: 'ellipsize' },
        headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold', fontSize: 5, halign: 'center' },
        alternateRowStyles: { fillColor: [248, 248, 248] },
        columnStyles: {
            0: { cellWidth: 35, fontSize: 6 },
            1: { cellWidth: 25, fontSize: 5.5 },
        },
        didParseCell: (data) => {
            if (data.section === 'body' && data.column.index >= 2) {
                data.cell.styles.halign = 'center';
                const val = parseInt(data.cell.raw);
                if (!isNaN(val)) {
                    if (val > 100) data.cell.styles.textColor = COLORS.danger;
                    else if (val === 100) data.cell.styles.textColor = COLORS.primary;
                    else if (val > 0) data.cell.styles.textColor = COLORS.warning;
                }
            }
        },
    });

    return (_at?.finalY ?? doc.lastAutoTable?.finalY ?? y) + 4;
}

// ─── Sezione: Pianificazione ─────────────────────────────────
function addPianificazioneSection(doc, y, resourceData, scenarioName, periodo) {
    y = addSectionTitle(doc, y, 'Pianificazione — Allocazioni Risorse');

    const { persone, allocazioni, commesse, dateRange } = resourceData;

    const rows = allocazioni.map(a => {
        const p = persone.find(x => x.id === a.personaId);
        const c = commesse.find(x => x.codice === a.codiceCommessa);
        const costoMese = p ? (p.costoMedioMese || 0) * a.percentuale / 100 : 0;
        return [
            p ? `${p.cognome} ${p.nome}` : '?',
            p?.ruolo || '—',
            `${a.codiceCommessa}${c ? ' — ' + c.nome?.substring(0, 20) : ''}`,
            `${a.percentuale}%`,
            fmtYM(a.dataInizio),
            fmtYM(a.dataFine),
            costoMese ? fmtEuro(costoMese) : '—',
            a.origine || 'manuale',
        ];
    });

    const _at = autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Persona', 'Ruolo', 'Commessa', '%', 'Da', 'A', 'Costo/Mese', 'Origine']],
        body: rows,
        styles: { fontSize: 7, cellPadding: 1.5, textColor: COLORS.text },
        headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold', fontSize: 7 },
        alternateRowStyles: { fillColor: [248, 248, 248] },
        columnStyles: {
            0: { cellWidth: 40 },
            1: { cellWidth: 30 },
            2: { cellWidth: 60 },
            3: { cellWidth: 15, halign: 'center' },
            4: { cellWidth: 25 },
            5: { cellWidth: 25 },
            6: { cellWidth: 30, halign: 'right' },
            7: { cellWidth: 22, halign: 'center' },
        },
    });

    return (_at?.finalY ?? doc.lastAutoTable?.finalY ?? y) + 4;
}

// ─── Sezione: Anagrafica Persone ─────────────────────────────
function addPersoneSection(doc, y, resourceData) {
    y = addSectionTitle(doc, y, 'Anagrafica Persone');

    const { persone } = resourceData;
    const oggi = new Date().toISOString().slice(0, 7);

    const rows = persone.map(p => {
        const attivo = !p.dataTermine || p.dataTermine.slice(0, 7) >= oggi;
        return [
            `${p.cognome} ${p.nome}`,
            p.ruolo || '—',
            p.bu || '—',
            p.tipoContratto || '—',
            p.costoMedioMese ? fmtEuro(p.costoMedioMese) : '—',
            fmtYM(p.dataAssunzione),
            p.dataTermine ? fmtYM(p.dataTermine) : '—',
            attivo ? 'Attiva' : 'Inattiva',
        ];
    });

    const _at = autoTable(doc, {
        startY: y,
        margin: { left: MARGIN, right: MARGIN },
        head: [['Persona', 'Ruolo', 'BU', 'Contratto', 'Costo/Mese', 'Assunzione', 'Termine', 'Stato']],
        body: rows,
        styles: { fontSize: 7, cellPadding: 1.5, textColor: COLORS.text },
        headStyles: { fillColor: COLORS.primary, textColor: COLORS.white, fontStyle: 'bold', fontSize: 7 },
        alternateRowStyles: { fillColor: [248, 248, 248] },
        columnStyles: {
            0: { cellWidth: 40 },
            1: { cellWidth: 30 },
            2: { cellWidth: 25 },
            3: { cellWidth: 25 },
            4: { cellWidth: 30, halign: 'right' },
            5: { cellWidth: 25 },
            6: { cellWidth: 25 },
            7: { cellWidth: 20, halign: 'center' },
        },
        didParseCell: (data) => {
            if (data.section === 'body' && data.column.index === 7) {
                if (data.cell.raw === 'Inattiva') {
                    data.cell.styles.textColor = COLORS.danger;
                    data.cell.styles.fontStyle = 'bold';
                } else {
                    data.cell.styles.textColor = COLORS.primary;
                }
            }
        },
    });

    return (_at?.finalY ?? doc.lastAutoTable?.finalY ?? y) + 4;
}

// ─── Sezione: Grafici Dashboard (cattura canvas) ─────────────
async function addDashboardCharts(doc, y, scenarioName, periodo) {
    // Cattura i grafici del dashboard se visibili
    const chartSelectors = [
        { sel: '#chart-vdp-monthly', label: 'VDP Mensile' },
        { sel: '#chart-margin-monthly', label: 'Margine Mensile' },
    ];

    for (const { sel, label } of chartSelectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        // Cattura il parent .chart-card per avere anche il titolo
        const card = el.closest('.chart-card') || el;
        try {
            const canvas = await html2canvas(card, {
                scale: 2,
                backgroundColor: '#ffffff',
                logging: false,
            });
            const imgData = canvas.toDataURL('image/png');
            const ratio = canvas.width / canvas.height;
            let imgW = CONTENT_W * 0.85;
            let imgH = imgW / ratio;
            if (imgH > 80) { imgH = 80; imgW = imgH * ratio; }

            if (y + imgH + 5 > CONTENT_BOTTOM) {
                doc.addPage();
                addHeader(doc, 'Dashboard — Grafici', scenarioName, periodo);
                y = CONTENT_TOP;
            }
            doc.addImage(imgData, 'PNG', MARGIN + (CONTENT_W - imgW) / 2, y, imgW, imgH);
            y += imgH + 5;
        } catch (e) {
            // silently skip failed chart capture
        }
    }
    return y;
}

// ─── Entry Point ─────────────────────────────────────────────
/**
 * @param {object} options
 * @param {object} options.scenarioData - { kpis, monthly, commessaResults }
 * @param {object} options.resourceData - { persone, allocazioni, commesse, matrix, months, kpis, dateRange }
 * @param {string} options.scenarioName
 * @param {string} options.periodo
 * @param {object} options.sections - { dashboard, scenario, economics, capacity, pianificazione, persone }
 * @param {function} options.onProgress - callback(pct, msg)
 */
export async function generateReport(options) {
    const { scenarioData, resourceData, scenarioName, periodo, sections, onProgress } = options;

    const progress = (pct, msg) => { if (onProgress) onProgress(pct, msg); };

    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    // Determina sezioni attive per sommario
    const sectionNames = [];
    if (sections.dashboard) sectionNames.push('Dashboard');
    if (sections.scenario) sectionNames.push('Dettaglio Scenario');
    if (sections.economics) sectionNames.push('Economics');
    if (sections.capacity) sectionNames.push('Capacity');
    if (sections.pianificazione) sectionNames.push('Pianificazione');
    if (sections.persone) sectionNames.push('Anagrafica Persone');

    // Copertina
    progress(5, 'Generazione copertina...');
    addCover(doc, scenarioName, periodo, sectionNames);

    const totalSections = sectionNames.length;
    let done = 0;

    // Dashboard
    if (sections.dashboard && scenarioData) {
        progress(10, 'Sezione Dashboard...');
        let y = newPageWithHeader(doc, 'Dashboard', scenarioName, periodo);
        y = addDashboardSection(doc, y, scenarioData, scenarioName, periodo);

        // Prova a catturare grafici se tab dashboard è visibile
        const dashTab = document.querySelector('#tab-dashboard');
        if (dashTab?.classList.contains('active')) {
            y = await addDashboardCharts(doc, y, scenarioName, periodo);
        }
        done++;
    }

    // Dettaglio Scenario
    if (sections.scenario && scenarioData) {
        progress(10 + (done / totalSections) * 70, 'Sezione Scenario...');
        let y = newPageWithHeader(doc, 'Dettaglio Scenario', scenarioName, periodo);
        y = addScenarioSection(doc, y, scenarioData, scenarioName, periodo);
        done++;
    }

    // Economics
    if (sections.economics && resourceData) {
        progress(10 + (done / totalSections) * 70, 'Sezione Economics...');
        let y = newPageWithHeader(doc, 'Economics', scenarioName, periodo);
        y = addEconomicsSection(doc, y, resourceData, scenarioName, periodo);
        done++;
    }

    // Capacity
    if (sections.capacity && resourceData) {
        progress(10 + (done / totalSections) * 70, 'Sezione Capacity...');
        let y = newPageWithHeader(doc, 'Capacity', scenarioName, periodo);
        y = await addCapacitySection(doc, y, resourceData, scenarioName, periodo);
        done++;
    }

    // Pianificazione
    if (sections.pianificazione && resourceData) {
        progress(10 + (done / totalSections) * 70, 'Sezione Pianificazione...');
        let y = newPageWithHeader(doc, 'Pianificazione', scenarioName, periodo);
        y = addPianificazioneSection(doc, y, resourceData, scenarioName, periodo);
        done++;
    }

    // Persone
    if (sections.persone && resourceData) {
        progress(10 + (done / totalSections) * 70, 'Sezione Anagrafica Persone...');
        let y = newPageWithHeader(doc, 'Anagrafica Persone', scenarioName, periodo);
        y = addPersoneSection(doc, y, resourceData);
        done++;
    }

    // Footer su tutte le pagine
    progress(90, 'Aggiunta footer...');
    const generatedAt = new Date().toLocaleDateString('it-IT', {
        day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    addFooter(doc, generatedAt);

    // Salva
    progress(95, 'Salvataggio PDF...');
    const dateStr = new Date().toISOString().slice(0, 10);
    doc.save(`whatif-report-${scenarioName.replace(/\s+/g, '_')}-${dateStr}.pdf`);

    progress(100, 'Report generato!');
}
