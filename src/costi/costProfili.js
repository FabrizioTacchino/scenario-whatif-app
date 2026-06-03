/**
 * costProfili.js — i 7 profili di curva per la distribuzione mensile.
 *
 * Fonte: Screenshot/ProfiloCurvaOredeIntake.png e ImpostazioneDefaultCosti.xlsx (§4).
 *
 * Tutti i profili eccetto "uniforme" sono gaussiane parametriche:
 *   μ  = paramA × (durata - 1)         posizione del picco (0-based, in mesi)
 *   σ  = durata × paramKSigma           ampiezza
 *   w[i] = exp(-((i - μ)^2) / (2σ^2))
 *   peso[i] = w[i] / Σ w[j]              normalizzato
 *
 * "uniforme" produce 1/durata costante e ignora paramA/paramKSigma.
 *
 * paramKSigma:
 *   - 1/6 standard (curve S e Custom-1/-3)
 *   - 1/8 per Custom-2 ("distribuzione centrale stretta") — sigma più piccolo
 *
 * I valori esatti possono essere tarati empiricamente al P10 (grafico).
 */

export const COST_PROFILES = [
    { id: 'uniforme',       label: 'Uniforme',       paramA: 1.0,  paramKSigma: null, descrizione: 'Distribuzione lineare piatta' },
    { id: 's_curve_inizio', label: 'S-curve inizio', paramA: 0.3,  paramKSigma: 1/6,  descrizione: 'Picco nei primi mesi' },
    { id: 's_curve',        label: 'S-curve',        paramA: 0.5,  paramKSigma: 1/6,  descrizione: 'Curva S standard' },
    { id: 's_curve_fine',   label: 'S-curve fine',   paramA: 0.7,  paramKSigma: 1/6,  descrizione: 'Picco nella fase finale' },
    { id: 'custom_1',       label: 'Custom-1',       paramA: 0.35, paramKSigma: 1/6,  descrizione: 'Picco anticipato leggero' },
    { id: 'custom_2',       label: 'Custom-2',       paramA: 0.55, paramKSigma: 1/8,  descrizione: 'Distribuzione centrale stretta' },
    { id: 'custom_3',       label: 'Custom-3',       paramA: 0.65, paramKSigma: 1/6,  descrizione: 'Picco posticipato leggero' },
];

/** Lookup per id. Ritorna undefined se non trovato. */
export function getProfileById(id) {
    return COST_PROFILES.find(p => p.id === id);
}
