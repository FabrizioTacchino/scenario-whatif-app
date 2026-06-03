"""
Script per generare la relazione Word "Analisi Scenari VDP - Scenario What-If"
"""
from docx import Document
from docx.shared import Pt, Cm, RGBColor, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.enum.table import WD_ALIGN_VERTICAL, WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

doc = Document()

# ─── Configurazione pagina ──────────────────────────────────────
for section in doc.sections:
    section.top_margin = Cm(2.5)
    section.bottom_margin = Cm(2.5)
    section.left_margin = Cm(2.5)
    section.right_margin = Cm(2.5)

# ─── Stili ──────────────────────────────────────────────────────
styles = doc.styles

# Body text
normal = styles['Normal']
normal.font.name = 'Calibri'
normal.font.size = Pt(11)
normal.paragraph_format.space_after = Pt(6)
normal.paragraph_format.line_spacing = 1.15

# Heading 1
h1 = styles['Heading 1']
h1.font.name = 'Cambria'
h1.font.size = Pt(20)
h1.font.bold = True
h1.font.color.rgb = RGBColor(0x1F, 0x4E, 0x79)
h1.paragraph_format.space_before = Pt(18)
h1.paragraph_format.space_after = Pt(12)

# Heading 2
h2 = styles['Heading 2']
h2.font.name = 'Cambria'
h2.font.size = Pt(15)
h2.font.bold = True
h2.font.color.rgb = RGBColor(0x2E, 0x74, 0xB5)
h2.paragraph_format.space_before = Pt(14)
h2.paragraph_format.space_after = Pt(8)

# Heading 3
h3 = styles['Heading 3']
h3.font.name = 'Cambria'
h3.font.size = Pt(12)
h3.font.bold = True
h3.font.color.rgb = RGBColor(0x2E, 0x74, 0xB5)
h3.paragraph_format.space_before = Pt(10)
h3.paragraph_format.space_after = Pt(6)


def add_image_placeholder(text):
    """Placeholder per immagini, in corsivo centrato con bordo grigio."""
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(f"[ INSERIRE IMMAGINE: {text} ]")
    r.italic = True
    r.font.color.rgb = RGBColor(0x80, 0x80, 0x80)
    r.font.size = Pt(10)
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(8)
    return p


def add_info_box(title, lines):
    """Box informativo con bordo."""
    table = doc.add_table(rows=1, cols=1)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    cell = table.rows[0].cells[0]
    # Sfondo
    shading = OxmlElement('w:shd')
    shading.set(qn('w:fill'), 'EEF5FF')
    cell._tc.get_or_add_tcPr().append(shading)
    # Bordi
    tcPr = cell._tc.get_or_add_tcPr()
    tcBorders = OxmlElement('w:tcBorders')
    for edge in ('top', 'left', 'bottom', 'right'):
        border = OxmlElement(f'w:{edge}')
        border.set(qn('w:val'), 'single')
        border.set(qn('w:sz'), '12')
        border.set(qn('w:color'), '2E74B5')
        tcBorders.append(border)
    tcPr.append(tcBorders)

    p_title = cell.paragraphs[0]
    r = p_title.add_run(title)
    r.bold = True
    r.font.size = Pt(11)
    r.font.color.rgb = RGBColor(0x1F, 0x4E, 0x79)

    for line in lines:
        p = cell.add_paragraph()
        p.add_run(line).font.size = Pt(10)
    doc.add_paragraph()


def add_bullets(items):
    for item in items:
        doc.add_paragraph(item, style='List Bullet')


def add_numbered(items):
    for item in items:
        doc.add_paragraph(item, style='List Number')


def add_table(headers, rows, col_widths=None):
    table = doc.add_table(rows=1 + len(rows), cols=len(headers))
    table.style = 'Light Grid Accent 1'
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = table.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ''
        p = hdr[i].paragraphs[0]
        r = p.add_run(h)
        r.bold = True
        r.font.size = Pt(10)
    for i, row in enumerate(rows):
        cells = table.rows[i + 1].cells
        for j, v in enumerate(row):
            cells[j].text = ''
            p = cells[j].paragraphs[0]
            run = p.add_run(str(v))
            run.font.size = Pt(10)
    if col_widths:
        for row in table.rows:
            for i, w in enumerate(col_widths):
                row.cells[i].width = Cm(w)
    doc.add_paragraph()
    return table


def para(text, bold=False, italic=False, align=None, size=None):
    p = doc.add_paragraph()
    if align:
        p.alignment = align
    r = p.add_run(text)
    if bold:
        r.bold = True
    if italic:
        r.italic = True
    if size:
        r.font.size = Pt(size)
    return p


def page_break():
    doc.add_page_break()


# ─── FRONTESPIZIO ──────────────────────────────────────────────
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(120)
r = p.add_run("ANALISI SCENARI VDP")
r.bold = True
r.font.size = Pt(32)
r.font.color.rgb = RGBColor(0x1F, 0x4E, 0x79)
r.font.name = 'Cambria'

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("Scenario What-If")
r.font.size = Pt(22)
r.font.color.rgb = RGBColor(0x2E, 0x74, 0xB5)
r.italic = True
r.font.name = 'Cambria'

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(40)
r = p.add_run("Relazione di Progetto")
r.font.size = Pt(16)
r.font.name = 'Cambria'

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(80)
r = p.add_run("Destinatario: Amministratore Delegato")
r.font.size = Pt(12)

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("Impresa B4T")
r.font.size = Pt(14)
r.bold = True

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(40)
r = p.add_run("Versione del software: 1.0.69")
r.font.size = Pt(11)
r.italic = True

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("Stato: In esercizio operativo")
r.font.size = Pt(11)
r.italic = True

add_image_placeholder("Logo Impresa B4T / screenshot principale dell'applicazione")

page_break()

# ─── INDICE ────────────────────────────────────────────────────
doc.add_heading("Indice", level=1)
indice = [
    "1. Executive Summary",
    "2. Contesto e Necessità Aziendale",
    "3. Obiettivi del Progetto",
    "4. Architettura Tecnica",
    "5. Modello Dati e Dominio",
    "6. Funzionalità Principali",
    "7. Sicurezza e Affidabilità dei Dati",
    "8. Metodologia di Sviluppo e Ciclo di Vita",
    "9. Risultati e Benefici Attesi",
    "10. Roadmap Futura",
    "11. Conclusioni",
    "12. Appendice — Glossario tecnico essenziale",
]
for v in indice:
    p = doc.add_paragraph(v)
    p.paragraph_format.space_after = Pt(4)

page_break()

# ─── 1. EXECUTIVE SUMMARY ──────────────────────────────────────
doc.add_heading("1. Executive Summary", level=1)

para(
    "L'applicazione Analisi Scenari VDP — Scenario What-If è uno strumento di pianificazione e "
    "simulazione finanziaria sviluppato internamente per supportare le decisioni della Direzione, "
    "del Commerciale, dell'ufficio Risorse Umane e del Project Management di Impresa B4T. "
    "Il software consente di analizzare in tempo reale l'impatto economico e organizzativo di "
    "scenari alternativi sul portafoglio commesse, integrando in un'unica piattaforma le anagrafiche "
    "delle risorse umane, le allocazioni di personale ai cantieri, i costi di personale, le probabilità "
    "di acquisizione delle commesse in pipeline e la capacità produttiva del team."
)

para("In sintesi, il progetto ha consentito di:")

add_bullets([
    "Centralizzare in un unico database condiviso, accessibile in tempo reale da più utenti, "
    "le informazioni che fino ad oggi risiedevano in fogli Excel sparsi tra reparti diversi, "
    "con tutti i rischi di disallineamento, duplicazione e perdita di dati che ne derivavano.",

    "Simulare scenari \"what-if\" sul portafoglio commesse, modificando in pochi click parametri "
    "come la probabilità di acquisizione di una commessa, le date di inizio e fine, l'allocazione "
    "di risorse, e ottenere immediatamente i nuovi KPI economici (costo personale, FTE equivalenti, "
    "saturazione, copertura ruoli).",

    "Sincronizzare le modifiche in tempo reale tra tutti gli utenti collegati, grazie a un'architettura "
    "cloud-ibrida che combina funzionamento offline-first con replicazione istantanea su server "
    "centralizzato.",

    "Erogare il servizio a costo infrastrutturale zero, sfruttando il piano gratuito del provider "
    "cloud Supabase, senza alcun impatto sul budget IT.",
])

para(
    "Il software è attualmente in esercizio, distribuito a un team multidisciplinare di utenti, "
    "e viene aggiornato in modo continuo sulla base del feedback raccolto sul campo."
)

add_image_placeholder("Schermata principale dell'app con vista dashboard / scenari")

page_break()

# ─── 2. CONTESTO ───────────────────────────────────────────────
doc.add_heading("2. Contesto e Necessità Aziendale", level=1)

doc.add_heading("2.1 Premessa", level=2)
para(
    "Impresa B4T opera in un settore — quello delle costruzioni — caratterizzato da una complessità "
    "organizzativa crescente: portafogli commesse sempre più articolati, marginalità da difendere, "
    "vincoli di personale qualificato sempre più stringenti, e una competizione che impone decisioni "
    "rapide e basate su dati affidabili. In questo contesto, la capacità di rispondere alla domanda "
    "\"cosa succede se...\" diventa un vantaggio competitivo: cosa succede ai conti se acquisiamo "
    "questa commessa? Se ne perdiamo un'altra? Se i tempi slittano? Se assumiamo questa figura? "
    "Se redistribuiamo il personale tra i cantieri?"
)
para(
    "Fino allo sviluppo di questo strumento, ogni risposta a queste domande comportava un lavoro "
    "manuale, ripetitivo e soggetto a errore: aprire più file Excel, copiare dati, creare colonne "
    "di calcolo, confrontare versioni, allineare reparti. Un processo che assorbiva ore di lavoro "
    "qualificato ogni volta che la Direzione aveva bisogno di una valutazione economico-organizzativa."
)

