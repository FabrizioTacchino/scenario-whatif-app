-- ════════════════════════════════════════════════════════════════════════
--  RLS: valutazione una volta per interrogazione invece che una per riga
--  Progetto AnalisiScenariVDP — preparato 11/09/2026
-- ════════════════════════════════════════════════════════════════════════
--
-- PERCHE'. Le espressioni RLS chiamano get_user_role() / utente_puo_leggere()
-- nude, e Postgres le rivaluta una volta per riga. Misurato: 14.107.800 letture
-- dell'indice su user_roles (tabella di 4 righe), pari al 98% di tutte le letture
-- con indice del database; 145 letture per ogni chiamata dell'app; 212 ms per
-- leggere 2.884 allocazioni. Avvolgere in (select ...) trasforma la chiamata in
-- un InitPlan calcolato una volta sola.
--
-- COSA NON CAMBIA. Chi vede cosa. La trasformazione e' meccanica: si avvolge la
-- sola chiamata di funzione, le espressioni che confrontano colonne della riga
-- (user_id = auth.uid(), draft = false) restano per-riga.
--
-- REGOLE DERIVATE DALL'AUDIT (77 agenti, 23 rilievi, 13 sopravvissuti):
--   1. SOLO ALTER POLICY, mai DROP+CREATE: ALTER non puo' toccare TO / FOR /
--      PERMISSIVE, quindi quegli attributi sono al riparo per costruzione. E non
--      esiste un istante in cui la tabella resta senza regola — che non darebbe
--      errore, restituirebbe zero righe in silenzio.
--   2. Le 8 regole con SIA USING SIA WITH CHECK vanno riscritte con ENTRAMBE le
--      clausole nello STESSO comando: ALTER POLICY sostituisce solo cio' che
--      nomini, e mezza regola convertita non da' alcun errore. Su
--      "Writers can update scenarios" significherebbe permettere al tester di
--      pubblicare una bozza.
--   3. Nomi qualificati public.*, perche' le regole vengono valutate con il
--      search_path del chiamante.
--   4. Un lotto per volta, NON tutto in una transazione: ogni comando prende un
--      lock esclusivo sulla tabella, e in un blocco unico resterebbero presi
--      tutti fino alla fine.
--   5. Ordine: prima ruoli (traffico nullo) per collaudare lo schema, poi
--      user_roles (se si rompe si fermano tutti e sei: va scoperto subito),
--      infine le tabelle pesanti.
--
-- PREREQUISITO: nessun utente collegato.
-- RIENTRO: ripristino-regole-rls.sql rimette le 30 regole com'erano.

set lock_timeout = '3s';   -- se la tabella e' occupata si fallisce subito, non si accoda

-- ─── LOTTO 1 — ruoli: traffico nullo, serve a collaudare lo schema ──────
ALTER POLICY "Authenticated can read ruoli" ON public.ruoli
  USING ((select public.utente_puo_leggere()));
ALTER POLICY "Writers can delete ruoli" ON public.ruoli
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Writers can insert ruoli" ON public.ruoli
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Writers can update ruoli" ON public.ruoli
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]))
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));

-- ─── LOTTO 2 — user_roles: raggio d'azione massimo, si verifica subito ──
-- L'app legge il proprio ruolo con una SELECT diretta qui sopra; se questa
-- regola si rompe, tutti e sei restano fuori. get_user_role() resta comunque
-- funzionante perche' e' SECURITY DEFINER e scavalca la RLS.
ALTER POLICY "Users read own role, admins read all" ON public.user_roles
  USING ((user_id = (select auth.uid())) OR ((select public.get_user_role()) = 'admin'::text));
ALTER POLICY "Users can insert own role" ON public.user_roles
  WITH CHECK (((select auth.uid()) = user_id) AND (role = 'viewer'::text));
ALTER POLICY "Admins can delete roles" ON public.user_roles
  USING (((select public.get_user_role()) = 'admin'::text) AND (user_id <> (select auth.uid())));
ALTER POLICY "Admin can update roles" ON public.user_roles
  USING ((select public.get_user_role()) = 'admin'::text)
  WITH CHECK ((select public.get_user_role()) = 'admin'::text);

-- ─── LOTTO 3 — tabelle per-utente e configurazione ──────────────────────
ALTER POLICY "Users can CRUD own preferences" ON public.preferences
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
ALTER POLICY "Users can CRUD own sync_state" ON public.sync_state
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);
-- app_config: with_check e' NULL ed e' FOR ALL, quindi la USING vale anche
-- come WITH CHECK. Non si nomina WITH CHECK, cosi' resta NULL e l'implicito regge.
ALTER POLICY "Admin can update app_config" ON public.app_config
  USING (EXISTS (SELECT 1 FROM public.user_roles
                 WHERE user_roles.user_id = (select auth.uid())
                   AND user_roles.role = 'admin'::text));
