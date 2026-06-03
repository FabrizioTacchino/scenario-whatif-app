# ISTRUZIONI VINCOLANTI — LEGGI PRIMA DI TUTTO

## Vincolo #1 — Non-regressione (NON NEGOZIABILE)

L'applicazione deve continuare a funzionare al 100% durante e dopo l'integrazione del modulo costi. Se nascondi via feature flag il pulsante
"Costi", l'app deve comportarsi **identicamente** alla versione precedente. Questo è il vincolo più importante della specifica.

**Conseguenze operative (rispetta tutte, sempre)**:

- Ogni accesso a `scenario.costi`, `scenario.costiSnapshot`, `scenario.bilImportMeta` deve essere **sempre** con guard difensivo (es.
  `scenario.costi || {}`). Gli scenari già salvati prima del modulo costi avranno questi campi a `undefined`: l'app non deve crashare.
- **Nessuna modifica** alla struttura di campi esistenti negli scenari (`inputs`, `importedData`, `monthlyData`, `commesse`, `filters`, ecc.).
  Solo aggiunte.
- **Nessuna modifica** al parser baseline ricavi (`dataLoader.parseExcel`), a `scenarioEngine.computeScenario`, alla dashboard ricavi, al modulo
  Risorse esistenti. Il modulo costi è un **layer parallelo**, non un refactor di quello che c'è.
- **Feature flag** `WHATIF_COSTI_ENABLED` (booleano in `main.js` o costante esportata) che, se `false`, nasconde: tab principale "Costi", pannello
  costi per-scenario, pulsante import BI, riferimenti UI ai costi. Default `true` in sviluppo, controllabile per release.
- **Backup/restore**: i backup creati prima del modulo costi (senza dati costi) devono restare importabili senza errori. I backup creati dopo
  devono restare leggibili da versioni dell'app pre-modulo (campi extra semplicemente ignorati, non crash).
- **Cloud sync**: ogni colonna nuova su Supabase deve essere **additiva e nullable** (JSONB nullable). Nessun ALTER che rompa il record
  `scenarios` esistente. Nessun trigger che blocchi le scritture vecchie.
- **Versione minima push**: NON alzare `min_push_version` solo per il modulo costi. Le app vecchie devono continuare a pushare ricavi. Solo le
  funzioni costi richiedono la versione nuova.
- **Database**: ogni migrazione deve essere reversibile o comunque non distruttiva. Mai droppare colonne. Mai rinominare colonne esistenti. Mai
  modificare tipi di colonne esistenti.
- **Test di regressione manuale obbligatori** prima di considerare completata ogni fase. Verifica a mano che continuino a funzionare: dashboard
  ricavi, gestione assumptions, lock/unlock VDP, export ricavi, modulo risorse, sync cloud (push/pull/merge), backup/restore, login/permessi,
  gestione versioni minime.
- Se durante l'implementazione scopri un caso in cui per integrare i costi devi modificare logica esistente: **fermati e chiedi**. Non procedere
  "perché tanto è uguale". Non ci sono shortcut accettabili su questo vincolo.

## Vincolo #2 — Modalità di lavoro (NON NEGOZIABILE)

Non iniziare a scrivere codice subito. Procedi così:

1. **Leggi tutto il documento** che segue, integralmente, prima di rispondere.
2. **Genera un piano di implementazione** suddiviso in punti numerati piccoli e indipendenti. Ogni punto deve essere:
   - Mergeabile da solo senza rompere l'app (vincolo #1)
   - Verificabile manualmente (cosa testare per dare per buono il punto)
   - Stimato in dimensione (S / M / L)
3. **Presenta il piano** all'utente e aspetta approvazione **prima** di toccare codice.
4. Una volta approvato il piano, **implementa un punto alla volta**:
   - Annuncia quale punto stai per fare e cosa cambierai
   - Implementa solo quel punto
   - Mostra cosa hai fatto e quali test di regressione l'utente deve fare
   - **Aspetta conferma esplicita** prima di passare al punto successivo
5. Se durante un punto emergono dubbi o ambiguità sulla specifica, **fermati e chiedi**. Mai assumere. Mai indovinare. La specifica può essere
   incompleta in dettagli che scoprirai solo implementando: in quel caso porta la domanda, non risolverla unilateralmente.
6. Se durante un punto scopri che la specifica è in conflitto con il vincolo #1 (non-regressione), **fermati e chiedi** come procedere. Il vincolo
   #1 vince sempre, ma la decisione su come riconciliare è dell'utente.

Non avere fretta. Non c'è premio nel finire prima. C'è solo il rischio di rompere qualcosa che funziona.

# Modulo Costi — Specifica di implementazione

## 1. Contesto e obiettivo

L'app **Scenario What-if** gestisce oggi la dimensione **ricavi (VDP)** con baseline importata da Excel, scenari modificabili (shift, ritardo, probabilità, margine, tipo), dashboard e report comparativi. Si introduce una seconda dimensione **costi** con la stessa logica di storicizzazione per scenario.

**Obiettivi**:

1. Importare i costi di commessa da un export aziendale Business Intelligence (BI).
2. Modificare manualmente costi suddivisi per **categoria merceologica** tramite 5 parametri (inizio / durata / fine / curva / totale futuro).
3. Generare un **Conto Economico comparativo** fra due scenari, uno "Attuale" e uno "di riferimento".
4. Storicizzare i costi insieme allo scenario: quando lo scenario è bloccato, ricavi e costi sono un'unica fotografia congelata.

**Vincolo architetturale**: ogni scenario vive di luce propria. Sia VDP che costi sono **per-scenario**, non globali. Ogni scenario salva la propria copia completa dei dati costi, incluso l'AC al momento dell'import.