doc.add_heading("2.2 Stato dell'arte precedente", level=2)
para(
    "Prima dell'introduzione del software, il processo di analisi degli scenari presentava le "
    "seguenti caratteristiche:"
)
add_table(
    ["Aspetto", "Stato precedente"],
    [
        ["Strumento principale", "Fogli Excel multipli, distribuiti via mail o cartelle condivise"],
        ["Custodia dei dati", "Frammentata tra Direzione, HR, Commerciale, PM"],
        ["Allineamento tra reparti", "Manuale, asincrono, soggetto a errori"],
        ["Possibilità di simulare scenari alternativi", "Molto limitata, richiedeva duplicazione di file"],
        ["Tracciabilità delle modifiche", "Assente o affidata alla memoria personale"],
        ["Tempo medio per produrre uno scenario alternativo", "Da diverse ore a giornate intere"],
        ["Rischio di lavorare su versioni disallineate", "Alto"],
        ["Visibilità in tempo reale dello stato risorse", "Inesistente"],
    ]
)

para("I limiti più critici emersi nella prassi quotidiana erano in particolare:")
add_numbered([
    "Duplicazione dei dati tra reparti. L'anagrafica delle persone era replicata in più file Excel, "
    "ognuno con piccole varianti (nomi scritti in modo diverso, codici fiscali mancanti, costi di "
    "personale aggiornati in un file ma non negli altri).",

    "Scollamento temporale tra le informazioni. Quando il Commerciale stimava una commessa, il dato "
    "sui costi di personale poteva essere già obsoleto rispetto a quello aggiornato dall'HR. Risultato: "
    "decisioni prese su numeri non più attuali.",

    "Impossibilità pratica di confrontare scenari. Per valutare due ipotesi alternative bisognava "
    "letteralmente duplicare i file e modificarli a mano, perdendo qualsiasi possibilità di confronto "
    "strutturato.",

    "Vulnerabilità a errori umani. La logica di calcolo era sparsa in formule Excel non documentate, "
    "modificate da utenti diversi nel tempo, con il rischio concreto che un errore si propagasse senza "
    "essere notato.",

    "Dipendenza da chi \"conosce il file\". Spesso un solo collaboratore conosceva la logica di un "
    "file complesso. La sua assenza rendeva difficile ogni aggiornamento.",
])

add_image_placeholder("Confronto \"prima\" — esempio stilizzato di file Excel sparsi")

doc.add_heading("2.3 Stakeholder e bisogni espressi", level=2)
para(
    "Il progetto è nato dall'intersezione di esigenze provenienti da quattro aree aziendali diverse, "
    "ciascuna con aspettative specifiche:"
)

doc.add_heading("Direzione", level=3)
add_bullets([
    "Disporre di una vista d'insieme aggiornata, in qualsiasi momento, dello stato del portafoglio commesse e della capacità produttiva.",
    "Poter simulare rapidamente l'impatto di decisioni strategiche (acquisizione/rinuncia di commesse, assunzioni, riorganizzazioni).",
    "Avere indicatori sintetici (KPI) immediatamente leggibili senza dover entrare nei dettagli operativi.",
])

doc.add_heading("Risorse Umane", level=3)
add_bullets([
    "Mantenere un'unica anagrafica del personale, sempre aggiornata.",
    "Gestire il piano assunzioni futuro con visibilità immediata sull'impatto economico.",
    "Tenere traccia di costi medi di personale, ruoli aziendali, scadenze contrattuali.",
])

doc.add_heading("Commerciale", level=3)
add_bullets([
    "Valutare rapidamente l'effetto di una nuova opportunità commerciale sui margini e sulla saturazione del personale.",
    "Variare la probabilità di acquisizione di una commessa e ottenere subito il valore atteso.",
    "Confrontare scenari per supportare le scelte di go/no-go in fase di gara.",
])

doc.add_heading("Project Management", level=3)
add_bullets([
    "Pianificare l'allocazione del personale alle commesse nel tempo.",
    "Verificare la saturazione mensile di ogni risorsa ed evitare sovra-allocazioni.",
    "Segnalare buchi di copertura nei ruoli necessari per portare avanti i lavori.",
])

para(
    "L'esigenza trasversale a tutti gli stakeholder era quella di una verità unica e condivisa, "
    "con la possibilità di lavorare in parallelo senza rischio di sovrascritture."
)
add_image_placeholder("Schema con i quattro stakeholder e le loro esigenze")

page_break()

# ─── 3. OBIETTIVI ──────────────────────────────────────────────
doc.add_heading("3. Obiettivi del Progetto", level=1)
para(
    "A partire dall'analisi del contesto e dei bisogni espressi dagli stakeholder, sono stati definiti "
    "gli obiettivi che il software doveva raggiungere. Tali obiettivi sono stati formulati in maniera "
    "SMART (specifici, misurabili, raggiungibili, rilevanti, temporalmente definiti) e sono stati il "
    "riferimento costante durante tutto il ciclo di sviluppo."
)

doc.add_heading("3.1 Obiettivi funzionali", level=2)
add_numbered([
    "Centralizzazione delle anagrafiche. Creare un'unica fonte di verità per le commesse, le persone, "
    "i ruoli aziendali e le allocazioni del personale. Eliminare la frammentazione su file Excel.",

    "Simulazione di scenari what-if. Permettere all'utente di costruire scenari alternativi sul "
    "portafoglio commesse, modificando parametri chiave (probabilità, date, allocazioni, costi) e "
    "visualizzando in tempo reale l'impatto sui KPI economici.",

    "Calcolo automatico dei KPI. Computare in automatico, per ogni scenario, indicatori chiave come: "
    "costo personale totale e probabilizzato, FTE impiegati, percentuale di saturazione delle risorse, "
    "copertura dei ruoli necessari per ciascuna commessa, sotto-assorbimento e sovra-assorbimento, "
    "margine atteso.",

    "Multi-utente con sincronizzazione. Permettere a più utenti di lavorare contemporaneamente sugli "
    "stessi dati, con propagazione automatica e in tempo reale di ogni modifica a tutti gli utenti collegati.",

    "Permessi differenziati. Implementare un sistema di ruoli per garantire che ogni utente possa vedere "
    "e modificare solo ciò che gli compete, senza rischi di alterazioni accidentali.",

    "Reportistica. Permettere l'esportazione dei dati e dei risultati in formato Excel e PDF per "
    "condivisione esterna o archiviazione documentale.",

    "Funzionamento offline-first. Garantire che l'applicazione resti utilizzabile anche in assenza "
    "di connessione internet, con sincronizzazione automatica al ripristino della rete.",
])

doc.add_heading("3.2 Obiettivi non funzionali", level=2)
add_numbered([
    "Costo infrastrutturale zero o trascurabile. Sfruttare servizi cloud in piano gratuito, evitando ogni impatto sul budget IT.",
    "Distribuzione semplice. Permettere l'installazione su PC Windows con un singolo file installer, senza dipendenze tecniche complesse a carico dell'utente finale.",
    "Aggiornamenti automatici. Implementare un sistema di auto-update silenzioso, in modo che gli utenti ricevano sempre l'ultima versione del software senza interventi manuali.",
    "Reattività dell'interfaccia. Garantire tempi di risposta inferiori al secondo per le operazioni più frequenti.",
    "Robustezza dei dati. Implementare meccanismi di protezione contro perdite di dati e sovrascritture concorrenti, con backup automatico e tracciabilità delle modifiche.",
    "Manutenibilità del codice. Adottare una struttura modulare che permetta evoluzioni future senza riscrivere parti consistenti del software.",
])

doc.add_heading("3.3 Vincoli di progetto", level=2)
add_bullets([
    "Riservatezza dei dati. I dati di personale, costi e commesse sono informazioni sensibili e devono essere protetti adeguatamente.",
    "Esperienza utente. Gli utenti finali sono professionisti del settore costruzioni, non specialisti IT. L'interfaccia deve essere intuitiva.",
    "Tempi rapidi di rilascio. Si è scelto un approccio iterativo per dare valore agli utenti il prima possibile e raccogliere feedback frequenti.",
])

add_image_placeholder("Matrice obiettivi vs stakeholder")

page_break()

# ─── 4. ARCHITETTURA ───────────────────────────────────────────
doc.add_heading("4. Architettura Tecnica", level=1)
para(
    "L'architettura del software è stata progettata seguendo principi consolidati di ingegneria del software: "
    "modularità, separazione delle responsabilità, scalabilità futura, robustezza in presenza di rete instabile "
    "e sicurezza dei dati. In questa sezione si descrivono le scelte tecnologiche fondamentali e le ragioni "
    "che le hanno motivate."
)

doc.add_heading("4.1 Visione d'insieme", level=2)
para(
    "L'applicazione è un software desktop multipiattaforma che gli utenti installano sul proprio PC. "
    "I dati sono salvati sia localmente, sul disco dell'utente, sia su un database centralizzato in cloud. "
    "I due livelli sono mantenuti coerenti attraverso un sistema di sincronizzazione bidirezionale che "
    "funziona in tempo reale quando c'è connessione e in modalità \"differita\" quando si è offline."
)
para(
    "Questo modello è chiamato offline-first: l'applicazione funziona perfettamente anche senza connessione, "
    "e quando la rete torna disponibile, le modifiche vengono propagate automaticamente al cloud e agli altri utenti."
)