ALTER POLICY "Authenticated can read app_config" ON public.app_config
  USING ((select auth.uid()) IS NOT NULL);

-- ─── LOTTO 4 — audit_log ────────────────────────────────────────────────
ALTER POLICY "Authenticated can read audit" ON public.audit_log
  USING ((select public.utente_puo_leggere()));
ALTER POLICY "Non-viewers can insert audit" ON public.audit_log
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text, 'commercial'::text]));

-- ─── LOTTO 5 — persone (dati personali: CF e costi) ─────────────────────
ALTER POLICY "Authenticated can read persone" ON public.persone
  USING ((select public.utente_puo_leggere()));
ALTER POLICY "Writers can delete persone" ON public.persone
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Writers can insert persone" ON public.persone
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Writers can update persone" ON public.persone
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]))
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));

-- ─── LOTTO 6 — scenarios: la regola piu' delicata dell'intero schema ────
-- La UPDATE ha USING e WITH CHECK con lo STESSO testo ma significato diverso:
-- USING sulla riga vecchia, WITH CHECK sulla nuova. Entrambe qui sotto, stessa
-- stringa, stesso comando. Se ne restasse una sola convertita il tester potrebbe
-- pubblicare una bozza portando draft a false, e la regola SELECT la renderebbe
-- visibile a tutti.
ALTER POLICY "Authenticated can read scenarios" ON public.scenarios
  USING ((select public.utente_puo_leggere())
         AND ((draft = false)
              OR ((select public.get_user_role()) = 'admin'::text)
              OR (((select public.get_user_role()) = 'tester'::text) AND (user_id = (select auth.uid())))));
ALTER POLICY "Writers can delete scenarios" ON public.scenarios
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can insert scenarios" ON public.scenarios
  WITH CHECK (((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]))
              OR (((select public.get_user_role()) = 'tester'::text) AND (draft = true)));
ALTER POLICY "Writers can update scenarios" ON public.scenarios
  USING (((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]))
         OR (((select public.get_user_role()) = 'tester'::text) AND (draft = true) AND (user_id = (select auth.uid()))))
  WITH CHECK (((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]))
              OR (((select public.get_user_role()) = 'tester'::text) AND (draft = true) AND (user_id = (select auth.uid()))));

-- ─── LOTTO 7 — baselines: una riga, ma il terzo percorso piu' costoso ───
ALTER POLICY "Authenticated can read baselines" ON public.baselines
  USING ((select public.utente_puo_leggere()));
ALTER POLICY "Writers can delete baselines" ON public.baselines
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can insert baselines" ON public.baselines
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can update baselines" ON public.baselines
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]))
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));

-- ─── LOTTO 8 — allocazioni: 2.884 righe, il guadagno maggiore ───────────
-- Il percorso di scrittura dell'app e' un upsert, che in una sola istruzione
-- attiva la WITH CHECK della INSERT, la USING della UPDATE, la WITH CHECK della
-- UPDATE e la USING della SELECT: convertirne solo una parte fermerebbe il
-- sincronismo di tutti e sei.
ALTER POLICY "Authenticated can read allocazioni" ON public.allocazioni
  USING ((select public.utente_puo_leggere()));
ALTER POLICY "Writers can delete allocazioni" ON public.allocazioni
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can insert allocazioni" ON public.allocazioni
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can update allocazioni" ON public.allocazioni
  USING ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]))
  WITH CHECK ((select public.get_user_role()) = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));

-- ════════════════════════════════════════════════════════════════════════
--  ESITO — applicata l'11/09/2026, nessun utente collegato
-- ════════════════════════════════════════════════════════════════════════
-- Tutte e 30 le regole convertite, in 7 lotti con verifica dopo ciascuno.
--
-- PROVE:
--   impronta normalizzata delle 30 clausole   040f9463727faa710d32ab0e8b6656b3
--                                             identica prima e dopo
--   permessi per utente (6 reali + disabled + senza ruolo)   identici
--   regole con WITH CHECK                     15 prima, 15 dopo
--   "Writers can update scenarios"            USING e WITH CHECK identiche
--   app_config with_check                     resta NULL (implicito preservato)
--
--   lettura di 2.884 allocazioni come editor:
--       piano      InitPlan 1 calcolato una volta, Filter: (InitPlan 1).col1
--       letture di user_roles   2.884  ->  1
--       tempo      212 ms (media in produzione)  ->  14,9 ms
--
--   scrittura (upsert, transazione annullata):
--       editor  -> riuscita
--       tester  -> respinta con 42501, come deve
--
--   analizzatore Supabase: auth_rls_initplan sparito (erano 9 segnalazioni)
--
-- RIENTRO: supabase-ripristino-2026-09-11-regole-rls.sql
-- COPIA DATI: schema backup, tabelle *_20260911 (non esposte a PostgREST)
