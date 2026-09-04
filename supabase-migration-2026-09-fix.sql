-- ============================================================================
--  Migrazione correttiva — 04/09/2026
--  DA REVISIONARE PRIMA DI ESEGUIRE. Nessuna parte è stata applicata.
--
--  Corregge tre disallineamenti fra il codice dell'app e il database reale,
--  verificati sul progetto qqxttvtofnpvuakzqdcg (AnalisiScenariVDP).
-- ============================================================================


-- ############################################################################
--  0. URGENTE — CHIUNQUE PUÒ REGISTRARSI E FARSI ADMIN DA SOLO
-- ############################################################################
--
--  Verificato sul progetto vivo, catena completa:
--
--   a) /auth/v1/settings restituisce  disable_signup: false
--                                     mailer_autoconfirm: true
--      => chiunque si registra con qualsiasi email, senza conferma, ed è
--         subito operativo. La chiave anon è pubblica: sta nel repository
--         GitHub e dentro ogni .exe distribuito.
--
--   b) La policy INSERT su user_roles è:
--           WITH CHECK (auth.uid() = user_id)
--      Controlla che la riga riguardi sé stessi, MA NON PONE ALCUN VINCOLO
--      SUL VALORE DI role. Il CHECK di colonna ammette 'admin'.
--
--   c) Il trigger trg_assign_default_role è AFTER INSERT e promuove ad admin
--      solo se user_roles ha esattamente 1 riga (bootstrap del primo utente).
--      Negli altri casi non forza né valida il ruolo.
--
--   => Un utente appena registrato non ha ancora una riga, quindi UNIQUE(user_id)
--      non lo ferma: può inserire role='admin' e ottenere il controllo completo
--      (lettura di 94 anagrafiche con CF e stipendi, modifica e cancellazione di
--      scenari e allocazioni, cambio ruolo agli altri, blocco dei push di tutti
--      via app_config.min_push_version).
--
--  NOTA: l'app inserisce sempre role='viewer' (supabaseClient.js:73), quindi
--  vincolare la policy a 'viewer' NON rompe l'accesso dei nuovi utenti legittimi.

DROP POLICY IF EXISTS "Users can insert own role" ON public.user_roles;

CREATE POLICY "Users can insert own role"
  ON public.user_roles
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id AND role = 'viewer');

-- Le due policy SELECT sono duplicate e identiche: ne resta una sola.
DROP POLICY IF EXISTS "Anyone can read user_roles" ON public.user_roles;

-- DA FARE ANCHE NELLA CONSOLE SUPABASE (non si imposta da SQL):
--   Authentication → Providers → Email:
--     • disattivare "Enable Sign Ups"  (oppure limitare i domini consentiti)
--     • riattivare "Confirm email"
--   Authentication → Policies:
--     • attivare "Leaked password protection" (segnalata come disattiva dal linter)


-- ─── 1. RPC get_server_time — MANCANTE ──────────────────────────────────────
-- syncManager.js:_getServerTime() la chiama, non esiste, e ricade su
--   new Date(Date.now() - 5000)
-- cioè sull'orologio del PC. La metà "ora del server" del fix sul clock drift
-- (commit 5a537f8) non ha quindi mai funzionato: un PC con l'orologio sfasato
-- falsa la finestra di sincronizzazione incrementale.

CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$ SELECT now(); $$;

REVOKE ALL ON FUNCTION public.get_server_time() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_server_time() TO authenticated;


-- ─── 2. RPC dedup_allocazioni — MANCANTE ────────────────────────────────────
-- syncManager.js:_dedupAllocazioniCloud() la chiama; poiché non esiste, ricade
-- ogni volta sul fallback JavaScript, che è la variante meno affidabile.
-- Oggi il cloud ha 219 gruppi duplicati per 269 righe in eccesso: la deduplica
-- locale li toglie a ogni avvio ma non propaga mai la cancellazione, quindi il
-- pull successivo li riporta indietro. Il ciclo si ripete da mesi.
--
-- Tiene la riga più recente di ogni gruppo e marca le altre come cancellate.
-- Soft-delete: nessun dato viene rimosso fisicamente.

CREATE OR REPLACE FUNCTION public.dedup_allocazioni()
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    n integer;
BEGIN
    WITH ordinate AS (
        SELECT id,
               row_number() OVER (
                   PARTITION BY persona_local_id, codice_commessa, scenario_local_id,
                                data_inizio, data_fine, percentuale
                   ORDER BY updated_at DESC, id DESC
               ) AS pos
        FROM public.allocazioni
        WHERE NOT deleted
    )
    UPDATE public.allocazioni a
       SET deleted = true,
           updated_at = now()
      FROM ordinate o
     WHERE a.id = o.id
       AND o.pos > 1;

    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

REVOKE ALL ON FUNCTION public.dedup_allocazioni() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dedup_allocazioni() TO authenticated;


-- ─── 3. Irrobustimento delle funzioni esistenti ─────────────────────────────
-- Il linter di Supabase segnala che get_user_role e assign_default_role sono
-- SECURITY DEFINER con search_path mutabile ED eseguibili dal ruolo anon via
-- /rest/v1/rpc/. Un non autenticato non deve poterle invocare.

ALTER FUNCTION public.get_user_role()          SET search_path = '';
ALTER FUNCTION public.get_user_role(uuid)      SET search_path = '';
ALTER FUNCTION public.assign_default_role()    SET search_path = '';

REVOKE EXECUTE ON FUNCTION public.get_user_role()       FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_user_role(uuid)   FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.assign_default_role() FROM anon, PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_user_role()       TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_role(uuid)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_default_role() TO authenticated;


-- ============================================================================
--  VERIFICA (eseguire dopo, per controllo — sola lettura)
-- ============================================================================
-- SELECT public.get_server_time();
-- SELECT public.dedup_allocazioni();        -- restituisce quante righe ha marcato
-- SELECT count(*) FILTER (WHERE NOT deleted) AS attive FROM public.allocazioni;
--   atteso: da 4.067 a 3.798, cioè le 269 duplicate in meno