add_image_placeholder("Diagramma architetturale ad alto livello — Client desktop ↔ Cloud ↔ altri Client")

doc.add_heading("4.2 Stack tecnologico", level=2)
add_table(
    ["Livello", "Tecnologia", "Ruolo"],
    [
        ["Runtime desktop", "Electron", "Permette di distribuire l'app come eseguibile Windows installabile"],
        ["Build system", "Vite", "Compila il codice sorgente, ottimizzandolo per la distribuzione"],
        ["Linguaggi", "JavaScript (ES Modules), HTML5, CSS3", "Implementazione di logica, struttura e presentazione"],
        ["Visualizzazioni grafiche", "Chart.js + plugin DataLabels", "Grafici interattivi per costi mensili, saturazione, distribuzioni"],
        ["Lettura/scrittura Excel", "Libreria SheetJS (XLSX)", "Import e export dei dati in formato Microsoft Excel"],
        ["Generazione PDF", "jsPDF + html2canvas", "Reportistica esportabile in PDF"],
        ["Database cloud", "Supabase (PostgreSQL gestito)", "Persistenza centralizzata dei dati condivisi"],
        ["Autenticazione", "Supabase Auth", "Login utenti e gestione sessioni"],
        ["Sincronizzazione real-time", "Supabase Realtime (websocket)", "Propagazione istantanea delle modifiche tra client"],
        ["Storage locale", "LocalStorage browser", "Cache locale, funzionamento offline"],
        ["Auto-aggiornamento", "electron-updater + GitHub Releases", "Distribuzione automatica delle nuove versioni"],
        ["Versionamento codice", "Git / GitHub", "Storia completa del codice e tracciabilità modifiche"],
    ]
)

add_info_box(
    "Box informativo — Costo dell'infrastruttura cloud",
    [
        "L'infrastruttura attuale (database, autenticazione, sincronizzazione real-time, hosting "
        "delle release) opera interamente all'interno del piano gratuito offerto da Supabase e GitHub.",
        "Costo mensile attuale: 0 €.",
        "Il piano gratuito Supabase prevede limiti più che sufficienti per il team attuale (8 GB di "
        "trasferimento dati, 500 MB di database, 200 connessioni real-time simultanee), e può essere "
        "portato a un piano a pagamento solo qualora il team cresca significativamente o emergano "
        "nuove esigenze.",
    ]
)

doc.add_heading("4.3 Perché Electron + Vite", level=2)
para(
    "La scelta di costruire l'applicazione come app desktop anziché come applicazione web ha tre "
    "ragioni fondamentali:"
)
add_numbered([
    "Semplicità di distribuzione. Gli utenti ricevono un installer .exe e l'app è subito disponibile "
    "sul desktop, senza dover gestire URL, browser o plugin.",

    "Funzionamento offline. Una volta installata, l'app continua a funzionare anche senza connessione, "
    "attingendo ai dati salvati localmente. Per un settore come il nostro, dove le visite in cantiere o "
    "gli spostamenti possono comportare l'assenza di connessione, questa è una caratteristica essenziale.",

    "Esperienza utente coerente. Una finestra applicativa dedicata, con icone, scorciatoie da tastiera e "
    "integrazione con il sistema operativo, dà un senso di \"strumento professionale\" che nessuna pagina "
    "web equivalente potrebbe offrire.",
])

para(
    "Electron è la tecnologia che ha reso possibili Visual Studio Code, Slack, Microsoft Teams, "
    "GitHub Desktop. È quindi una piattaforma matura, stabile, ampiamente supportata."
)
para(
    "Vite è il sistema di build moderno che gestisce la compilazione del codice. Sostituisce strumenti "
    "più vecchi e lenti, garantendo compilazioni rapide (l'intera applicazione viene compilata in meno "
    "di 10 secondi) e un pacchetto distribuibile compatto."
)

doc.add_heading("4.4 Perché Supabase come backend", level=2)
para(
    "La scelta del backend cloud è ricaduta su Supabase dopo un'analisi comparativa con altre opzioni "
    "(Firebase di Google, AWS, server tradizionale con database PostgreSQL self-hosted). Le ragioni sono state:"
)
add_numbered([
    "Database PostgreSQL standard. Supabase usa PostgreSQL \"vero\", non un database proprietario. "
    "Questo garantisce portabilità futura: in qualsiasi momento si potrebbe migrare a un PostgreSQL "
    "ospitato altrove senza riscrivere il codice.",

    "Servizi integrati. Supabase fornisce in un unico pacchetto database, autenticazione utenti, "
    "sincronizzazione in tempo reale e archiviazione file, evitando di dover integrare servizi diversi tra loro.",

    "Sincronizzazione real-time nativa. Il servizio Supabase Realtime permette ai client di \"sottoscriversi\" "
    "alle modifiche del database e ricevere notifiche istantanee via websocket. Una capacità che, costruita "
    "da zero, richiederebbe infrastruttura e competenze considerevoli.",

    "Sicurezza di livello enterprise. Supabase implementa Row Level Security (RLS) lato database, una "
    "tecnologia che permette di definire regole di accesso granulari direttamente sulle tabelle, "
    "indipendentemente da come il client tenta di interrogarle.",

    "Costo zero in fase iniziale. Il piano gratuito copre ampiamente le esigenze attuali del team.",

    "Open source. Supabase è un progetto open source. Anche in caso di chiusura del servizio, l'intera "
    "infrastruttura potrebbe essere ricostruita su server propri.",
])

doc.add_heading("4.5 Architettura della sincronizzazione", level=2)
para(
    "La sincronizzazione tra il database locale (sul PC dell'utente) e il database cloud è il cuore "
    "tecnico dell'applicazione, ed è stata progettata in modo particolarmente accurato per garantire "
    "affidabilità e reattività."
)

doc.add_heading("4.5.1 Modello ibrido push/pull con Realtime", level=3)
para("L'applicazione adotta un modello ibrido che combina tre meccanismi complementari:")
add_numbered([
    "Push periodico delle modifiche locali. Ogni 2 secondi, un meccanismo interno controlla se l'utente "
    "ha modificato dati locali, e in tal caso li invia al cloud.",

    "Pull periodico delle modifiche remote. Ogni 15 secondi, l'applicazione interroga il cloud per "
    "scaricare eventuali modifiche fatte da altri utenti, come fallback in caso di interruzione del "
    "canale real-time.",

    "Sottoscrizione real-time via websocket. All'avvio, l'applicazione si \"sottoscrive\" alle modifiche "
    "delle tabelle condivise attraverso una connessione websocket persistente. Quando un altro utente "
    "modifica un dato, la notifica arriva in meno di un secondo, e l'applicazione aggiorna automaticamente "
    "la propria copia locale.",
])
para(
    "Il meccanismo è progettato in modo che, se il canale websocket cade per qualsiasi motivo (rete instabile, "
    "server temporaneamente non raggiungibile), il polling a 15 secondi garantisce comunque la sincronizzazione, "
    "sia pure con una latenza maggiore. È un esempio di degradazione graceful: il sistema non smette mai di "
    "funzionare, semplicemente cambia modalità."
)

add_image_placeholder("Diagramma del flusso di sincronizzazione real-time")

doc.add_heading("4.5.2 Full pull all'avvio", level=3)
para(
    "Ogni volta che l'utente apre l'applicazione, viene eseguito un full pull completo dal cloud. "
    "Questo significa che lo stato locale viene riallineato alla \"verità\" del cloud all'inizio di "
    "ogni sessione di lavoro. Questa scelta architetturale, per quanto possa sembrare ridondante, è "
    "fondamentale per eliminare alla radice la possibilità che dati locali \"stantii\" possano sovrascrivere "
    "modifiche fatte da altri utenti durante l'assenza dell'utente."
)

doc.add_heading("4.5.3 Conflict detection", level=3)
para(
    "Prima di inviare una modifica al cloud, l'applicazione verifica se nel frattempo qualcun altro ha "
    "modificato gli stessi dati. In caso affermativo, esegue prima un pull per integrare le modifiche "
    "remote, poi pusha le proprie. In questo modo si evitano sovrascritture silenziose, anche in scenari "
    "di lavoro collaborativo intensivo."
)

doc.add_heading("4.5.4 Tolleranza al clock drift", level=3)
para(
    "Una sottigliezza tecnica importante: i diversi PC del team possono avere orologi leggermente "
    "disallineati rispetto al server (di pochi secondi o anche minuti). Per evitare che questo causi "
    "modifiche non sincronizzate, l'applicazione applica un buffer di sicurezza di 5 minuti quando "
    "confronta i timestamp, e usa un timestamp fresco generato al momento del push per ogni modifica "
    "inviata. È una soluzione che richiede pochissime righe di codice ma evita una classe di problemi "
    "estremamente difficili da diagnosticare a posteriori."
)

