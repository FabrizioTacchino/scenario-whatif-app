-- ============================================================================
--  Analisi Scenari VDP — Migrazioni di sicurezza, settembre 2026
--
--  STATO: TUTTO APPLICATO in produzione (progetto qqxttvtofnpvuakzqdcg)
--  il 04-05/09/2026, e verificato. Questo file è il registro di ciò che è
--  stato eseguito, non uno script da rilanciare.
--
--  Le impostazioni che NON si fanno da SQL sono state applicate a mano nella
--  console e verificate su /auth/v1/settings:
--    · registrazione pubblica  -> CHIUSA   (disable_signup: true)
--    · conferma email          -> ATTIVA   (mailer_autoconfirm: false)
--    · protezione password compromesse -> non disponibile sul piano Free
-- ============================================================================


-- ─── 1. Auto-assegnazione del ruolo admin (era la falla più grave) ──────────
--
-- La policy INSERT su user_roles era WITH CHECK (auth.uid() = user_id): imponeva
-- che la riga riguardasse sé stessi, ma NON vincolava il valore di role, e il
-- CHECK di colonna ammetteva 'admin'. Il trigger assign_default_role interviene
-- solo quando la tabella ha una riga sola (bootstrap del primo utente).
-- Un utente appena registrato non ha ancora una riga, quindi UNIQUE(user_id) non
-- lo fermava: poteva inserirsi role='admin' e prendere il controllo completo.
-- Sommato alla registrazione allora aperta e alla chiave anon pubblica, era
-- sfruttabile da chiunque.

DROP POLICY IF EXISTS "Users can insert own role" ON public.user_roles;

CREATE POLICY "Users can insert own role"
  ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND role = 'viewer');

-- Difesa in profondità: anche allargando la policy, il ruolo iniziale resta viewer.
CREATE OR REPLACE FUNCTION public.force_default_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$ BEGIN NEW.role := 'viewer'; RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_force_default_role ON public.user_roles;
CREATE TRIGGER trg_force_default_role
  BEFORE INSERT ON public.user_roles
  FOR EACH ROW EXECUTE FUNCTION public.force_default_role();

-- Verificato: inserendo role='admin' si ottiene 'viewer'.


-- ─── 2. Due RPC che il client chiamava senza che esistessero ───────────────
--
-- get_server_time: senza di essa _getServerTime() ricadeva SEMPRE sull'orologio
-- del PC, quindi la metà "ora del server" del fix sul clock drift non aveva mai
-- funzionato.
CREATE OR REPLACE FUNCTION public.get_server_time()
RETURNS timestamptz LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT now(); $$;

REVOKE ALL ON FUNCTION public.get_server_time() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_server_time() TO authenticated;

-- dedup_allocazioni: senza di essa si ricadeva sul fallback JavaScript, che
-- ordinava per updated_at — e col push a tabella intera tutte le righe avevano
-- lo stesso timestamp, quindi il "sopravvissuto" era arbitrario e client diversi
-- ne eleggevano di diversi. Qui l'ordine è deterministico e la cancellazione
-- è solo logica, quindi reversibile.
CREATE OR REPLACE FUNCTION public.dedup_allocazioni()
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE n integer;
BEGIN
    WITH ordinate AS (
        SELECT id, row_number() OVER (
                   PARTITION BY persona_local_id, codice_commessa, scenario_local_id,
                                data_inizio, data_fine, percentuale
                   ORDER BY updated_at DESC, id DESC) AS pos
        FROM public.allocazioni WHERE NOT deleted)
    UPDATE public.allocazioni a SET deleted = true, updated_at = now()
      FROM ordinate o WHERE a.id = o.id AND o.pos > 1;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END; $$;

REVOKE ALL ON FUNCTION public.dedup_allocazioni() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dedup_allocazioni() TO authenticated;


-- ─── 3. L'audit non deve essere riscrivibile da chi viene auditato ─────────
-- Verificato che l'app non esegue mai UPDATE su audit_log (usa upsert con
-- ignoreDuplicates). Non esisteva neppure una policy DELETE: resta append-only.
DROP POLICY IF EXISTS "Non-viewers can update audit" ON public.audit_log;


