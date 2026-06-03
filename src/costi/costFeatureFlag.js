/**
 * costFeatureFlag.js — flag globale del modulo costi.
 *
 * Se false, l'app deve comportarsi identicamente alla versione pre-modulo:
 * niente tab "Costi" principale, niente pannello costi per-scenario,
 * niente pulsante import BI. Tutti i punti di accesso UI ai costi devono
 * essere gated su questo flag.
 */

export const WHATIF_COSTI_ENABLED = true;