doc.add_heading("4.6 Auto-aggiornamento e distribuzione", level=2)
para(
    "Una scelta chiave per ridurre l'onere di gestione del software è stata l'integrazione di un "
    "sistema di auto-aggiornamento. Quando viene rilasciata una nuova versione, gli utenti ricevono "
    "automaticamente una notifica all'interno dell'app, e con un click possono installarla senza "
    "interventi manuali."
)
para("Il flusso è il seguente:")
add_numbered([
    "Lo sviluppo produce una nuova versione (ad esempio dalla 1.0.68 alla 1.0.69).",
    "La versione viene compilata e pubblicata come \"release\" su GitHub.",
    "Gli utenti, alla prima apertura dell'app dopo il rilascio, ricevono la notifica.",
    "Cliccando \"Aggiorna\", la nuova versione viene scaricata in background e applicata.",
])
para(
    "Questo elimina la necessità di \"passare di PC in PC\" per aggiornare il software, una pratica "
    "che in aziende di dimensioni medie comporta costi significativi e ritardi nell'adozione di nuove "
    "funzionalità o correzioni."
)
add_image_placeholder("Schermata della notifica di aggiornamento disponibile")

doc.add_heading("4.7 Versionamento del codice", level=2)
para(
    "Tutto il codice sorgente è ospitato su un repository Git/GitHub privato. Ogni modifica al codice "
    "viene tracciata con un commit, descritta da un messaggio chiaro che ne spiega lo scopo, e collegata "
    "cronologicamente alle altre modifiche. Questo garantisce:"
)
add_bullets([
    "Tracciabilità completa. È sempre possibile sapere chi ha fatto cosa, quando e perché.",
    "Reversibilità. Qualsiasi modifica può essere annullata tornando a una versione precedente.",
    "Backup intrinseco. Il codice è replicato su GitHub, su tutti i computer di sviluppo e nei file delle release distribuite.",
    "Collaborazione futura. Se in futuro più persone dovessero contribuire al progetto, l'infrastruttura è già pronta a supportarle.",
])
add_image_placeholder("Storico commit GitHub o esempio di tag/release")

page_break()

# ─── 5. MODELLO DATI ───────────────────────────────────────────
doc.add_heading("5. Modello Dati e Dominio", level=1)
para(
    "Un software di analisi e simulazione vive o muore in funzione della qualità del suo modello dati. "
    "Un modello mal progettato si paga per anni con compromessi continui e re-implementazioni. Per questo "
    "motivo, una parte significativa del lavoro iniziale è stata dedicata a definire le entità di dominio "
    "e le loro relazioni."
)

doc.add_heading("5.1 Le entità principali", level=2)
para("L'applicazione gestisce sei entità fondamentali, ciascuna con un proprio ruolo nel dominio.")

doc.add_heading("5.1.1 Commesse", level=3)
para(
    "Le commesse rappresentano i progetti e i cantieri dell'azienda. Ogni commessa è caratterizzata da:"
)
add_bullets([
    "Un codice univoco (identificativo aziendale)",
    "Un nome descrittivo",
    "Una tipologia (Backlog, Order Intake, Pipeline)",
    "Date di inizio e fine previste",
    "Una probabilità di acquisizione (per le commesse non ancora certe)",
    "Un valore economico",
    "Un settore di appartenenza",
])
para(
    "Le commesse sono la base su cui si fondano gli scenari: ogni scenario \"what-if\" parte da una "
    "baseline di commesse e ne modifica selettivamente i parametri."
)

doc.add_heading("5.1.2 Scenari", level=3)
para("Gli scenari sono la rappresentazione di una specifica ipotesi di lavoro. Ogni scenario contiene:")
add_bullets([
    "Un nome descrittivo",
    "Una descrizione testuale del razionale",
    "Un insieme di modifiche rispetto alla baseline (commesse aggiunte, escluse, modificate)",
    "Un insieme di filtri attivi (settore, periodo, tipologia)",
    "Stato (bozza, approvato, archiviato)",
    "Metadati di tracciabilità (data creazione, autore)",
])
para(
    "Il sistema permette di confrontare più scenari tra loro, rendendo immediato vedere differenze "
    "in termini di costi, marginalità, FTE e saturazione."
)

doc.add_heading("5.1.3 Persone", level=3)
para(
    "Le persone rappresentano i collaboratori dell'azienda. Ogni persona è caratterizzata da un set "
    "ricco di informazioni:"
)
add_bullets([
    "Anagrafica base (cognome, nome, codice fiscale)",
    "Società di appartenenza, business unit, centro di costo",
    "Ruolo aziendale",
    "Tipo di contratto (Dipendente, Consulente, ecc.)",
    "Data di assunzione e (se prevista) data di termine",
    "Costo medio mensile aziendale",
    "Stato di assunzione (attiva, in ingresso, da ricercare)",
])
para(
    "Quest'ultimo punto è particolarmente rilevante: il sistema permette di gestire non solo le persone "
    "già attive, ma anche assunzioni future certe (\"in ingresso\") e posizioni aperte da coprire "
    "(\"da ricercare\"). Questo rende possibile pianificare il piano assunzioni in modo integrato con "
    "le commesse."
)
add_image_placeholder("Schermata della tab Persone con esempio di anagrafica")

doc.add_heading("5.1.4 Allocazioni", level=3)
para(
    "Le allocazioni sono il legame tra persone e commesse: indicano quanto tempo (in percentuale) una "
    "persona è dedicata a una specifica commessa, in un certo periodo. Ogni allocazione contiene:"
)
add_bullets([
    "Riferimento alla persona",
    "Riferimento alla commessa",
    "Riferimento allo scenario di appartenenza",
    "Percentuale di occupazione (es. 50% significa \"metà del tempo lavorativo\")",
    "Date di inizio e fine",
    "Flag di \"agganciamento\" alle date della commessa (per propagazione automatica delle date)",
    "Note operative",
])
para(
    "Le allocazioni sono il dato dal quale derivano tutti i KPI di capacità e di costo. Quando l'utente "
    "modifica un'allocazione, l'intero quadro economico dello scenario si aggiorna in tempo reale."
)

doc.add_heading("5.1.5 Ruoli", level=3)
para(
    "I ruoli rappresentano le figure professionali presenti in azienda (es. Project Manager, Site "
    "Coordinator, Operaio, Crane Operator). Ogni ruolo è caratterizzato da:"
)
add_bullets([
    "Nome univoco",
    "Codice",
    "Costo medio mensile (default per chi ricopre quel ruolo)",
    "Tipologia: necessario o opzionale",
])
para(
    "La distinzione necessario/opzionale è fondamentale perché alimenta il sistema di copertura dei "
    "ruoli: per ogni commessa, il software verifica se sono allocati tutti i ruoli \"necessari\" e "
    "segnala con chiarezza eventuali mancanze."
)

doc.add_heading("5.1.6 Audit Log", level=3)
para(
    "Tutte le operazioni di creazione, modifica e cancellazione vengono registrate in un registro "
    "di audit che tiene traccia di:"
)
add_bullets([
    "Tipo di entità (persona, allocazione, ruolo, ecc.)",
    "Identificativo dell'entità",
    "Operazione (create, update, delete)",
    "Valore precedente e valore nuovo",
    "Origine (manuale, importazione, sincronizzazione)",
    "Timestamp",
])
para(
    "Questo registro è fondamentale sia per la tracciabilità (chi ha fatto cosa, quando), sia per il "
    "debugging (in caso di anomalie, è possibile ricostruire la sequenza degli eventi che le ha causate)."
)

doc.add_heading("5.2 Relazioni tra entità", level=2)
add_image_placeholder("Diagramma entità-relazioni semplificato")
para("Il modello relazionale può essere riassunto così:")
add_bullets([
    "Una commessa può avere molte allocazioni (una per ogni persona che ci lavora)",
    "Una persona può avere molte allocazioni (una per ogni commessa su cui è impegnata, in ogni scenario)",
    "Un'allocazione appartiene a uno scenario specifico",
    "Una persona ha un ruolo (referenziato per nome)",
    "Uno scenario parte da una baseline di commesse e applica modifiche",
])

doc.add_heading("5.3 Sistema di permessi", level=2)
para(
    "Per garantire che ogni utente possa modificare solo ciò che gli compete, il software implementa "
    "un sistema di permessi a sei livelli, sia lato applicazione che lato database."
)

doc.add_heading("5.3.1 I sei ruoli", level=3)
add_table(
    ["Ruolo", "Descrizione", "Capacità di scrittura"],
    [
        ["admin", "Amministratore del sistema", "Tutti i dati"],
        ["editor", "Utente con permessi pieni di editing", "Tutti i dati operativi"],
        ["hr", "Responsabile risorse umane", "Persone, ruoli, audit"],
        ["commercial", "Responsabile commerciale", "Commesse, scenari, allocazioni, audit"],
        ["tester", "Tester / utente di prova", "Scenari (per esperimenti)"],
        ["viewer", "Utente in sola lettura", "Nessuna scrittura"],
    ]
)
para("Questa matrice è applicata in due livelli:")
add_numbered([
    "Lato applicazione, prima di mostrare bottoni o eseguire operazioni di modifica, l'app verifica "
    "che l'utente abbia il permesso necessario.",

    "Lato database, attraverso le Row Level Security policies di Supabase, il database stesso rifiuta "
    "operazioni non autorizzate, indipendentemente dal client che le tenta. Questo è il livello di "
    "sicurezza più importante: anche un client modificato o un attacco di accesso diretto al database "
    "non potrebbero violare i permessi.",
])

doc.add_heading("5.3.2 Esempio pratico", level=3)
para(
    "Un utente con ruolo HR può aggiungere o modificare le persone in anagrafica, ma non può modificare "
    "gli scenari o le allocazioni alle commesse. Se per errore tentasse, vedrebbe i pulsanti disabilitati, "
    "e qualsiasi tentativo di forzatura verrebbe respinto dal database."
)
para(
    "Questo modello è particolarmente importante in un contesto multi-utente, perché permette di delegare "
    "con tranquillità l'operatività quotidiana a utenti specializzati senza correre il rischio di "
    "alterazioni accidentali su dati di altre aree."
)
add_image_placeholder("Matrice dei ruoli e permessi")

