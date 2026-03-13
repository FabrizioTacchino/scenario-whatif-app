/**
 * licenseManager.js — Gestione licenza lato renderer.
 * Usa window.licenseAPI esposto da preload.cjs tramite contextBridge.
 * Se window.licenseAPI non esiste (Vite dev browser puro), la licenza è sempre valida.
 */

const api = window.licenseAPI || null;

export async function checkLicense() {
    if (!api) return { valid: true, devMode: true };
    return await api.getStored();
}

export async function activateLicense(key) {
    if (!api) return { valid: true, devMode: true };
    return await api.activate(key);
}

export async function clearLicense() {
    if (!api) return;
    await api.clear();
}