-- ─── 4. Funzioni SECURITY DEFINER esposte ad anon, con search_path mutabile ─
ALTER FUNCTION public.get_user_role()       SET search_path = '';
ALTER FUNCTION public.get_user_role(uuid)   SET search_path = '';
ALTER FUNCTION public.assign_default_role() SET search_path = '';

-- ATTENZIONE, lezione imparata sul campo: svuotare il search_path rompe ogni
-- funzione il cui corpo usa nomi di tabella NON qualificati. Due lo erano, e
-- sono state riscritte qualificando lo schema. La seconda in particolare
-- faceva fallire OGNI inserimento in user_roles, cioè il primo accesso di un
-- nuovo utente.
CREATE OR REPLACE FUNCTION public.get_user_role(uid uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT role FROM public.user_roles WHERE user_id = uid LIMIT 1; $$;

CREATE OR REPLACE FUNCTION public.assign_default_role()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF (SELECT count(*) FROM public.user_roles) = 1 THEN
        UPDATE public.user_roles SET role = 'admin' WHERE id = NEW.id;
    END IF;
    RETURN NEW;
END; $$;

REVOKE ALL ON FUNCTION public.get_user_role()     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_user_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_role()     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_role(uuid) TO authenticated, service_role;

-- Funzioni di trigger: nessuno deve poterle invocare come RPC. Revocare EXECUTE
-- non le disattiva, perché l'esecuzione come trigger non lo richiede.
REVOKE EXECUTE ON FUNCTION public.assign_default_role() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.force_default_role()  FROM authenticated, anon, PUBLIC;

-- get_user_role e utente_puo_leggere DEVONO restare eseguibili da authenticated:
-- sono chiamate dentro le espressioni RLS, valutate col ruolo del chiamante.
-- L'avviso del linter su queste tre è quindi atteso e va lasciato così.


-- ─── 5. La rubrica aziendale non deve essere leggibile da tutti ────────────
-- Erano presenti due policy SELECT identiche, entrambe USING (auth.uid() IS NOT
-- NULL): chiunque otteneva email e ruoli di tutti, compresa l'indicazione di
-- quali utenti sono amministratori. Il pannello che le usa è riservato agli admin.
DROP POLICY IF EXISTS "Anyone can read user_roles"          ON public.user_roles;
DROP POLICY IF EXISTS "Authenticated users can read roles"  ON public.user_roles;

CREATE POLICY "Users read own role, admins read all"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.get_user_role() = 'admin');

-- app_config era leggibile senza autenticazione: la policy era USING (true).
DROP POLICY IF EXISTS "Authenticated can read app_config" ON public.app_config;
CREATE POLICY "Authenticated can read app_config"
  ON public.app_config FOR SELECT TO authenticated
  USING (auth.uid() IS NOT NULL);


-- ─── 6. Due generazioni di policy convivevano e si sommavano in OR ─────────
--
-- Vecchia: "Editors and admins ..." -> get_user_role(auth.uid()), {admin, editor}
-- Nuova:   "Writers ..."            -> get_user_role(),           insieme più ampio
--
-- Essendo PERMISSIVE, il permesso effettivo era l'UNIONE. Verificato tabella per
-- tabella che "Writers" è un sovrainsieme stretto di "Editors and admins" e che
-- coincide con la matrice WRITE_ROLES dell'app (syncManager.js:31-38): eliminare
-- la generazione vecchia NON cambia alcun permesso effettivo, toglie solo
-- l'ambiguità per cui una correzione futura sembrerebbe applicata senza esserlo.