page_break()

# ─── 6. FUNZIONALITÀ ───────────────────────────────────────────
doc.add_heading("6. Funzionalità Principali", level=1)
para(
    "In questa sezione vengono descritte in dettaglio le principali funzionalità messe a disposizione "
    "dal software, raggruppate per area funzionale. Ogni funzionalità è il risultato di un'analisi dei "
    "bisogni reali degli utenti e di iterazioni progressive sul feedback raccolto."
)

doc.add_heading("6.1 Gestione delle Anagrafiche", level=2)

doc.add_heading("6.1.1 Anagrafica Commesse", level=3)
para("La prima cosa che l'utente fa, all'avvio dell'app, è caricare l'anagrafica delle commesse. Questo può avvenire in due modi:")
add_bullets([
    "Caricamento da file Excel. L'utente importa un file Excel strutturato secondo un template definito, "
    "e il software legge automaticamente codici, nomi, date, valori, probabilità e settori.",
    "Inserimento manuale o modifica. Una volta caricate, le commesse possono essere modificate direttamente dall'interfaccia.",
])
para("Per ogni commessa, il software calcola e mostra:")
add_bullets([
    "Lo stato attuale (Backlog, Order Intake, Pipeline)",
    "Il valore e la probabilizzazione attesa",
    "Il numero di persone allocate",
    "Il costo del personale assegnato",
    "Il margine atteso",
])
add_image_placeholder("Schermata anagrafica commesse / lista commesse")

doc.add_heading("6.1.2 Anagrafica Persone", level=3)
para(
    "La gestione delle persone è particolarmente curata, dato che è il cuore del modulo HR. Per ogni "
    "persona è possibile registrare l'anagrafica completa, lo stato attuale (attiva, in ingresso, da "
    "ricercare, cessata), il costo medio mensile, le date di assunzione e di termine. Le persone possono "
    "essere cercate, filtrate e ordinate per qualsiasi colonna. È possibile importarle in massa da Excel."
)
para(
    "Una funzione molto apprezzata è la gestione del piano assunzioni futuro: le persone in ingresso o "
    "da ricercare vengono evidenziate in modo distinto e i loro costi sono inclusi nei calcoli di scenario, "
    "permettendo di simulare l'impatto di assunzioni programmate prima ancora che avvengano."
)
add_image_placeholder("Schermata anagrafica persone con filtri attivi")

doc.add_heading("6.1.3 Anagrafica Ruoli", level=3)
para(
    "La tab dei ruoli permette di gestire l'elenco completo delle figure professionali aziendali, "
    "ciascuna con il suo costo medio di riferimento e la sua tipologia (necessario o opzionale). "
    "Da qui è possibile:"
)
add_bullets([
    "Aggiungere nuovi ruoli",
    "Modificare codice, nome, costo, tipologia di un ruolo esistente",
    "Eliminare ruoli non più utilizzati (solo se non assegnati a nessuna persona)",
    "Applicare il costo aggiornato di un ruolo a tutte le persone che lo ricoprono",
])
para(
    "La distinzione tra ruoli necessari e opzionali ha un impatto diretto sull'analisi di copertura "
    "nelle pagine Economics: i ruoli necessari mancanti vengono evidenziati in rosso, gli opzionali "
    "in arancione, dando un colpo d'occhio immediato sulle priorità di acquisizione personale."
)
add_image_placeholder("Tab Ruoli con esempio di costi medi e tipologie")

doc.add_heading("6.2 Pianificazione e Allocazioni", level=2)
para("La sezione Pianificazione è il punto dove le persone vengono assegnate alle commesse. Qui l'utente può:")
add_bullets([
    "Vedere tutte le allocazioni dello scenario attivo, in forma di tabella ricca di filtri",
    "Aggiungere nuove allocazioni specificando persona, commessa, percentuale, periodo",
    "Modificare allocazioni esistenti",
    "Cancellare allocazioni non più valide",
    "Importare allocazioni in massa da Excel",
    "Ordinare la tabella per qualsiasi colonna",
])
para(
    "Una caratteristica avanzata è il sistema di agganciamento automatico delle date: un'allocazione "
    "può essere \"agganciata\" alle date di inizio o fine della commessa, in modo che se la commessa "
    "slitta, anche le allocazioni si aggiornino automaticamente. È possibile specificare un delta in "
    "mesi (per esempio \"inizia 2 mesi dopo l'inizio commessa, finisce 1 mese prima della fine\") in "
    "modo da modellare situazioni operative complesse senza bisogno di aggiornamenti manuali."
)
add_image_placeholder("Tab Pianificazione con tabella allocazioni e filtri")

doc.add_heading("6.3 Simulazione di Scenari What-If", level=2)
para(
    "Il cuore concettuale dell'applicazione è la possibilità di costruire scenari alternativi. Lo scenario "
    "\"Baseline\" rappresenta lo stato di fatto. A partire da esso, l'utente può creare nuovi scenari "
    "(es. \"Senza commessa X\", \"Con assunzione di 2 PM in più\", \"Slittamento di 6 mesi della commessa Y\") "
    "e modificarli liberamente senza intaccare la baseline."
)
para("Per ogni scenario, l'utente può:")
add_bullets([
    "Modificare la probabilità di acquisizione delle commesse",
    "Escludere temporaneamente alcune commesse",
    "Modificare le date previste",
    "Aggiungere o rimuovere persone in pianificazione",
    "Confrontare il risultato con la baseline o con un altro scenario",
])
para(
    "Il software ricalcola in tempo reale tutti i KPI per ogni scenario: costo personale totale, costo "
    "personale probabilizzato, FTE, saturazione, margini, copertura ruoli."
)
add_image_placeholder("Vista di confronto tra due scenari side-by-side")

doc.add_heading("6.4 Pagina Capacity (Saturazione e Costi del Personale)", level=2)
para("La pagina Capacity offre la vista più ricca sull'utilizzo del personale. È divisa in più sezioni:")

doc.add_heading("6.4.1 KPI principali", level=3)
para("Nella parte superiore della pagina vengono mostrati i KPI fondamentali:")
add_bullets([
    "Persone allocate (su totale persone)",
    "Costo personale totale (calcolato sui contratti attivi nel periodo)",
    "Costo personale allocato (calcolato sulle allocazioni effettive)",
    "Costo personale probabilizzato (allocato × probabilità delle commesse)",
    "Sotto-assorbimento o sovra-assorbimento (differenza tra costo totale e costo allocato)",
    "FTE equivalenti",
])

doc.add_heading("6.4.2 Grafici dei costi", level=3)
para("Per ogni mese del periodo selezionato, vengono mostrati grafici che illustrano:")
add_bullets([
    "Il costo del personale per mese, totale e suddiviso tra Backlog e Order Intake",
    "L'andamento previsto nei mesi futuri",
    "I picchi di costo",
])

doc.add_heading("6.4.3 Tabella di saturazione per persona", level=3)
para(
    "La sezione più analitica è la tabella di dettaglio per persona: una matrice in cui ogni riga "
    "rappresenta una persona e ogni colonna un mese. In ciascuna cella viene mostrata la percentuale "
    "di saturazione di quella persona in quel mese, con codifica colore:"
)
add_bullets([
    "Verde se la persona è saturata al 100%",
    "Giallo se è sotto-saturata (es. 50%)",
    "Rosso se è sovra-saturata (oltre 100%, problema da risolvere)",
    "Grigio se è disponibile (0%)",
    "Croce se la persona non è in forza in quel mese (assunta dopo o cessata prima)",
])
para(
    "Le colonne Persona e Ruolo sono ordinabili con un click, permettendo di analizzare il personale "
    "dal punto di vista più conveniente."
)
add_image_placeholder("Pagina Capacity completa con KPI, grafici e tabella di saturazione")

doc.add_heading("6.4.4 Allocazioni in scadenza", level=3)
para(
    "Una sezione collassabile mostra tutte le allocazioni in scadenza nei prossimi 3 mesi, in modo "
    "che il PM possa prepararsi per tempo a riallocare il personale."
)

doc.add_heading("6.4.5 Piano Assunzioni", level=3)
para(
    "In fondo alla pagina è presente la tabella del Piano Assunzioni: tutte le persone con stato "
    "\"in ingresso\" (assunzioni certe) o \"da ricercare\" (posizioni aperte), con le loro date "
    "previste di ingresso, costi e ruoli. È un riepilogo immediato per la Direzione e l'HR di tutte "
    "le decisioni di personale già pianificate."
)

doc.add_heading("6.5 Pagina Economics (Analisi per Cantiere)", level=2)
para(
    "La pagina Economics offre la vista per cantiere: ogni commessa è rappresentata come una \"card\" "
    "con i suoi indicatori chiave e una tabella di dettaglio delle persone allocate."
)
para("Per ogni commessa vengono mostrati:")
add_bullets([
    "Persone allocate, FTE assegnati, costo personale allocato, costo probabilizzato",
    "Tabella delle allocazioni con: persona, ruolo, codice ruolo, percentuale, date, mesi nel periodo, costi",
    "Indicatore di copertura ruoli necessari: una sezione collassabile che mostra a colpo d'occhio quanti "
    "ruoli necessari sono coperti e quanti mancano, con distinzione cromatica tra ruoli necessari (rosso) "
    "e opzionali (arancione)",
])
para(
    "La tabella delle allocazioni è ordinabile per persona, ruolo o codice ruolo, e tutti i numeri "
    "vengono ricalcolati automaticamente quando si modifica lo scenario o si applicano filtri di periodo."
)
para("In fondo è disponibile un totale complessivo che somma i dati di tutte le commesse selezionate.")
add_image_placeholder("Pagina Economics con cards delle commesse e copertura ruoli")