---

## 2. Glossario

| Termine                                  | Significato                                                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Categoria merceologica**               | Una delle 13 classificazioni del Piano dei Conti (vedi §4), + eventuale 14ª "NON ALLOCATO"                                              |
| **Peso consigliato**                     | Frazione del costo totale commessa che una categoria rappresenta di default, quando generata automaticamente da margine (cold-start OI) |
| **Curva (profilo)**                      | Funzione di distribuzione mensile dell'importo: Uniforme o gaussiana parametrica (S-curve, Custom)                                      |
| **Parametro `a`**                        | Posizione relativa del picco della gaussiana, `a ∈ [0,1]`: 0=inizio, 1=fine, 0.5=centro                                                 |
| **AC (Actual Cost)**                     | Costo effettivo storico rilevato dalla BI, immodificabile nello scenario                                                                |
| **Remaining (Costo BAC)**                | Costo residuo pianificato, futuro rispetto al mese di cutoff del BI                                                                     |
| **Cutoff mese**                          | Ultimo mese con AC valorizzato nel file BI → data oltre la quale inizia la proiezione futura                                            |
| **Totale futuro (ReTo Go)**              | Somma dei costi futuri di una categoria, distribuiti via curva                                                                          |
| **Totale categoria**                     | Σ AC + Σ futuro — mostrato ma non editabile direttamente                                                                                |
| **Scenario Attuale**                     | Lo scenario selezionato dal menu principale (quello che si sta guardando/editando)                                                      |
| **Scenario di riferimento di confronto** | Altro scenario o Baseline, scelto da dropdown nel report, contro cui si confronta lo Scenario Attuale                                   |
| **Snapshot costi**                       | Valori mensili congelati al momento del lock scenario                                                                                   |

---

## 3. Modello dati

### 3.1 Struttura per-scenario (estensione di `scenarioManager.js`)

Aggiungere ai campi esistenti di ogni scenario:

```js
{
  id, name, notes, type, inputs, importedData, createdBy, createdAt, updatedAt, locked,  // esistenti

  // NUOVO — dati costi dello scenario
  costi: {
    [commessaKey]: {                 // chiave = codice|nome (come nell'app ricavi)
      categorie: {
        [categoriaId]: {             // uno degli id fissi in §4 (es. 'sub_contratti', 'materiale_diretto', ...)
          // Parametri curva (modificabili da utente)
          dataInizio: "YYYY-MM",
          durata: number,                        // mesi
          dataFine: "YYYY-MM",                   // coerente con dataInizio + durata - 1
          tipoCurva: "uniforme" | "s_curve" | "s_curve_inizio" | "s_curve_fine" | "custom_1" | "custom_2" | "custom_3",
          importoFuturo: number,                 // Remaining To Go (totale costi futuri)

          // Dati storici (immodificabili, popolati da import BI)
          acStorico: {
            [mese: "YYYY-MM"]: number            // valore AC mensile
          },

          // Meta
          baselineCostoOriginale: number | null, // somma "Baseline Costo" al primo import (solo info storica)
          origine: "bi_import" | "cold_start_margine" | "manuale" | "copiato_da_scenario"
        }
      }
    }
  },

  // Metadati ultimo import BI su questo scenario
  bilImportMeta: {
    dataImport: ISOString,
    cutoffMese: "YYYY-MM",                       // ultimo mese con AC > 0 nell'import
    userEmail: string,
    commesseImportate: [commessaKey, ...],       // elenco di chi ha ricevuto override
    fileName: string
  } | null,

  // Snapshot costi mensilizzato (popolato SOLO quando scenario è locked)
  costiSnapshot: {
    [commessaKey]: {
      [categoriaId]: {
        [mese: "YYYY-MM"]: number                // valore mensile totale (AC passato + curva futuro, già post-shift/ritardo/probabilità)
      }
    }
  } | null
}
```

### 3.2 LocalStorage keys nuove

- `whatif_cost_defaults` — override della tabella pesi/curve default (se admin modifica i default). Se assente → hardcoded da §4.
- (I costi per-scenario vivono **dentro** lo scenario già salvato in `whatif_scenarios`, nessuna chiave separata.)

> **IMPORTANTE** (vedi `MEMORY.md → feedback_backup_check`): ogni nuova key va aggiunta al backup/restore in `syncManager.js`.

### 3.3 Schema Supabase (cloud sync)

Aggiungere colonna JSONB agli scenari cloud oppure tabelle dedicate. Scelta di design (da confermare prima di migrare):

**Opzione A** — tutto dentro il record scenario (JSONB `costi`, `bilImportMeta`, `costiSnapshot`). Semplice ma record grossi.

**Opzione B** — tabelle relazionali:

- `scenario_costi(scenario_id, commessa_key, categoria_id, data_inizio, durata, data_fine, tipo_curva, importo_futuro, baseline_costo_originale, origine)`
- `scenario_costi_ac(scenario_id, commessa_key, categoria_id, mese, valore)` — uno-per-mese
- `scenario_costi_snapshot(scenario_id, commessa_key, categoria_id, mese, valore)` — popolata solo per scenari locked

Raccomandazione: **Opzione A** per v1 (meno migrazioni, coerente con `inputs`/`importedData` esistenti). Valutare B se i volumi crescono.

---

## 4. Categorie merceologiche — elenco fisso

Da `Screenshot/ImpostazioneDefaultCosti.xlsx`. Pesi e curve usati solo per **cold-start OI** (generazione automatica da margine quando non esiste scenario precedente o import BI).

