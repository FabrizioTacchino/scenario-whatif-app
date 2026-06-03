/**
 * costCategories.js — elenco fisso delle 14 categorie merceologiche.
 *
 * Fonte: Screenshot/ImpostazioneDefaultCosti.xlsx (§4 della specifica).
 * I pesi sono usati SOLO per cold-start OI da margine (§5.3). Per le commesse
 * che ricevono dati dall'import BI, i pesi non sono rilevanti: si usano i
 * valori reali del file.
 *
 * Le 13 categorie "attive" sommano al 100%. Penali e Non Allocato hanno peso 0
 * perché non vengono generate da default — entrano solo via import BI.
 *
 * id            : chiave interna stabile (mai mostrata all'utente)
 * label         : etichetta UI in italiano
 * peso          : frazione [0..1] del costo totale commessa per cold-start OI
 * curvaDefault  : id del profilo curva default (vedi costProfili.js)
 * paramA        : parametro di posizione del picco della gaussiana, [0..1]
 *                 (ridondante con costProfili.js: tenuto qui per comodità di lookup)
 */

export const COST_CATEGORIES = [
    { id: 'sub_contratti',            label: 'VALORE SUB-CONTRATTI',               peso: 0.7715, curvaDefault: 's_curve',  paramA: 0.5 },
    { id: 'materiale_diretto',        label: 'MATERIALE ACQUISTATO DIRETTO',       peso: 0.1291, curvaDefault: 's_curve',  paramA: 0.5 },
    { id: 'materiale_indiretto',      label: 'MATERIALE INDIRETTO',                peso: 0.0051, curvaDefault: 's_curve',  paramA: 0.5 },
    { id: 'personale_diretto',        label: 'COSTO PERSONALE DIRETTO',            peso: 0.0446, curvaDefault: 's_curve',  paramA: 0.5 },
    { id: 'consulenze_progettazione', label: 'CONSULENZE PROGETTAZIONE',           peso: 0.0240, curvaDefault: 's_curve',  paramA: 0.5 },
    { id: 'consulenze_generali',      label: 'CONSULENZE GENERALI',                peso: 0.0016, curvaDefault: 'uniforme', paramA: 1.0 },
    { id: 'consulenze_tecniche',      label: 'CONSULENZE TECNICHE/SPECIALISTICHE', peso: 0.0018, curvaDefault: 's_curve',  paramA: 0.5 },
    { id: 'consulenze_hse_tqm',       label: 'CONSULENZE HSE E TQM',               peso: 0.0017, curvaDefault: 'uniforme', paramA: 1.0 },
    { id: 'noleggi_diretti',          label: 'NOLEGGI DIRETTI',                    peso: 0.0142, curvaDefault: 's_curve',  paramA: 0.5 },
    { id: 'costi_utenze',             label: 'COSTI UTENZE',                       peso: 0.0029, curvaDefault: 'uniforme', paramA: 1.0 },
    { id: 'penali_riaddebito',        label: 'PENALI RIADDEBITO FORNITORI [-]',    peso: 0.0000, curvaDefault: 'uniforme', paramA: 1.0 },
    { id: 'contingency',              label: 'CONTINGENCY COSTI',                  peso: 0.0035, curvaDefault: 's_curve',  paramA: 0.5 },
    { id: 'non_allocato',             label: 'NON ALLOCATO',                       peso: 0.0000, curvaDefault: 'uniforme', paramA: 1.0 },
];

/** Lookup per id. Ritorna undefined se non trovato. */
export function getCategoryById(id) {
    return COST_CATEGORIES.find(c => c.id === id);
}

/** Categorie con peso > 0 (usate per cold-start OI). */
export function getActiveDefaultCategories() {
    return COST_CATEGORIES.filter(c => c.peso > 0);
}