doc.add_heading("6.6 Dashboard e Reportistica", level=2)
para(
    "La dashboard principale aggrega in un'unica vista i KPI più importanti dello scenario attivo: "
    "numero di commesse, valore totale, valore probabilizzato, costi del personale, FTE, scenari attivi. "
    "È il punto di partenza naturale all'apertura dell'applicazione."
)
para("Per la condivisione esterna sono disponibili più formati di esportazione:")
add_bullets([
    "Excel con i dati grezzi delle commesse, persone, allocazioni",
    "Excel template preformattato per ricaricamento futuro",
    "CSV per integrazioni con altri sistemi",
    "PDF con report grafico, esportabile direttamente per la condivisione con la Direzione",
])
add_image_placeholder("Dashboard principale")

doc.add_heading("6.7 Import / Export Excel", level=2)
para(
    "Particolare attenzione è stata dedicata all'integrazione con Excel, perché è il formato di lavoro "
    "più diffuso in azienda. Il software permette:"
)
add_bullets([
    "Import di commesse da Excel, con riconoscimento automatico delle colonne",
    "Import di persone da Excel, con gestione di duplicati e codici fiscali",
    "Import di allocazioni da Excel, con matching automatico delle persone per codice fiscale o nome+cognome",
    "Export di tutte le entità in Excel, con formattazione professionale",
])
para(
    "Le modalità di import sono robuste e tollerano variazioni nelle intestazioni di colonna (es. "
    "\"Costo Medio Mese\", \"costoMedioMese\", \"costo medio mensile\" sono tutte riconosciute come "
    "la stessa colonna)."
)

doc.add_heading("6.8 Sistema multi-utente con Sync Real-time", level=2)
para(
    "Quando più utenti sono connessi contemporaneamente, ogni modifica fatta da uno viene propagata "
    "istantaneamente a tutti gli altri. Concretamente:"
)
add_bullets([
    "L'utente A modifica un'allocazione",
    "Entro un secondo, l'utente B vede comparire un banner verde \"Aggiornati: allocazioni\" in basso a destra",
    "Se l'utente B è sulla pagina Risorse, la tabella si aggiorna automaticamente",
    "Un click sul banner ricarica eventuali viste secondarie",
])
para(
    "L'indicatore di utenti online mostra in alto a destra quanti collaboratori sono attualmente "
    "connessi, e cliccandoci si apre un menu con i loro nominativi e ruoli. Questa funzionalità, "
    "basata sul sistema Supabase Presence, dà a tutti la consapevolezza di lavorare in contemporanea "
    "con altri colleghi."
)
add_image_placeholder("Indicatore utenti online + banner di aggiornamento dati")

page_break()

# ─── 7. SICUREZZA ──────────────────────────────────────────────
doc.add_heading("7. Sicurezza e Affidabilità dei Dati", level=1)
para(
    "La sicurezza e l'affidabilità dei dati sono state priorità centrali del progetto. In un sistema "
    "multi-utente che gestisce informazioni sensibili (anagrafica personale, costi del lavoro, portafoglio "
    "commesse, decisioni strategiche), una sola perdita di dati o una sovrascrittura accidentale può "
    "compromettere ore o giorni di lavoro qualificato. Per questo, il software implementa diversi livelli "
    "di protezione concorrenti."
)

doc.add_heading("7.1 Autenticazione utenti", level=2)
para(
    "Ogni utente accede al software con email e password personali, gestiti dal sistema di autenticazione "
    "di Supabase. Le credenziali sono cifrate in modo sicuro lato server, e la sessione viene mantenuta "
    "attiva tramite token a scadenza programmata."
)
para("L'amministratore può:")
add_bullets([
    "Aggiungere nuovi utenti",
    "Modificare il ruolo di un utente esistente",
    "Disattivare un utente",
])

doc.add_heading("7.2 Sicurezza a livello di database (RLS)", level=2)
para(
    "Come anticipato, il database PostgreSQL implementa Row Level Security policies che impongono "
    "regole di accesso direttamente sulle tabelle. Queste policies sono valutate dal database stesso, "
    "indipendentemente dal client che effettua la richiesta. In pratica, anche se un utente malintenzionato "
    "volesse aggirare l'applicazione e parlare direttamente col database, non potrebbe leggere o modificare "
    "dati per cui non ha autorizzazione."
)
para(
    "Le policies sono definite in funzione del ruolo dell'utente nella tabella user_roles, e sono "
    "organizzate in questo modo per ogni tabella:"
)
add_bullets([
    "Lettura (SELECT): chiunque sia autenticato",
    "Inserimento (INSERT): solo i ruoli con permessi di scrittura",
    "Aggiornamento (UPDATE): solo i ruoli con permessi di scrittura",
    "Cancellazione (DELETE): solo i ruoli con permessi di scrittura",
])

doc.add_heading("7.3 Conflict detection lato client", level=2)
para(
    "Quando due utenti modificano in parallelo gli stessi dati (es. due responsabili che aggiornano "
    "simultaneamente l'allocazione di una persona), si parla di \"conflitto concorrente\". Senza una "
    "protezione, l'ultimo a salvare sovrascrive il lavoro dell'altro senza neppure accorgersene."
)
para(
    "Il software implementa un meccanismo di conflict detection: prima di inviare una modifica al cloud, "
    "il client verifica se nel frattempo altri utenti hanno modificato la stessa entità. In caso affermativo, "
    "integra prima le loro modifiche, poi sovrappone le proprie. Questo riduce drasticamente la probabilità "
    "di perdita di dati in scenari di lavoro intenso."
)

doc.add_heading("7.4 Deduplicazione automatica", level=2)
para(
    "Un altro problema tipico dei sistemi multi-utente è la duplicazione di entità: se due utenti, in "
    "momenti diversi, creano entrambi la persona \"Mario Rossi\" senza sapere dell'altro, il database "
    "si trova con due persone identiche ma con identificativi tecnici differenti. Le allocazioni successive "
    "potrebbero essere attribuite a una o all'altra in modo casuale, generando confusione."
)
para("Il software implementa una deduplicazione automatica a più livelli:")
add_bullets([
    "Per le persone: il merge avviene per codice fiscale (chiave primaria di unicità) o, in mancanza "
    "di esso, per cognome+nome",
    "Per i ruoli: il merge avviene per nome (case-insensitive)",
    "Per le allocazioni: il merge avviene per la combinazione persona + commessa + scenario + periodo + percentuale",
])
para("La deduplicazione viene eseguita in tre momenti:")
add_numbered([
    "All'avvio dell'applicazione, come pulizia preventiva",
    "Dopo ogni sincronizzazione dal cloud",
    "All'arrivo di eventi real-time",
])
para(
    "Le entità superstiti sono sempre quelle con il timestamp di modifica più recente, e tutte le "
    "allocazioni che facevano riferimento a entità \"rimosse\" vengono automaticamente rimappate "
    "all'entità superstite, garantendo che nessuna informazione operativa vada persa."
)

doc.add_heading("7.5 Backup automatico locale", level=2)
para(
    "Prima di ogni operazione di sincronizzazione importante (in particolare il full pull dal cloud), "
    "il software esegue un backup locale dello stato corrente del localStorage. In caso di problemi, "
    "il backup permette di ripristinare lo stato precedente."
)

doc.add_heading("7.6 Audit log completo", level=2)
para(
    "Come descritto nella sezione del modello dati, ogni modifica significativa (creazione, aggiornamento, "
    "cancellazione di persone, allocazioni, ruoli) viene registrata in un audit log che memorizza:"
)
add_bullets([
    "L'entità e l'identificativo",
    "L'operazione effettuata",
    "I valori prima e dopo la modifica",
    "L'origine dell'operazione (manuale, importazione, sincronizzazione)",
    "Il timestamp esatto",
])
para("Il log è uno strumento prezioso per:")
add_bullets([
    "Verifica a posteriori (\"chi ha modificato il costo medio del PM?\")",
    "Diagnostica (\"perché questa allocazione è scomparsa?\")",
    "Compliance (in caso di richiesta di tracciabilità)",
])

doc.add_heading("7.7 Cancellazioni soft", level=2)
para(
    "Le cancellazioni di entità non eliminano fisicamente i dati dal database, ma li marcano come "
    "\"deleted = true\". Questo significa che, in caso di errore, i dati possono sempre essere recuperati "
    "con un'operazione manuale lato database. In contesti produttivi, questa è una protezione fondamentale: "
    "nessuna cancellazione è mai definitiva nell'immediato."
)
add_image_placeholder("Schema dei livelli di sicurezza/affidabilità")

page_break()

# ─── 8. METODOLOGIA ────────────────────────────────────────────
doc.add_heading("8. Metodologia di Sviluppo e Ciclo di Vita", level=1)

