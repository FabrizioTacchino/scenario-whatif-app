-- RIPRISTINO delle 30 regole RLS allo stato del 2026-09-11, prima della
-- riscrittura (select ...). Catturato con search_path='' quindi i nomi sono
-- QUALIFICATI: eseguendolo si torna esattamente allo stato precedente.
-- Usa solo ALTER POLICY: non tocca TO / FOR / PERMISSIVE.
ALTER POLICY "Authenticated can read allocazioni" ON public.allocazioni
  USING (public.utente_puo_leggere());
ALTER POLICY "Writers can delete allocazioni" ON public.allocazioni
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can insert allocazioni" ON public.allocazioni
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can update allocazioni" ON public.allocazioni
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]))
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Admin can update app_config" ON public.app_config
  USING ((EXISTS ( SELECT 1 FROM public.user_roles
   WHERE user_roles.user_id = auth.uid() AND user_roles.role = 'admin'::text)));
ALTER POLICY "Authenticated can read app_config" ON public.app_config
  USING (auth.uid() IS NOT NULL);
ALTER POLICY "Authenticated can read audit" ON public.audit_log
  USING (public.utente_puo_leggere());
ALTER POLICY "Non-viewers can insert audit" ON public.audit_log
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text, 'commercial'::text]));
ALTER POLICY "Authenticated can read baselines" ON public.baselines
  USING (public.utente_puo_leggere());
ALTER POLICY "Writers can delete baselines" ON public.baselines
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can insert baselines" ON public.baselines
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can update baselines" ON public.baselines
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]))
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Authenticated can read persone" ON public.persone
  USING (public.utente_puo_leggere());
ALTER POLICY "Writers can delete persone" ON public.persone
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Writers can insert persone" ON public.persone
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Writers can update persone" ON public.persone
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]))
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Users can CRUD own preferences" ON public.preferences
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
ALTER POLICY "Authenticated can read ruoli" ON public.ruoli
  USING (public.utente_puo_leggere());
ALTER POLICY "Writers can delete ruoli" ON public.ruoli
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Writers can insert ruoli" ON public.ruoli
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Writers can update ruoli" ON public.ruoli
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]))
  WITH CHECK (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'hr'::text]));
ALTER POLICY "Authenticated can read scenarios" ON public.scenarios
  USING (public.utente_puo_leggere() AND (draft = false OR public.get_user_role() = 'admin'::text OR public.get_user_role() = 'tester'::text AND user_id = auth.uid()));
ALTER POLICY "Writers can delete scenarios" ON public.scenarios
  USING (public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text]));
ALTER POLICY "Writers can insert scenarios" ON public.scenarios
  WITH CHECK ((public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text])) OR public.get_user_role() = 'tester'::text AND draft = true);
ALTER POLICY "Writers can update scenarios" ON public.scenarios
  USING ((public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text])) OR public.get_user_role() = 'tester'::text AND draft = true AND user_id = auth.uid())
  WITH CHECK ((public.get_user_role() = ANY (ARRAY['admin'::text, 'editor'::text, 'commercial'::text])) OR public.get_user_role() = 'tester'::text AND draft = true AND user_id = auth.uid());
ALTER POLICY "Users can CRUD own sync_state" ON public.sync_state
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
ALTER POLICY "Admin can update roles" ON public.user_roles
  USING (public.get_user_role() = 'admin'::text)
  WITH CHECK (public.get_user_role() = 'admin'::text);
ALTER POLICY "Admins can delete roles" ON public.user_roles
  USING (public.get_user_role() = 'admin'::text AND user_id <> auth.uid());
ALTER POLICY "Users can insert own role" ON public.user_roles
  WITH CHECK (auth.uid() = user_id AND role = 'viewer'::text);
ALTER POLICY "Users read own role, admins read all" ON public.user_roles
  USING (user_id = auth.uid() OR public.get_user_role() = 'admin'::text);
