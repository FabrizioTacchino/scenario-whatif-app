-- ============================================================
-- MIGRATION: Shared Workspace + Ruoli Granulari
-- Scenario Whatif
--
-- Esegui questo script nel Supabase SQL Editor
-- (Dashboard > SQL Editor > New Query)
--
-- COSA FA:
-- 1. Aggiunge ruoli hr/commercial alla tabella user_roles
-- 2. Rimuove i vincoli UNIQUE con user_id (dati ora condivisi)
-- 3. Aggiunge vincoli UNIQUE su solo local_id
-- 4. Sostituisce le RLS policies per workspace condiviso
-- ============================================================

-- ─── 0. Funzione helper per check ruolo ─────────────────────
-- Restituisce il ruolo dell'utente corrente dalla tabella user_roles.
CREATE OR REPLACE FUNCTION public.get_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT role FROM public.user_roles
    WHERE user_id = auth.uid()
    LIMIT 1;
$$;

-- ─── 1. USER_ROLES: assicura struttura e check constraint ───

-- Se non esiste già, crea la tabella (probabilmente esiste già)
CREATE TABLE IF NOT EXISTS public.user_roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'viewer',
    email TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id)
);

-- Rimuovi eventuale vecchio check constraint
ALTER TABLE public.user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;

-- Aggiungi check con i nuovi ruoli
ALTER TABLE public.user_roles
    ADD CONSTRAINT user_roles_role_check
    CHECK (role IN ('admin', 'editor', 'hr', 'commercial', 'tester', 'viewer'));

-- RLS su user_roles
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can CRUD own user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "Anyone can read user_roles" ON public.user_roles;
DROP POLICY IF EXISTS "Users can insert own role" ON public.user_roles;
DROP POLICY IF EXISTS "Admin can update roles" ON public.user_roles;

-- Tutti gli autenticati possono leggere i ruoli
CREATE POLICY "Anyone can read user_roles"
    ON public.user_roles FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- Un utente può inserire il proprio ruolo (primo accesso)
CREATE POLICY "Users can insert own role"
    ON public.user_roles FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Solo admin può modificare i ruoli
CREATE POLICY "Admin can update roles"
    ON public.user_roles FOR UPDATE
    USING (public.get_user_role() = 'admin')
    WITH CHECK (public.get_user_role() = 'admin');

-- ─── 2. BASELINES: shared singleton ────────────────────────

-- Rimuovi vecchio vincolo e tutte le policy (vecchie e nuove)
ALTER TABLE baselines DROP CONSTRAINT IF EXISTS baselines_user_id_key;
DROP POLICY IF EXISTS "Users can CRUD own baseline" ON baselines;
DROP POLICY IF EXISTS "Authenticated can read baselines" ON baselines;
DROP POLICY IF EXISTS "Writers can insert baselines" ON baselines;
DROP POLICY IF EXISTS "Writers can update baselines" ON baselines;
DROP POLICY IF EXISTS "Writers can delete baselines" ON baselines;

-- Tutti possono leggere
CREATE POLICY "Authenticated can read baselines"
    ON baselines FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- Admin, editor, commercial possono scrivere
CREATE POLICY "Writers can insert baselines"
    ON baselines FOR INSERT
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'commercial'));

CREATE POLICY "Writers can update baselines"
    ON baselines FOR UPDATE
    USING (public.get_user_role() IN ('admin', 'editor', 'commercial'))
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'commercial'));

CREATE POLICY "Writers can delete baselines"
    ON baselines FOR DELETE
    USING (public.get_user_role() IN ('admin', 'editor', 'commercial'));

-- ─── 3. SCENARIOS: shared ──────────────────────────────────

-- Rimuovi vecchio vincolo e tutte le policy
ALTER TABLE scenarios DROP CONSTRAINT IF EXISTS scenarios_user_id_local_id_key;
DROP POLICY IF EXISTS "Users can CRUD own scenarios" ON scenarios;
DROP POLICY IF EXISTS "Authenticated can read scenarios" ON scenarios;
DROP POLICY IF EXISTS "Writers can insert scenarios" ON scenarios;
DROP POLICY IF EXISTS "Writers can update scenarios" ON scenarios;
DROP POLICY IF EXISTS "Writers can delete scenarios" ON scenarios;

-- Nuovo vincolo UNIQUE su solo local_id (IF NOT EXISTS via exception handling)
ALTER TABLE scenarios DROP CONSTRAINT IF EXISTS scenarios_local_id_key;
ALTER TABLE scenarios ADD CONSTRAINT scenarios_local_id_key UNIQUE (local_id);

-- Tutti possono leggere
CREATE POLICY "Authenticated can read scenarios"
    ON scenarios FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- Admin, editor, commercial possono scrivere
CREATE POLICY "Writers can insert scenarios"
    ON scenarios FOR INSERT
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'commercial'));

CREATE POLICY "Writers can update scenarios"
    ON scenarios FOR UPDATE
    USING (public.get_user_role() IN ('admin', 'editor', 'commercial'))
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'commercial'));

CREATE POLICY "Writers can delete scenarios"
    ON scenarios FOR DELETE
    USING (public.get_user_role() IN ('admin', 'editor', 'commercial'));

-- ─── 4. PERSONE: shared, scrivibile da hr ──────────────────

-- Rimuovi vecchio vincolo e tutte le policy
ALTER TABLE persone DROP CONSTRAINT IF EXISTS persone_user_id_local_id_key;
DROP POLICY IF EXISTS "Users can CRUD own persone" ON persone;
DROP POLICY IF EXISTS "Authenticated can read persone" ON persone;
DROP POLICY IF EXISTS "Writers can insert persone" ON persone;
DROP POLICY IF EXISTS "Writers can update persone" ON persone;
DROP POLICY IF EXISTS "Writers can delete persone" ON persone;