DROP POLICY IF EXISTS "Editors and admins can insert allocazioni" ON public.allocazioni;
DROP POLICY IF EXISTS "Editors and admins can update allocazioni" ON public.allocazioni;
DROP POLICY IF EXISTS "Editors and admins can delete allocazioni" ON public.allocazioni;
DROP POLICY IF EXISTS "Editors and admins can insert baselines"   ON public.baselines;
DROP POLICY IF EXISTS "Editors and admins can update baselines"   ON public.baselines;
DROP POLICY IF EXISTS "Editors and admins can delete baselines"   ON public.baselines;
DROP POLICY IF EXISTS "Editors and admins can insert persone"     ON public.persone;
DROP POLICY IF EXISTS "Editors and admins can update persone"     ON public.persone;
DROP POLICY IF EXISTS "Editors and admins can delete persone"     ON public.persone;
DROP POLICY IF EXISTS "Editors and admins can insert scenarios"   ON public.scenarios;
DROP POLICY IF EXISTS "Editors and admins can update scenarios"   ON public.scenarios;
DROP POLICY IF EXISTS "Editors and admins can delete scenarios"   ON public.scenarios;
DROP POLICY IF EXISTS "Editors and admins can insert audit"       ON public.audit_log;
DROP POLICY IF EXISTS "Admins can manage roles"                   ON public.user_roles;

-- Esito: esattamente una policy di scrittura per tabella e comando.


-- ─── 7. Percorso di revoca ─────────────────────────────────────────────────
-- Prima non esisteva: degradare a 'viewer' toglieva dei pulsanti ma lasciava
-- intatta la lettura di 82 codici fiscali e 94 stipendi, e non c'era alcuna
-- policy DELETE su user_roles.

ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_role_check
  CHECK (role = ANY (ARRAY['admin','editor','hr','commercial','tester','viewer','disabled']));

-- Predicato unico di lettura. Un utente senza riga resta ammesso: è lo stato
-- transitorio del primo accesso, prima che il client crei la propria riga viewer.
CREATE OR REPLACE FUNCTION public.utente_puo_leggere()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT auth.uid() IS NOT NULL
          AND coalesce(public.get_user_role(), '') <> 'disabled'; $$;

REVOKE ALL ON FUNCTION public.utente_puo_leggere() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.utente_puo_leggere() TO authenticated, service_role;

DROP POLICY IF EXISTS "Authenticated can read allocazioni" ON public.allocazioni;
CREATE POLICY "Authenticated can read allocazioni" ON public.allocazioni
  FOR SELECT TO authenticated USING (public.utente_puo_leggere());

DROP POLICY IF EXISTS "Authenticated can read persone" ON public.persone;
CREATE POLICY "Authenticated can read persone" ON public.persone
  FOR SELECT TO authenticated USING (public.utente_puo_leggere());

DROP POLICY IF EXISTS "Authenticated can read baselines" ON public.baselines;
CREATE POLICY "Authenticated can read baselines" ON public.baselines
  FOR SELECT TO authenticated USING (public.utente_puo_leggere());

DROP POLICY IF EXISTS "Authenticated can read ruoli" ON public.ruoli;
CREATE POLICY "Authenticated can read ruoli" ON public.ruoli
  FOR SELECT TO authenticated USING (public.utente_puo_leggere());

DROP POLICY IF EXISTS "Authenticated can read audit" ON public.audit_log;
CREATE POLICY "Authenticated can read audit" ON public.audit_log
  FOR SELECT TO authenticated USING (public.utente_puo_leggere());

DROP POLICY IF EXISTS "Authenticated can read scenarios" ON public.scenarios;
CREATE POLICY "Authenticated can read scenarios" ON public.scenarios
  FOR SELECT TO authenticated
  USING (public.utente_puo_leggere()
         AND (draft = false
              OR public.get_user_role() = 'admin'
              OR (public.get_user_role() = 'tester' AND user_id = auth.uid())));

CREATE POLICY "Admins can delete roles" ON public.user_roles
  FOR DELETE TO authenticated
  USING (public.get_user_role() = 'admin' AND user_id <> auth.uid());


-- ============================================================================
--  VERIFICHE ESEGUITE (impersonando utenti reali con set local role)
-- ============================================================================
--  admin   -> 6.822 allocazioni, 100 persone, 140 scenari
--  editor  -> 6.822 allocazioni, 100 persone, 138 scenari  (bozze escluse, corretto)
--  tester  -> 6.822 allocazioni, 100 persone, 138 scenari
--  disabled->     0 allocazioni,   0 persone                (revoca funzionante)
--  INSERT con role='admin' -> risultato 'viewer'            (auto-admin chiuso)
--  get_user_role(uuid) su utenti reali -> ruolo corretto
-- ============================================================================