| #   | id interno                 | Etichetta                          | Peso default | Curva default | Param `a` | Note                                                                     |
| --- | -------------------------- | ---------------------------------- | -----------: | ------------- | --------: | ------------------------------------------------------------------------ |
| 1   | `sub_contratti`            | VALORE SUB-CONTRATTI               |       77.15% | S-curve       |       0.5 |                                                                          |
| 2   | `materiale_diretto`        | MATERIALE ACQUISTATO DIRETTO       |       12.91% | S-curve       |       0.5 |                                                                          |
| 3   | `materiale_indiretto`      | MATERIALE INDIRETTO                |        0.51% | S-curve       |       0.5 |                                                                          |
| 4   | `personale_diretto`        | COSTO PERSONALE DIRETTO            |        4.46% | S-curve       |       0.5 |                                                                          |
| 5   | `consulenze_progettazione` | CONSULENZE PROGETTAZIONE           |        2.40% | S-curve       |       0.5 |                                                                          |
| 6   | `consulenze_generali`      | CONSULENZE GENERALI                |        0.16% | Uniforme      |       1.0 |                                                                          |
| 7   | `consulenze_tecniche`      | CONSULENZE TECNICHE/SPECIALISTICHE |        0.18% | S-curve       |       0.5 |                                                                          |
| 8   | `consulenze_hse_tqm`       | CONSULENZE HSE E TQM               |        0.17% | Uniforme      |       1.0 |                                                                          |
| 9   | `noleggi_diretti`          | NOLEGGI DIRETTI                    |        1.42% | S-curve       |       0.5 |                                                                          |
| 10  | `costi_utenze`             | COSTI UTENZE                       |        0.29% | Uniforme      |       1.0 |                                                                          |
| 11  | `penali_riaddebito`        | PENALI RIADDEBITO FORNITORI [-]    |        0.00% | Uniforme      |       1.0 | Non generata da default; entra solo via BI                               |
| 12  | `contingency`              | CONTINGENCY COSTI                  |        0.35% | S-curve       |       0.5 |                                                                          |
| 13  | `non_allocato`             | NON ALLOCATO                       |        0.00% | Uniforme      |       1.0 | Non generata da default; entra solo via BI (righe con Descrizione vuota) |

Somma pesi = **100%** sulle 13 "attive" (escludendo penali e non allocato).

### Profili di curva disponibili per override utente

| Profilo        | Param `a` | Descrizione                                    |
| -------------- | --------: | ---------------------------------------------- |
| Uniforme       |       1.0 | Distribuzione lineare piatta                   |
| S-curve inizio |       0.3 | Picco nei primi mesi                           |
| S-curve (std)  |       0.5 | Curva S standard, picco al centro              |
| S-curve fine   |       0.7 | Picco nella fase finale                        |
| Custom-1       |      0.35 | Picco anticipato leggero                       |
| Custom-2       |      0.55 | Distribuzione centrale stretta (sigma ridotto) |
| Custom-3       |      0.65 | Picco posticipato leggero                      |

**DI CUI RISERVE**: non è un costo, **non entra nel modello costi**. Eventualmente trattato separatamente come ricavo potenziale in una futura iterazione.

---

## 5. Algoritmi

### 5.1 Generazione curva mensile

Per una categoria con `dataInizio`, `durata N mesi`, `tipoCurva`, `importoFuturo T`:

1. Costruisci l'array di mesi `M = [dataInizio, dataInizio+1, ..., dataInizio+N-1]`.
2. Se `tipoCurva === "uniforme"`:
   - `peso[i] = 1 / N` per ogni i
3. Altrimenti (gaussiana):
   - `μ = a × (N - 1)` (posizione del picco, 0-based)
   - `σ = N × k` dove `k = 1/6` per curve standard, `k = 1/8` per Custom-2 (centrale stretta)
   - Per ogni `i ∈ [0, N-1]`: `w[i] = exp(-((i - μ)² / (2σ²)))`
   - Normalizza: `peso[i] = w[i] / Σ w[j]`
4. Valori mensili: `mese[M[i]] = T × peso[i]`

### 5.2 Applicazione delle modifiche scenario

Ordine di applicazione sulla timeline mensile di ogni categoria:

1. **Base**: valori mensili da curva (come §5.1) per la parte futuro + AC storico per la parte passata.
2. **Scala probabilità** (solo OI): se `probabilità ≠ probabilitàFile`, moltiplica **tutti** i valori (AC + futuro) per `probScale = probabilitàNuova / probabilitàFile`. ⚠ Decisione di design: scala anche l'AC per coerenza con il ricavo (VDP), confermato in discovery.
3. **Shift** (shiftStart mesi): sposta ogni mese della categoria di N posizioni avanti/indietro tramite `shiftMonth()` (riutilizzare funzione esistente in `scenarioEngine.js:12`).
4. **Ritardo/smoothing**: applica `applyDelaySmoothing()` **per categoria** (non sul totale commessa), in cascata dopo lo shift. Riutilizzare funzione esistente `scenarioEngine.js:91`.

### 5.3 Cold-start OI (generazione automatica costi)

Quando una commessa OI non ha dati costi in questo scenario e non si trova uno scenario precedente da cui copiare:

```
costoTotaleCommessa = VDP_totale × (1 - margineAOP)
dataInizioCommessa = primo mese con vdpAOP > 0 nella baseline ricavi
dataFineCommessa  = ultimo mese con vdpAOP > 0 nella baseline ricavi
durataCommessa    = dataFineCommessa - dataInizioCommessa + 1

per ogni categoria con peso > 0:
  importoFuturo = costoTotaleCommessa × pesoCategoria
  dataInizio    = dataInizioCommessa
  durata        = durataCommessa
  dataFine      = dataFineCommessa
  tipoCurva     = curva default da §4
  acStorico     = {} (vuoto)
```