-- Nuovo vincolo UNIQUE su solo local_id
ALTER TABLE persone DROP CONSTRAINT IF EXISTS persone_local_id_key;
ALTER TABLE persone ADD CONSTRAINT persone_local_id_key UNIQUE (local_id);

-- Tutti possono leggere
CREATE POLICY "Authenticated can read persone"
    ON persone FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- Admin, editor, hr possono scrivere
CREATE POLICY "Writers can insert persone"
    ON persone FOR INSERT
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'hr'));

CREATE POLICY "Writers can update persone"
    ON persone FOR UPDATE
    USING (public.get_user_role() IN ('admin', 'editor', 'hr'))
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'hr'));

CREATE POLICY "Writers can delete persone"
    ON persone FOR DELETE
    USING (public.get_user_role() IN ('admin', 'editor', 'hr'));

-- ─── 5. ALLOCAZIONI: shared ────────────────────────────────

-- Rimuovi vecchio vincolo e tutte le policy
ALTER TABLE allocazioni DROP CONSTRAINT IF EXISTS allocazioni_user_id_local_id_key;
DROP POLICY IF EXISTS "Users can CRUD own allocazioni" ON allocazioni;
DROP POLICY IF EXISTS "Authenticated can read allocazioni" ON allocazioni;
DROP POLICY IF EXISTS "Writers can insert allocazioni" ON allocazioni;
DROP POLICY IF EXISTS "Writers can update allocazioni" ON allocazioni;
DROP POLICY IF EXISTS "Writers can delete allocazioni" ON allocazioni;

-- Nuovo vincolo UNIQUE su solo local_id
ALTER TABLE allocazioni DROP CONSTRAINT IF EXISTS allocazioni_local_id_key;
ALTER TABLE allocazioni ADD CONSTRAINT allocazioni_local_id_key UNIQUE (local_id);

-- Tutti possono leggere
CREATE POLICY "Authenticated can read allocazioni"
    ON allocazioni FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- Admin, editor, commercial possono scrivere
CREATE POLICY "Writers can insert allocazioni"
    ON allocazioni FOR INSERT
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'commercial'));

CREATE POLICY "Writers can update allocazioni"
    ON allocazioni FOR UPDATE
    USING (public.get_user_role() IN ('admin', 'editor', 'commercial'))
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'commercial'));

CREATE POLICY "Writers can delete allocazioni"
    ON allocazioni FOR DELETE
    USING (public.get_user_role() IN ('admin', 'editor', 'commercial'));

-- ─── 6. AUDIT_LOG: shared ──────────────────────────────────

-- Rimuovi vecchio vincolo e tutte le policy
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_id_local_id_key;
DROP POLICY IF EXISTS "Users can CRUD own audit" ON audit_log;
DROP POLICY IF EXISTS "Authenticated can read audit" ON audit_log;
DROP POLICY IF EXISTS "Non-viewers can insert audit" ON audit_log;
DROP POLICY IF EXISTS "Non-viewers can update audit" ON audit_log;

-- Nuovo vincolo UNIQUE su solo local_id
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_local_id_key;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_local_id_key UNIQUE (local_id);

-- Tutti possono leggere
CREATE POLICY "Authenticated can read audit"
    ON audit_log FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- Chiunque non-viewer può scrivere audit
CREATE POLICY "Non-viewers can insert audit"
    ON audit_log FOR INSERT
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'hr', 'commercial'));

CREATE POLICY "Non-viewers can update audit"
    ON audit_log FOR UPDATE
    USING (public.get_user_role() IN ('admin', 'editor', 'hr', 'commercial'))
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'hr', 'commercial'));

-- ─── 7. PREFERENCES: restano per-utente ────────────────────
-- Nessuna modifica necessaria, già corrette.

-- ─── 8. SYNC_STATE: restano per-utente ─────────────────────
-- Nessuna modifica necessaria, già corrette.

-- ─── 9. Aggiorna indici (rimuovi user_id dove non serve) ──
DROP INDEX IF EXISTS idx_scenarios_user;
DROP INDEX IF EXISTS idx_persone_user;
DROP INDEX IF EXISTS idx_allocazioni_user;
DROP INDEX IF EXISTS idx_allocazioni_scenario;
DROP INDEX IF EXISTS idx_audit_user;

CREATE INDEX IF NOT EXISTS idx_scenarios_active ON scenarios(local_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_persone_active ON persone(local_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_allocazioni_active ON allocazioni(local_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_allocazioni_scenario ON allocazioni(scenario_local_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);

-- ─── 10. Pulizia dati duplicati (se necessario) ────────────
-- Se ci sono righe duplicate per lo stesso local_id (da utenti diversi),
-- teniamo solo la più recente.
-- NOTA: esegui PRIMA di aggiungere il vincolo UNIQUE se fallisce.

-- Decommentare SOLO se il vincolo UNIQUE fallisce per duplicati:
/*
DELETE FROM scenarios a USING scenarios b
WHERE a.id < b.id AND a.local_id = b.local_id;

DELETE FROM persone a USING persone b
WHERE a.id < b.id AND a.local_id = b.local_id;

DELETE FROM allocazioni a USING allocazioni b
WHERE a.id < b.id AND a.local_id = b.local_id;

DELETE FROM audit_log a USING audit_log b
WHERE a.id < b.id AND a.local_id = b.local_id;
*/

-- ============================================================
-- FATTO! Verifica con:
--   SELECT * FROM user_roles;
--   SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public';
-- ============================================================