doc.add_heading("8.1 Approccio iterativo", level=2)
para(
    "Lo sviluppo del software ha seguito un approccio iterativo e incrementale, in linea con le "
    "metodologie agili contemporanee. Invece di pianificare un grande rilascio \"perfetto\" alla fine "
    "di mesi di lavoro, si è scelto di:"
)
add_numbered([
    "Costruire un nucleo funzionale minimo",
    "Distribuirlo subito agli utenti chiave",
    "Raccogliere feedback sul campo",
    "Iterare con rilasci continui (versionati)",
])
para("Questo approccio ha permesso di:")
add_bullets([
    "Validare le assunzioni rapidamente, prima di investire tempo su funzionalità non veramente utili",
    "Coinvolgere gli utenti nel processo di sviluppo, facendoli sentire parte del progetto",
    "Minimizzare il rischio, perché ogni rilascio è piccolo e quindi facile da diagnosticare",
    "Adattarsi ai cambiamenti di priorità senza dover riscrivere parti consistenti",
])

doc.add_heading("8.2 Versionamento semantico", level=2)
para("Le versioni del software seguono lo standard del versionamento semantico (Semantic Versioning):")
add_bullets([
    "MAJOR (es. 1.x.x → 2.x.x): cambiamenti che alterano il comportamento esistente",
    "MINOR (es. x.0.x → x.1.x): nuove funzionalità retrocompatibili",
    "PATCH (es. x.x.0 → x.x.1): correzioni di bug, miglioramenti minori",
])
para(
    "Al momento della redazione di questa relazione, l'applicazione è alla versione 1.0.69. Il numero "
    "di patch elevato testimonia un ciclo di sviluppo intensivo, con molti rilasci correttivi e di "
    "miglioramento basati sul feedback raccolto in corso d'opera."
)

doc.add_heading("8.3 Distribuzione delle release", level=2)
para(
    "Ogni rilascio viene distribuito attraverso il sistema di GitHub Releases integrato con "
    "electron-updater. Questo significa che, al momento del rilascio:"
)
add_numbered([
    "Il codice viene compilato in un file installer Windows",
    "Il file viene caricato su GitHub come \"release\" pubblica del repository (privato)",
    "Tutti i client connessi vengono notificati tramite il sistema di auto-update",
    "Gli utenti possono installare la nuova versione con un click",
])
para(
    "Il vantaggio rispetto a una distribuzione manuale è enorme: una nuova funzionalità può raggiungere "
    "tutti gli utenti entro pochi minuti dal rilascio, senza interventi sui singoli PC."
)

doc.add_heading("8.4 Coinvolgimento degli utenti chiave", level=2)
para(
    "Un elemento centrale del successo del progetto è stato il coinvolgimento diretto degli utenti "
    "chiave fin dalle prime fasi:"
)
add_bullets([
    "HR: ha contribuito a definire i campi anagrafici realmente utili e le regole di gestione del "
    "personale (in particolare il piano assunzioni futuro)",
    "Commerciale: ha definito le regole di calcolo dei valori probabilizzati e le viste utili per "
    "la valutazione delle opportunità",
    "Project Management: ha fornito feedback sull'usabilità delle pagine di pianificazione e capacity, "
    "in particolare sul sistema di agganciamento delle date",
])
para("Questa modalità di lavoro \"spalla a spalla\" con gli utenti ha avuto due effetti importanti:")
add_numbered([
    "Funzionalità mirate al bisogno reale, non a quello ipotizzato",
    "Adozione spontanea dello strumento, perché gli utenti si sono sentiti coinvolti nella sua costruzione",
])

doc.add_heading("8.5 Raccolta feedback e prioritizzazione", level=2)
para("Il feedback degli utenti è stato raccolto in modo continuo, attraverso:")
add_bullets([
    "Conversazioni dirette",
    "Screenshot e segnalazioni puntuali",
    "Test in scenari reali",
])
para("Ogni segnalazione è stata classificata in tre categorie:")
add_numbered([
    "Bug — un comportamento non corretto rispetto alle aspettative",
    "Miglioramento — una funzionalità esistente che può essere resa più efficace",
    "Nuova funzionalità — qualcosa che oggi non c'è",
])
para("E in tre livelli di priorità:")
add_numbered([
    "Critica — blocca l'operatività o causa perdita di dati",
    "Alta — rende difficile o lento svolgere un'operazione",
    "Media/Bassa — miglioramenti di esperienza utente, ottimizzazioni",
])
para(
    "Le criticità sono state risolte prima di passare ad altre attività. Ogni rilascio ha incluso una "
    "combinazione equilibrata di fix critici, miglioramenti e (occasionalmente) nuove funzionalità."
)

doc.add_heading("8.6 Cronologia delle principali release", level=2)
add_table(
    ["Versione", "Tema principale"],
    [
        ["1.0.0", "Prima versione installabile"],
        ["1.0.x (prime release)", "Stabilizzazione del nucleo, prime funzionalità di import"],
        ["1.0.x (release intermedie)", "Introduzione del modulo Risorse (persone, allocazioni, ruoli)"],
        ["1.0.x (successive)", "Pagina Capacity con saturazione e KPI"],
        ["1.0.x (successive)", "Pagina Economics con copertura ruoli"],
        ["1.0.65", "Introduzione del cloud sync con Supabase"],
        ["1.0.66", "Hardening della sincronizzazione: full pull all'avvio per evitare sovrascritture"],
        ["1.0.67", "Fix dedup persone, allocazioni e ruoli"],
        ["1.0.68", "Realtime + Presence + conflict detection"],
        ["1.0.69", "Robustezza del Realtime con fullPull, banner informativo, fix clock drift"],
    ]
)
add_image_placeholder("Timeline o changelog delle versioni principali")

page_break()

# ─── 9. RISULTATI ──────────────────────────────────────────────
doc.add_heading("9. Risultati e Benefici Attesi", level=1)

doc.add_heading("9.1 Benefici quantitativi", level=2)
para("L'introduzione del software porta benefici misurabili in più dimensioni operative.")

doc.add_heading("9.1.1 Tempo di simulazione di uno scenario", level=3)
add_table(
    ["Modalità", "Tempo medio"],
    [
        ["Prima (file Excel separati, copia manuale)", "2–4 ore"],
        ["Oggi (con Scenario What-If)", "5–10 minuti"],
    ]
)

add_info_box(
    "Box informativo — Risparmio di tempo",
    [
        "Per ogni simulazione di scenario, si stima un risparmio di almeno 2 ore di lavoro qualificato.",
        "Considerando 4-5 scenari valutati al mese in un'azienda di queste dimensioni, si tratta di "
        "8-10 ore al mese di lavoro liberato, ovvero più di una giornata uomo per ogni mese.",
    ]
)

doc.add_heading("9.1.2 Tempo di allineamento dati tra reparti", level=3)
add_table(
    ["Modalità", "Tempo medio"],
    [
        ["Prima (mail, telefonate, riallineamenti manuali)", "Decine di minuti per ogni discrepanza, con incertezza residua"],
        ["Oggi (sync real-time)", "Allineamento istantaneo, certezza della \"verità unica\""],
    ]
)

doc.add_heading("9.1.3 Errori da disallineamento dati", level=3)
add_table(
    ["Modalità", "Frequenza errori"],
    [
        ["Prima", "Frequenti, soprattutto su anagrafiche personali"],
        ["Oggi", "Praticamente nulla, grazie a deduplicazione automatica"],
    ]
)

doc.add_heading("9.2 Benefici qualitativi", level=2)
para(
    "Oltre ai benefici quantitativi, l'adozione dello strumento porta vantaggi qualitativi che "
    "difficilmente si traducono in numeri ma sono altrettanto rilevanti."
)

doc.add_heading("9.2.1 Visione condivisa", level=3)
para(
    "Tutti gli stakeholder lavorano sulla stessa fotografia della realtà. Quando in riunione si "
    "discute di una commessa, di un'allocazione o di un'assunzione, non c'è più il dubbio \"ma tu su "
    "che dati stai parlando?\". I dati sono uno solo, e tutti li vedono."
)

doc.add_heading("9.2.2 Decisioni più rapide e basate su dati", level=3)
para(
    "La possibilità di simulare scenari in pochi minuti permette di prendere decisioni informate in "
    "tempi prima impensabili. Una valutazione che prima richiedeva un giorno di lavoro preparatorio "
    "oggi può essere fatta in tempo reale durante una riunione, con benefici immediati sulla velocità "
    "decisionale."
)

doc.add_heading("9.2.3 Autonomia degli operatori", level=3)
para(
    "L'HR può aggiornare l'anagrafica personale senza dover passare attraverso il PM. Il PM può "
    "modificare allocazioni senza dover chiamare l'HR. Il Commerciale può valutare opportunità senza "
    "dipendere da nessuno. Ogni reparto è autonomo nella propria area di competenza, ma vede in tempo "
    "reale ciò che fanno gli altri."
)

doc.add_heading("9.2.4 Tracciabilità", level=3)
para(
    "Ogni modifica è registrata. In caso di domanda, è possibile risalire a chi ha fatto cosa. Non "
    "c'è più ambiguità o responsabilità diluite."
)

doc.add_heading("9.2.5 Riduzione del rischio operativo", level=3)
para(
    "I controlli automatici (saturazione, copertura ruoli, allocazioni in scadenza) segnalano in "
    "anticipo situazioni problematiche. Si interviene prima che il problema diventi critico."
)

doc.add_heading("9.2.6 Conoscenza istituzionalizzata", level=3)
para(
    "La logica di calcolo e le regole di business non sono più nella testa di una singola persona o "
    "nelle formule oscure di un file Excel: sono codificate nel software, documentate, riproducibili. "
    "Anche in caso di assenza di personale chiave, l'azienda non perde il controllo dei propri dati."
)