### 5.4 Copia da scenario precedente

Ordine di fallback per popolare costi di una commessa in un nuovo scenario.
**Differenziato per tipo scenario (decisione emersa in P-fix mid-implementation):**

**Scenari `calculated`**:
1. Se lo scenario ha già costi per quella commessa → usa quelli
2. Altrimenti cerca lo **scenario precedente più recente** (per `updatedAt`) che contiene costi per quella commessa → copia (deep clone)
3. Altrimenti, se la commessa è **OI** → cold-start da margine (§5.3)
4. Altrimenti (Backlog senza scenari precedenti né BI) → struttura vuota

**Scenari `imported`** (ogni scenario imported è una *fotografia autonoma*):
1. Se lo scenario ha già costi per quella commessa → usa quelli
2. Altrimenti **cold-start direttamente dai mesi importati** in `scenario.importedData[commessaKey]`. **Nessuna copia da scenario precedente** (l'utente vuole che ogni scenario imported viva di luce propria). Cold-start usa il margine effettivo (override `inputs.margine` → `commessa.margineAOP`) e `vdpTotal` derivato dai mesi sorgente se la commessa è "extra" e non ha `vdpTotale` popolato.

### 5.5 Matching commessa durante import BI

Chiave primaria: **Codice Commessa** (campo separato nel BI aggiornato). Algoritmo:

1. Per ogni riga del BI → estrai `codiceBI`, `nomeBI`.
2. Cerca in `getCommesseForScenario(scenario, baseline)` (pool dello scenario, **non solo baseline**) una commessa con `codice.toUpperCase().trim() === codiceBI.toUpperCase().trim()`.
3. Se trovato → suggerisci quella come target (match automatico, checkbox "Importa" attivo di default).
4. Se non trovato → riga marcata come "⚠ nessuna corrispondenza"; l'utente può digitare nell'input override.
5. Il nome è **informativo**.

### 5.6 Sorgente date e shift effettivo (display)

**Date "base" vs "effettive"**:
- I parametri della categoria (`cat.dataInizio`, `cat.dataFine`) sono salvati come **date PRE-shift** (raw) per coerenza con la pipeline `computeCategoriaMensile`.
- Nel display delle celle, l'utente vede sempre le **date EFFETTIVE post-shift** (`shiftMonth(cat.dataInizio, scenarioShift)`).
- Quando l'utente edita una data nel display, il valore viene "smontato" dello shift al salvataggio (`cat.dataInizio = shiftMonth(input.value, -scenarioShift)`).

Questo permette modifiche live: se l'utente cambia `shiftStart` dell'inputs scenario, le date mostrate nelle celle si aggiornano automaticamente al re-render.

### 5.7 Pool commesse per scenario

Il pannello costi mostra **le commesse "viste" dallo scenario corrente**, non solo quelle della baseline:

```js
function getCommesseForScenario(scenario, baseline) {
  if (scenario.type === 'imported' && scenario.importedData) {
    // chiavi di importedData, metadata da baseline.commesse o scenario.newCommesse
  } else {
    // baseline.commesse + scenario.newCommesse (calculated)
  }
}
```

Sorgente date al cold-start:
- Scenario `imported` → mesi di `importedData[commessaKey]` (filtrati per `actual+remaining > 0`)
- Scenario `calculated` → mesi di `baseline.monthlyData[commessaKey]` (filtrati per `vdpAOP > 0`)

---

## 6. Report Conto Economico comparativo

### 6.1 Struttura layout

Riproduce `Screenshot/ContoEconomicoExportTipo.xlsx` aggiornato. Tabella pivot con:

- **Righe**:
  - Riga intestazione **RICAVO ACT** → VDP mensile totale (dalla baseline ricavi). Unico valore, non split per categoria.
  - Riga per ogni **categoria merceologica** (13 + eventuale 14ª NON ALLOCATO)
  - Riga finale **Totale complessivo** = Σ categorie

- **Colonne** (per ogni mese nel range del filtro data):
  - `{MeseAnno} Mese`: valori del singolo mese
    - Sotto-colonna `Scenario di riferimento di confronto`
    - Sotto-colonna `Scenario Attuale`
    - Sotto-colonna `Differenza` = Attuale − Riferimento
  - `{MeseAnno} Progressivo`: valori cumulati fino a quel mese
    - Stesse 3 sotto-colonne

### 6.2 UI di selezione

Sopra la tabella:

- **Tab principale**: rinominato **"Comparison Costi"** (parallelo a "Comparison VDP" — etichetta cambiata in implementazione per coerenza)
- **Scenario Attuale**: indicatore (non editabile qui) del menu principale tendina scenario
- **Dropdown "Scenario di riferimento di confronto"**: elenco di tutti gli altri scenari salvati (lock 🔒 indicato), default vuoto fino a selezione utente
- **Pulsante "📄 Esporta Excel"** allineato a destra
- **Filtri**: ereditati dai filtri globali dell'app (settore, tipo, commessa, data from/to). Tutti i filtri impattano in tempo reale il pool e i totali

### 6.3 Semantica "Baseline" nel dropdown

- Per i **ricavi**, Baseline = VDP dal file Excel importato → già esistente
- Per i **costi**, Baseline **non esiste** come entità autonoma (non c'è mai stato un import BI "baseline globale"). Opzioni:
  - **(a)** Baseline nel dropdown costi mostra valori = 0 per tutte le categorie → poco informativo
  - **(b)** Baseline nel dropdown costi NON è selezionabile, si offrono solo scenari con dati costi
  - **(c)** "Baseline" equivale allo scenario più vecchio con dati costi

Raccomandazione: **(b)** + label "Nessun dato costi sulla Baseline" se l'utente la sceglie per sbaglio. Da validare.

### 6.4 Export Excel del report

Pulsante "Esporta Conto Economico" → genera `.xlsx` con stessa struttura di `ContoEconomicoExportTipo.xlsx`, riutilizzando `exportManager.js`.

---

## 7. Flusso import BI

### 7.1 Trigger

Tab "Costi" (pannello per-scenario) → pulsante **"Importa da BI"** → file picker (`.xlsx`).

### 7.2 Parsing

Legge foglio `Export` (o primo foglio). Colonne attese:

```
Codice Commessa | Nome Commessa | Data - Anno | Data - Mese | Descrizione | Baseline Costo | AC | Remaining Costo BAC
```

- Tolleranza maiuscolo/minuscolo + spazi
- `Descrizione` vuota → categoria `non_allocato`
- Categorie mappate esattamente alle 13 stringhe canoniche (+ `non_allocato`); categoria non riconosciuta → errore bloccante con lista delle stringhe ignote
- Mese in italiano (`gennaio`, `febbraio`, ...) → convertito in `YYYY-MM`

### 7.3 Dialog "Conferma import"

UI tabellare con una riga per **ogni codice commessa** trovato nel BI:

| ☑ Importa | Codice BI | Nome BI           | Commessa app (suggerita)   | Override commessa app             |
| --------- | --------- | ----------------- | -------------------------- | --------------------------------- |
| ☑         | C23-03    | GE_CAMPUS ERZELLI | C23-03 — Campus Erzelli    | [dropdown: tutte le commesse app] |
| ☑         | C24-01    | GE_ALFA           | _nessuna corrispondenza_ ⚠ | [dropdown obbligatorio]           |
| ☐         | C22-99    | GE_BETA           | C22-99 — Beta              | —                                 |

Colonne:

- **Importa (checkbox)**: default ON se match trovato, OFF se no match
- **Commessa app suggerita**: match per codice (§5.5). Se nessun match → warning
- **Override commessa app (dropdown)**: sempre presente, permette scelta manuale anche per match trovato (utile quando codice BI è sbagliato o è cambiato)

Sotto la tabella:

- Mese di cutoff dedotto (`max(Data BI | AC > 0)`)
- Pulsante **"Importa commesse selezionate"**
- Pulsante **"Annulla"**

### 7.4 Validazione Remaining vs Data Fine commessa

Per ogni commessa importata, prima di scrivere i dati:

- Calcola `lastRemainingMonth = max(mese | RemainingCostoBAC > 0)`
- Confronta con `dataFineCommessa` dalla baseline ricavi (o dallo scenario, dopo shift/ritardo)

Se `lastRemainingMonth > dataFineCommessa`:

**Alert modale** per commessa:

> La commessa **C23-03 Campus Erzelli** ha costi rimanenti oltre la data fine prevista (`YYYY-MM`).
> Ultimo mese con Remaining > 0: `YYYY-MM`.
>
> Scegli come procedere:
>
> - **Estendi orizzonte costi** fino a `YYYY-MM` — lascia il VDP invariato, solo i costi superano la data fine commessa
> - **Comprimi nell'ultimo mese** — i valori Remaining oltre data fine vengono sommati tutti sull'ultimo mese disponibile (totale preservato)
>
> La scelta vale solo per questa commessa in questo import.

### 7.5 Esito import

Per ogni commessa importata:

1. Sovrascrivi `scenario.costi[commessaKey]` con struttura nuova da BI
2. Popola `acStorico` con valori mese×categoria dove `AC > 0`
3. Deriva `dataInizio`, `durata`, `dataFine`, `importoFuturo` da `Remaining Costo BAC`:
   - `dataInizio` = primo mese con `Remaining > 0`
   - `dataFine` = ultimo mese con `Remaining > 0` (eventualmente aggiustato da §7.4)
   - `durata` = dataFine − dataInizio + 1
   - `importoFuturo` = Σ Remaining (eventualmente compresso)
4. `tipoCurva` = default da tabella §4 (non derivato dai dati, mappatura fissa)
5. `baselineCostoOriginale` = Σ `Baseline Costo` (solo al **primo** import, nei successivi lasciato intatto)
6. Aggiorna `scenario.bilImportMeta`
7. Segna scenario `updatedAt = now`, push cloud se connesso

### 7.6 Scenario locked

Se lo scenario corrente è `locked`, **rifiuta l'import** con alert:

> Scenario bloccato. Sbloccalo prima di importare dati BI.

Non offrire import parziale.

---

## 8. Editing manuale per-scenario

### 8.1 UI per-commessa

Nel pannello "Costi" per-scenario, una volta selezionata una commessa (dropdown o tab annidato per commessa):

Tabella **parametri per categoria**:

| Categoria            | Data Inizio | Durata | Data Fine | Curva   | Importo Futuro | AC storico |    Totale | Azioni           |
| -------------------- | ----------- | ------ | --------- | ------- | -------------: | ---------: | --------: | ---------------- |
| VALORE SUB-CONTRATTI | 2026-01     | 55     | 2030-07   | S-curve |      5 000 000 |    850 000 | 5 850 000 | 🗑 reset default |
| MATERIALE DIRETTO    | 2026-01     | 55     | 2030-07   | S-curve |      1 200 000 |    200 000 | 1 400 000 | 🗑 reset default |
| ...                  |             |        |           |         |                |            |           |                  |
| **Totale commessa**  |             |        |           |         |      **TOT_F** | **TOT_AC** |   **TOT** |                  |

Cella editabili: Data Inizio, Durata, Data Fine, Curva, Importo Futuro.

**Coerenza inizio/durata/fine**:

- Se utente modifica Data Inizio → ricalcola Data Fine mantenendo Durata
- Se utente modifica Durata → ricalcola Data Fine mantenendo Data Inizio
- Se utente modifica Data Fine → ricalcola Durata mantenendo Data Inizio

**AC storico non editabile** (immodificabile). Click su cella → mostra un mini-popover con i valori mensili dell'AC per trasparenza.

### 8.2 Grafico mensilizzazione

Sotto la tabella, un grafico (Chart.js, coerente con dashboard esistente) che mostra i 14 mensilizzati sovrapposti oppure stacked, con selettore "Solo futuro | Includi AC | Totale". Aggiorna in tempo reale quando l'utente cambia parametri.

### 8.3 Scenario locked

Se scenario `locked`: tutti gli input sono disabilitati + banner "Scenario bloccato, sblocca per modificare". I valori mostrati vengono da `costiSnapshot`.

---

## 9. Integrazione con modifiche scenario (shift/ritardo/probabilità)

Le modifiche degli `inputs` dello scenario (`shiftStart`, `ritardo`, `probabilita`) già esistenti per i ricavi si propagano automaticamente ai costi secondo §5.2.

Non servono input separati lato UI: quando l'utente modifica `shiftStart` per una commessa OI nella sezione esistente "Assumptions", anche la timeline costi si rigenera in tempo reale.

Esempio:

- Commessa OI con `dataInizio` costi = 2026-01, `shiftStart` = 3 → tutti i mesi AC + futuro scalati a 2026-04
- `ritardo` = 6 → applyDelaySmoothing per categoria dopo shift
- `probabilita` passa da 0.5 a 0.6 → tutti i valori mensili ×1.2

---

## 10. Lock / unlock e storicizzazione

### 10.1 Regole

- Lock scenario → blocca **sia VDP che costi insieme** (non esiste lock parziale)
- Al lock:
  - Calcola `costiSnapshot` = per ogni commessa × categoria × mese → valore totale (AC storico + curva futuro, già post-shift/ritardo/probabilità)
  - Salva in `scenario.costiSnapshot`
  - Persiste in cloud
- Al unlock:
  - Cancella `costiSnapshot` (torna a `null`)
  - L'app ricalcola i valori al volo dai parametri

### 10.2 Rendering con snapshot

Quando renderizzo valori mensili di una categoria:

```js
if (scenario.locked && scenario.costiSnapshot) {
  return scenario.costiSnapshot[commessaKey][categoriaId][mese] || 0;
} else {
  return computeCategoriaMensile(scenario, commessaKey, categoriaId, mese);
}
```

### 10.3 Interazione con modifiche baseline ricavi

Se l'utente **reimporta la baseline VDP** o modifica la data fine di una commessa nella baseline ricavi, gli scenari **locked** restano immutati (i loro snapshot costi non cambiano). Gli scenari **unlocked** ricalcolano al volo.

---

## 11. Permessi

Riutilizza il sistema di ruoli esistente (admin / editor / viewer).

| Azione                          | Admin | Editor | Viewer |
| ------------------------------- | :---: | :----: | :----: |
| Visualizzare costi              |   ✓   |   ✓    |   ✓    |
| Importare da BI                 |   ✓   |   ✓    |   ✗    |
| Editare parametri manualmente   |   ✓   |   ✓    |   ✗    |
| Lock/unlock scenario            |   ✓   |   ✓    |   ✗    |
| Modificare tabella default (§4) |   ✓   |   ✗    |   ✗    |
| Esportare report                |   ✓   |   ✓    |   ✓    |

---

## 12. UI — layout e navigazione

### 12.1 Tab principale "Costi" (comparativo)

Nuovo tab nella navbar principale, accanto a "Dashboard" / "Risorse":

- Report Conto Economico comparativo (§6)
- Selettore scenario di confronto
- Filtri globali ereditati
- Export Excel

### 12.2 Pannello per-scenario "Costi"

Accessibile da "Assumptions" → tab annidato "Costi" dello scenario attualmente selezionato.

- Selettore commessa (dropdown o sidebar)
- Tabella editing categorie (§8.1)
- Grafico mensilizzazione (§8.2)
- Pulsante "Importa da BI" (§7)
- Banner se scenario locked

### 12.3 Pannello admin (settings.json / admin cloud)

Nuova sezione "Default Costi" nel pannello admin:

- Tabella modificabile categorie (id, label, peso, curva default, param a)
- Pulsante "Reset ai default"
- Salvataggio in `app_config` Supabase con chiave `cost_defaults` (stessa struttura di `min_push_version`)

---

## 13. Storage locale e sync cloud

### 13.1 LocalStorage

- Scenari (con nuovi campi `costi`, `bilImportMeta`, `costiSnapshot`) → chiave esistente `whatif_scenarios`
- Override default costi → nuova chiave `whatif_cost_defaults` (solo se admin ha modificato)

### 13.2 Backup / Restore

**CRITICO** (da `MEMORY.md → feedback_backup_check`): aggiungere `whatif_cost_defaults` alla routine backup/restore di `syncManager.js`. I dati costi dentro gli scenari seguono già il flusso scenari.

### 13.3 Supabase

- Aggiungere colonne JSONB a `scenarios` (o nuova tabella se Opzione B §3.3)
- Tabella `app_config` per `cost_defaults` (stessa della `min_push_version`)

### 13.4 Push/pull

- Dedup già esistente per scenari (`MEMORY.md → progetto`)
- I campi `costi`/`costiSnapshot`/`bilImportMeta` si portano dietro con lo scenario
- Alla pull, idratare correttamente le Map / oggetti mensili

---

## 14. Edge cases e validazioni

1. **Import BI su scenario locked** → rifiuta, vedi §7.6.
2. **Codice BI non trovato nell'app** → dialog obbligatorio override (§7.3).
3. **Categoria BI non riconosciuta** → errore bloccante con elenco categorie ignote + hint "aggiungi alias".
4. **Mese BI fuori range baseline ricavi** → consentito (i costi possono avere orizzonte diverso dai ricavi, §7.4).
5. **AC negativo** (penali/storni) → consentito, sommato algebricamente.
6. **Remaining negativo** → warning, normalizzato a 0.
7. **Durata = 0 o negativa** → errore validazione.
8. **Data fine < Data inizio** → errore validazione.
9. **Importo Futuro negativo** → errore validazione.
10. **Cold-start OI con margineAOP ≥ 1** → costo totale = 0, nessuna generazione; mostra warning "Margine ≥ 100%, costi non generati".
11. **Commessa nella baseline ricavi ma non nei costi** → tollerato, report mostra costi = 0.
12. **Commessa nei costi ma non nella baseline ricavi** → warning + categoria "orfana"; opzione "rimuovi" o "associa a una commessa".
13. **Doppio peso NON_ALLOCATO dal BI**: più righe senza Descrizione nello stesso mese → sommare.
14. **Cambio scenario attuale durante editing** → prompt "Salva modifiche?" se ci sono modifiche non salvate.
15. **Modifica Data Inizio che porta Data Fine oltre l'orizzonte dell'app** → consentito, `allMonths` si estende (vedi fix recente del filtro date).
16. **Scenario di confronto selezionato nel report senza dati costi** → mostra riga "nessun dato" per quella colonna.
17. **Probabilità = 0** (commessa persa) → tutti i valori costi a 0, ma la struttura resta (permette di recuperare se probabilità torna > 0).

---

## 15. Roadmap di implementazione

Fasi incrementali, ognuna mergeable indipendentemente.

### Fase 1 — Fondamenta dati (no UI)

- Definire costanti categorie in `src/constants/costCategories.js`
- Definire tabella pesi/curve default in `src/constants/costDefaults.js`
- Funzione `computeCategoriaMensile(scenario, commessaKey, categoriaId)` in nuovo `src/costEngine.js`
- Funzioni helper: `generateCurve(dataInizio, durata, tipoCurva, totale)`, `applyCurveScaling(probScale)`
- Test unitari sulle curve (uniforme, S-curve varie)

### Fase 2 — Cold-start OI da margine

- Funzione `generateCostsFromMargin(commessa, vdpTotal, margineAOP)` → struttura categorie
- Funzione `copyCostsFromPreviousScenario(commessaKey, currentScenarioId)` → fallback

### Fase 3 — Parser BI

- `parseBIExport(buf)` in `src/dataLoader.js` (o nuovo `costDataLoader.js`)
- Validazione schema colonne, categorie, mesi
- Test su file `Screenshot/ExportCE.xlsx`

### Fase 4 — UI pannello per-scenario "Costi"

- Nuovo tab annidato in Assumptions
- Tabella categorie editabile (§8.1)
- Grafico mensilizzazione
- Reattività ai cambi di `inputs` scenario (shift/ritardo/probabilità)

### Fase 5 — Flusso import BI

- Pulsante "Importa da BI" + file picker
- Dialog conferma per-commessa (§7.3)
- Validazione Remaining vs data fine (§7.4)
- Scrittura nei dati scenario + push cloud

### Fase 6 — Tab principale "Costi" + report comparativo

- Layout Conto Economico comparativo (§6.1)
- Dropdown "Scenario di riferimento di confronto"
- Calcolo aggregato (per mese/categoria, singolo + progressivo)

### Fase 7 — Export Excel del report

- Adattare `exportManager.js` per export Conto Economico
- Formato compatibile con `ContoEconomicoExportTipo.xlsx`

### Fase 8 — Lock scenario → snapshot costi

- Estensione della logica lock per generare `costiSnapshot`
- Rendering condizionale (snapshot vs live)
- Test scenari locked che restano immutati dopo reimport VDP

### Fase 9 — Pannello admin per default costi

- UI nel pannello admin per modificare tabella pesi/curve
- Salvataggio in `app_config` Supabase
- Fallback a hardcoded se assente

### Fase 10 — Permessi

- Gate editor vs viewer su tutte le azioni write

### Fase 11 — Cloud sync completo + backup/restore

- Aggiunta `whatif_cost_defaults` a backup/restore
- Schema migration Supabase
- Test push/pull/dedup con dati costi

### Fase 12 — Rifinitura

- Edge cases §14 coperti
- Loading states, error boundary
- Test end-to-end su scenario reale

---

## 16. Domande aperte / decisioni da validare in corso d'opera

1. **Opzione A vs B schema Supabase** (§3.3): confermare A per v1?
2. **Sigma esatto delle curve gaussiane** (§5.1): `durata/6` standard, `durata/8` per Custom-2 — tarare su esempi reali.
3. **Baseline nel dropdown report costi** (§6.3): mostriamo "nessun dato" o la rimuoviamo dal dropdown?
4. **Commessa orfana nei costi** (§14.12): comportamento UI preciso da definire quando implementiamo il tab report.
5. **Modifica admin della tabella default** (§12.3): richiesta subito o in Fase 9 più avanti?
6. **Export CE: mantenere "ACT RICAVO" nell'header**? Nel file aggiornato è stato rimosso da alcune celle ma non tutte; va chiarito il formato finale prima di implementare l'export (Fase 7).
7. **Migrazione scenari esistenti**: scenari già salvati prima del modulo costi avranno `costi: undefined`. L'app deve gestirlo senza crashare (guard `scenario.costi || {}`).
8. **Gestione "DI CUI RISERVE"** in futura iterazione come ricavo: non in questo modulo, ma lasciare la porta aperta nel modello dati (non bloccarla).

---

## 17. Decisioni di design emerse durante implementazione

Riepilogo aggiornamenti rispetto alla spec originale (per coerenza documentazione/codice):

### 17.1 Architetturali

| Decisione | Riferimento |
|---|---|
| Schema Supabase: tutto dentro `data` JSONB esistente, nessun ALTER TABLE | §3.3, P17 |
| Scenari `imported` = fotografie autonome, **niente fallback "copia da scenario precedente"** | §5.4, P-fix mid |
| `getCommesseForScenario(scenario, baseline)` come pool primario (non baseline raw) | §5.7 |
| Sorgente date al cold-start dipende da `scenario.type` (importedData vs baseline) | §5.7 |

### 17.2 UX e display

| Decisione | Riferimento |
|---|---|
| Date "base" pre-shift in `cat`, **display effective post-shift** (`shiftMonth`) | §5.6 |
| Edit smonta lo shift al salvataggio (`shiftMonth(input, -shift)`) | §5.6 |
| **Filtri data globali in modalità "tutto filtra" (Opzione B)**: totali e grafico rispettano il range, parametri editabili invariati | P10 |
| **Sub-nav Assunzioni VDP / Costi** dentro tab Assumptions | §12.2 |
| **Pulsante 🔄 Reset cold-start** sulla card commessa | (P9 fix) |
| **Selettore vista "Grafico / Tabella Mensile / Tabella Progressivo"** nelle card | §8.2 / P10b |
| Tab principale rinominato **"Comparison Costi"** (con "Comparison VDP" parallelo) | §6.2 |

### 17.3 Reattività

| Decisione | Riferimento |
|---|---|
| `MutationObserver` su `#filter-settore`, `#filter-type`, `#filter-commessa` per rilevare cambi chip | costUI.js |
| Listener `change` + click su pulsanti shortcut anno e reset filtri | costUI.js |
| Re-render unificato `maybeRerenderCosti()` per sub-pannello + tab principale | costUI.js |

### 17.4 Lock e snapshot

| Decisione | Riferimento |
|---|---|
| `setCostiSnapshotProvider(fn)` exported da `scenarioManager.js` come hook DI | §10.1 / P16 |
| `unlockScenario` cancella `costiSnapshot = null` automaticamente | P16 |
| Viewer = lock effettivo (input disabilitati come per scenario locked) | §11 / P20 |

### 17.5 Parser BI

| Decisione | Riferimento |
|---|---|
| `IGNORED_CATEGORIES` include `RIS`, `DI CUI RISERVE` (e `RISERVE` commentato per future attivazione) | biParser.js |
| `Remaining` negativo → normalizzato a 0 con warning aggregato | §14.6 / P20 |
| Alias `PENALI [-]` → `penali_riaddebito` per varianti BI osservate | biParser.js |
| Skip silenzioso di righe metadata (codice `Filtri` o `Total`) | biParser.js |

### 17.6 Import e validazione

| Decisione | Riferimento |
|---|---|
| Modal import con **autocomplete `<datalist>`** invece di `<select>` per ricerca rapida commessa | §7.3 / P11 fix |
| Modal "Estendi/Comprimi/Salta" per-commessa quando Remaining oltre data fine | §7.4 / P12 |
| "Comprimi" = `dataFine = dataFineCommessa`, totale conservato, curva ridistribuita (semplificazione coerente con il modello dati a parametri) | §7.4 / P12 |

### 17.7 Stato UI persistito

| Chiave localStorage | Contenuto | Backup |
|---|---|---|
| `whatif_cost_panel_expanded` | Set di chiavi commessa con card espanse | ✓ gruppo `preferenze` |
| `whatif_cost_defaults` (futuro P19) | Override pesi/curve di default | da aggiungere a P19 |

### 17.8 Posticipazioni definitive

| Punto | Stato | Motivo |
|---|---|---|
| **P19** — Pannello admin per pesi/curve | POSTPONED | I default da `ImpostazioneDefaultCosti.xlsx` restano hardcoded in `costCategories.js`. Da aprire solo se l'utente chiede esplicitamente di modificarli (più informato dopo qualche ciclo di uso reale) |
| Gestione "DI CUI RISERVE" come ricavo | Out of scope | Nota nello spec, ma esplicitamente escluso |
| Tabella alias categorie BI configurabile | Da P19 | Per ora hardcoded |

---

## 18. Riferimenti

- `Screenshot/ExportCE.xlsx` — template import BI aggiornato (con colonna Codice Commessa)
- `Screenshot/ImpostazioneDefaultCosti.xlsx` — tabella pesi e curve default
- `Screenshot/ContoEconomicoExportTipo.xlsx` — layout report comparativo
- `Screenshot/ProfiloCurvaOredeIntake.png` — elenco profili curva con descrizione e param `a`
- `Screenshot/DistribuzioneCosti.png` — esempio visuale di distribuzione mensile per commessa
- Codice esistente:
  - `src/scenarioEngine.js:12` — `shiftMonth()` da riutilizzare
  - `src/scenarioEngine.js:91` — `applyDelaySmoothing()` da riutilizzare
  - `src/dataLoader.js` — parser baseline ricavi, aggiungere parser BI costi qui
  - `src/scenarioManager.js` — esteso con campi costi
  - `src/syncManager.js` — gestione push/pull + `app_config`
