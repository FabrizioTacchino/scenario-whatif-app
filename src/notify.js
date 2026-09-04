/**
 * notify.js — Avvisi visibili all'utente e registro degli errori.
 *
 * Prima di questo modulo gli errori finivano quasi tutti in console.error: un push
 * fallito, un pull interrotto o un'eccezione a metà render lasciavano l'utente
 * convinto che fosse andato tutto bene. Con DevTools chiusi — cioè sempre, in
 * produzione — non c'era modo di accorgersene né di raccontare cosa fosse successo.
 *
 * Nessuna dipendenza da altri moduli: può essere importato ovunque.
 */

const MAX_REGISTRO = 100;
const _registro = [];

// ─── Registro degli errori ───────────────────────────────────

/**
 * Annota un evento nel registro in memoria, recuperabile dal pannello diagnostica.
 * @param {'errore'|'avviso'|'info'} livello
 */
export function registra(livello, contesto, messaggio, dettaglio = null) {
    _registro.push({
        quando: new Date().toISOString(),
        livello,
        contesto,
        messaggio: String(messaggio || ''),
        dettaglio: dettaglio ? String(dettaglio).slice(0, 2000) : null,
    });
    if (_registro.length > MAX_REGISTRO) _registro.splice(0, _registro.length - MAX_REGISTRO);

    // Inoltra al processo principale, che scrive su file (%APPDATA%/.../logs/main.log)
    try { window.electronAPI?.logError?.(livello, contesto, String(messaggio), dettaglio ? String(dettaglio).slice(0, 2000) : null); }
    catch { /* fuori da Electron */ }
}

export function leggiRegistro() {
    return _registro.slice();
}

export function registroTestuale() {
    const righe = _registro.map(e =>
        `${e.quando}  [${e.livello.toUpperCase()}]  ${e.contesto}: ${e.messaggio}` +
        (e.dettaglio ? `\n    ${e.dettaglio.replace(/\n/g, '\n    ')}` : '')
    );
    return righe.join('\n') || '(nessun evento registrato in questa sessione)';
}

// ─── Avvisi a schermo ────────────────────────────────────────

let _contenitore = null;

function _assicuraContenitore() {
    if (_contenitore && document.body.contains(_contenitore)) return _contenitore;
    _contenitore = document.createElement('div');
    _contenitore.id = 'notify-container';
    _contenitore.setAttribute('role', 'status');
    _contenitore.setAttribute('aria-live', 'polite');
    _contenitore.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:99998;display:flex;' +
        'flex-direction:column;gap:8px;max-width:min(460px,calc(100vw - 32px));' +
        'pointer-events:none';
    document.body.appendChild(_contenitore);
    return _contenitore;
}

const COLORI = {
    errore:  { sfondo: '#b91c1c', testo: '#fff' },
    avviso:  { sfondo: '#b45309', testo: '#fff' },
    successo:{ sfondo: '#15803d', testo: '#fff' },
    info:    { sfondo: '#1f2937', testo: '#fff' },
};

/**
 * Mostra un avviso temporaneo. Gli errori restano finché non si chiudono a mano.
 * @param {string} messaggio
 * @param {'errore'|'avviso'|'successo'|'info'} tipo
 * @param {{durata?: number, dettaglio?: string}} opzioni
 */
export function avvisa(messaggio, tipo = 'info', opzioni = {}) {
    if (tipo === 'errore' || tipo === 'avviso') {
        registra(tipo === 'errore' ? 'errore' : 'avviso', 'ui', messaggio, opzioni.dettaglio);
    }
    let box;
    try {
        const cont = _assicuraContenitore();
        const c = COLORI[tipo] || COLORI.info;
        box = document.createElement('div');
        box.style.cssText =
            `background:${c.sfondo};color:${c.testo};padding:12px 14px;border-radius:8px;` +
            'box-shadow:0 4px 16px rgba(0,0,0,.28);font-size:13px;line-height:1.45;' +
            'display:flex;gap:10px;align-items:flex-start;pointer-events:auto';

        const testo = document.createElement('div');
        testo.style.cssText = 'flex:1;min-width:0';
        // textContent, non innerHTML: il messaggio può contenere dati inseriti da altri utenti
        testo.textContent = messaggio;
        if (opzioni.dettaglio) {
            const det = document.createElement('div');
            det.style.cssText = 'opacity:.8;font-size:11px;margin-top:4px;word-break:break-word';
            det.textContent = opzioni.dettaglio;
            testo.appendChild(det);
        }
        box.appendChild(testo);

        const chiudi = document.createElement('button');
        chiudi.type = 'button';
        chiudi.textContent = '✕';
        chiudi.setAttribute('aria-label', 'Chiudi avviso');
        chiudi.style.cssText =
            'background:transparent;border:0;color:inherit;font-size:14px;cursor:pointer;' +
            'opacity:.75;padding:0 2px;line-height:1';
        chiudi.onclick = () => box.remove();
        box.appendChild(chiudi);

        cont.appendChild(box);
    } catch {
        return; // DOM non disponibile: l'evento resta comunque nel registro
    }

    const durata = opzioni.durata ?? (tipo === 'errore' ? 0 : 6000);
    if (durata > 0) setTimeout(() => box.remove(), durata);
}

/** Scorciatoie. */
export const errore   = (m, o) => avvisa(m, 'errore', o);
export const avviso   = (m, o) => avvisa(m, 'avviso', o);
export const successo = (m, o) => avvisa(m, 'successo', o);

// ─── Cattura globale ─────────────────────────────────────────

let _installato = false;

/**
 * Intercetta eccezioni e promise rifiutate che nessuno gestisce. Senza questo
 * un errore a metà render lasciava la UI a metà, in silenzio.
 */
export function installaCatturaGlobale() {
    if (_installato) return;
    _installato = true;

    window.addEventListener('error', (ev) => {
        const dove = ev.filename ? `${ev.filename}:${ev.lineno}:${ev.colno}` : 'sconosciuto';
        registra('errore', 'eccezione', ev.message || 'Errore non specificato', `${dove}\n${ev.error?.stack || ''}`);
        avvisa('Si è verificato un errore imprevisto. I dati non sono stati persi, ma è consigliabile ricaricare.',
               'errore', { dettaglio: ev.message });
    });

    window.addEventListener('unhandledrejection', (ev) => {
        const motivo = ev.reason;
        const msg = motivo?.message || String(motivo || 'Promise rifiutata');
        registra('errore', 'promise', msg, motivo?.stack || null);
        // Molti rifiuti sono di rete e già gestiti a monte: qui si registra e basta,
        // senza sommergere l'utente di avvisi.
    });
}