doc.add_heading("9.3 Ritorno sull'investimento", level=2)
para(
    "Considerando che lo sviluppo è stato sostenuto internamente e che i costi di infrastruttura "
    "cloud sono pari a zero, il ritorno sull'investimento è immediato. Già nel primo mese di adozione, "
    "il tempo risparmiato dagli utenti chiave ripaga ampiamente l'investimento iniziale."
)

add_info_box(
    "Box informativo — Costo totale di esercizio",
    [
        "Costo licenze software: 0 €/mese",
        "Costo infrastruttura cloud (Supabase): 0 €/mese (piano gratuito)",
        "Costo distribuzione (GitHub Releases): 0 €/mese",
        "Costo manutenzione: dipende dalle necessità di evoluzione, ma trascurabile a regime",
    ]
)
add_image_placeholder("Grafico riepilogativo dei benefici / KPI")

page_break()

# ─── 10. ROADMAP ───────────────────────────────────────────────
doc.add_heading("10. Roadmap Futura", level=1)
para(
    "Il software è in esercizio operativo, ma il lavoro non è concluso. L'approccio iterativo che ha "
    "caratterizzato il progetto continua, e sono già in pianificazione una serie di evoluzioni future."
)

doc.add_heading("10.1 Evoluzioni di breve termine", level=2)

doc.add_heading("10.1.1 Dashboard riepilogativa multi-scenario", level=3)
para(
    "Una pagina iniziale che, a colpo d'occhio, mostri lo stato di tutti gli scenari attivi: KPI "
    "principali per ognuno, confronti diretti, alert su criticità. Sarà la \"home page\" naturale "
    "per la Direzione."
)

doc.add_heading("10.1.2 Report PDF automatici per il management", level=3)
para(
    "Un sistema di generazione automatica di report PDF preimpostati, da generare con un click e da "
    "allegare alle mail per la Direzione. Conterrà sintesi grafiche, tabelle riepilogative, indicatori chiave."
)

doc.add_heading("10.1.3 Notifiche e alert proattivi", level=3)
para("Avvisi automatici all'apertura dell'app per condizioni che richiedono attenzione:")
add_bullets([
    "Allocazioni in scadenza nei prossimi 30 giorni",
    "Persone sotto-allocate per più di 2 mesi consecutivi",
    "Commesse senza copertura dei ruoli necessari",
    "Sforamenti di budget",
])

doc.add_heading("10.1.4 Storico scenari e versioning", level=3)
para(
    "Possibilità di tornare a una versione precedente di uno scenario (snapshot periodici), utile "
    "per analisi retroattive e per recuperare configurazioni \"perse\"."
)

doc.add_heading("10.2 Evoluzioni di medio termine", level=2)

doc.add_heading("10.2.1 Integrazione con sistemi gestionali esistenti", level=3)
para(
    "Connettori automatici con il software gestionale aziendale per evitare la doppia digitazione "
    "dei dati anagrafici delle persone e delle commesse. La sincronizzazione potrebbe avvenire una "
    "volta al giorno, in modo trasparente all'utente."
)

doc.add_heading("10.2.2 Drag & drop nelle allocazioni", level=3)
para(
    "Interfaccia visuale per trascinare le persone da una commessa all'altra, evitando di compilare "
    "form. Particolarmente utile per riallocazioni rapide."
)

doc.add_heading("10.2.3 Filtri salvabili", level=3)
para(
    "Possibilità di salvare combinazioni di filtri come preset, per richiamarle rapidamente senza "
    "riselezionarle ogni volta."
)

doc.add_heading("10.2.4 Note e commenti sugli scenari", level=3)
para(
    "Campo per documentare le ipotesi dietro ogni scenario, in modo che la conoscenza dietro le "
    "decisioni resti tracciata."
)

doc.add_heading("10.3 Evoluzioni di lungo termine", level=2)

doc.add_heading("10.3.1 Modulo di previsione", level=3)
para("Un modulo predittivo che, sulla base dei dati storici, suggerisca:")
add_bullets([
    "Quali commesse hanno maggiore probabilità di slittare",
    "Quali ruoli saranno sotto-coperti nei mesi futuri",
    "Quali assunzioni anticipare",
])

doc.add_heading("10.3.2 Mobile companion app", level=3)
para(
    "Un'app per smartphone che permetta di consultare i KPI principali e ricevere notifiche, per "
    "i manager in mobilità."
)

doc.add_heading("10.3.3 Estensione ad altre business unit", level=3)
para(
    "Adattamento dello strumento a business unit con dinamiche diverse (ad esempio per progetti più "
    "piccoli, con pianificazione settimanale anziché mensile)."
)
add_image_placeholder("Roadmap visuale a fasi")

page_break()

# ─── 11. CONCLUSIONI ───────────────────────────────────────────
doc.add_heading("11. Conclusioni", level=1)
para(
    "Il progetto Analisi Scenari VDP — Scenario What-If rappresenta un esempio concreto di come, con "
    "un investimento contenuto e una metodologia rigorosa, sia possibile costruire internamente uno "
    "strumento software che dia un vantaggio competitivo tangibile."
)
para("Le scelte tecnologiche sono state guidate da tre principi:")
add_numbered([
    "Robustezza — usare tecnologie mature, ampiamente diffuse, supportate",
    "Sostenibilità economica — minimizzare i costi ricorrenti, usando dove possibile servizi cloud gratuiti",
    "Manutenibilità — strutturare il codice in modo che sia comprensibile, modulare, evolvibile",
])
para(
    "Il risultato è un'applicazione che oggi è in produzione, utilizzata quotidianamente da utenti di "
    "reparti diversi, capace di gestire la complessità operativa di un'impresa di costruzioni con la "
    "stessa naturalezza con cui si usa un foglio Excel — ma con tutti i vantaggi di un sistema "
    "strutturato, condiviso, sicuro."
)
para(
    "I prossimi mesi vedranno l'evoluzione del software lungo le direttrici descritte nella roadmap, "
    "sempre con la stessa logica che ha caratterizzato lo sviluppo finora: iterazioni rapide, feedback "
    "continuo dagli utenti, attenzione alla qualità."
)
para(
    "L'investimento fatto è destinato a ripagarsi non solo in termini di tempo risparmiato, ma soprattutto "
    "in termini di qualità delle decisioni che la Direzione potrà prendere disponendo di informazioni "
    "sempre aggiornate, complete e affidabili. In un settore dove la marginalità si gioca sui dettagli e "
    "la competizione è serrata, questo è un vantaggio che si traduce direttamente in risultati di business."
)
add_image_placeholder("Vista finale dell'app o slide di chiusura")

page_break()

# ─── 12. APPENDICE ─────────────────────────────────────────────
doc.add_heading("12. Appendice — Glossario tecnico essenziale", level=1)
add_table(
    ["Termine", "Significato"],
    [
        ["Backlog", "Portafoglio di commesse già acquisite"],
        ["Order Intake", "Acquisizioni di nuove commesse"],
        ["Pipeline", "Opportunità commerciali non ancora certe"],
        ["FTE (Full-Time Equivalent)", "Unità di misura della forza lavoro: 1 FTE = una persona impiegata al 100%"],
        ["Scenario What-If", "Analisi di impatto di un'ipotesi alternativa rispetto allo stato di fatto"],
        ["Saturazione", "Percentuale di tempo lavorativo allocata di una persona"],
        ["Sotto-assorbimento", "Situazione in cui il costo del personale eccede il valore probabilizzato delle commesse"],
        ["Sovra-assorbimento", "Situazione opposta: valore delle commesse superiore al costo del personale"],
        ["Probabilizzato", "Valore atteso, calcolato come valore × probabilità di acquisizione"],
        ["Baseline", "Stato di riferimento da cui partono gli scenari alternativi"],
        ["Frontend", "Parte del software che gira sul PC dell'utente, con cui interagisce"],
        ["Backend", "Parte del software che gira su server, gestisce dati e logica condivisa"],
        ["Database", "Archivio strutturato dei dati"],
        ["Cloud", "Infrastruttura informatica accessibile via internet"],
        ["Real-time", "Comunicazione che avviene istantaneamente, in tempo reale"],
        ["Sync (Sincronizzazione)", "Allineamento di dati tra due o più copie"],
        ["Push", "Operazione di invio dati dal client al server"],
        ["Pull", "Operazione di scaricamento dati dal server al client"],
        ["Offline-first", "Architettura in cui l'app funziona sempre, anche senza connessione"],
        ["Auto-update", "Sistema che aggiorna automaticamente l'app all'ultima versione"],
        ["RLS (Row Level Security)", "Sicurezza applicata a livello di singola riga del database"],
        ["Audit log", "Registro automatico delle modifiche fatte ai dati"],
        ["Token", "Codice di autorizzazione temporaneo, sostituisce credenziali in chiaro"],
        ["Conflict detection", "Rilevamento di modifiche concorrenti per evitare sovrascritture"],
        ["Deduplicazione", "Eliminazione di copie duplicate di una stessa entità"],
    ]
)

para("", size=8)
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(30)
r = p.add_run("Documento redatto a cura dell'ufficio di sviluppo interno di Impresa B4T.")
r.italic = True
r.font.size = Pt(9)
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run("Versione del software descritta: 1.0.69")
r.italic = True
r.font.size = Pt(9)

# ─── SALVA ─────────────────────────────────────────────────────
output_path = r"C:\Users\fabrizio.tacchino\Desktop\Relazione_ScenarioWhatIf_v1.docx"
doc.save(output_path)
print(f"File salvato: {output_path}")
