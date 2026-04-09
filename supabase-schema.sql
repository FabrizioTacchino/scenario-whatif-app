-- ============================================================
-- Supabase Schema for Scenario Whatif
-- SHARED WORKSPACE with role-based access control
--
-- Roles: admin, editor, hr, commercial, tester, viewer
--
-- Per setup iniziale: esegui in Supabase SQL Editor
-- Per migrazione da vecchio schema: usa supabase-migration-shared-workspace.sql
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Helper function: get current user role ─────────────────
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

-- ─── USER ROLES ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_roles (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'viewer',
    email TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id),
    CONSTRAINT user_roles_role_check CHECK (role IN ('admin', 'editor', 'hr', 'commercial', 'tester', 'viewer'))
);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read user_roles"
    ON user_roles FOR SELECT
    USING (auth.uid() IS NOT NULL);

CREATE POLICY "Users can insert own role"
    ON user_roles FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admin can update roles"
    ON user_roles FOR UPDATE
    USING (public.get_user_role() = 'admin')
    WITH CHECK (public.get_user_role() = 'admin');

-- ─── BASELINES (shared singleton) ───────────────────────────
CREATE TABLE IF NOT EXISTS baselines (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE baselines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read baselines"
    ON baselines FOR SELECT
    USING (auth.uid() IS NOT NULL);

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

-- ─── SCENARIOS (shared) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS scenarios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    local_id TEXT NOT NULL UNIQUE,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted BOOLEAN NOT NULL DEFAULT false,
    draft BOOLEAN NOT NULL DEFAULT false,
    created_by_email TEXT NOT NULL DEFAULT ''
);

ALTER TABLE scenarios ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_scenarios_draft ON scenarios(draft) WHERE NOT deleted;

-- SELECT: non-admin users see only non-draft rows; testers see their own drafts
CREATE POLICY "Authenticated can read scenarios"
    ON scenarios FOR SELECT
    USING (
        auth.uid() IS NOT NULL
        AND (
            draft = false
            OR public.get_user_role() = 'admin'
            OR (public.get_user_role() = 'tester' AND user_id = auth.uid())
        )
    );

-- INSERT: admin/editor/commercial can insert anything; tester can insert only drafts
CREATE POLICY "Writers can insert scenarios"
    ON scenarios FOR INSERT
    WITH CHECK (
        public.get_user_role() IN ('admin', 'editor', 'commercial')
        OR (public.get_user_role() = 'tester' AND draft = true)
    );

-- UPDATE: admin/editor/commercial can update anything; tester can update own drafts only
CREATE POLICY "Writers can update scenarios"
    ON scenarios FOR UPDATE
    USING (
        public.get_user_role() IN ('admin', 'editor', 'commercial')
        OR (public.get_user_role() = 'tester' AND draft = true AND user_id = auth.uid())
    )
    WITH CHECK (
        public.get_user_role() IN ('admin', 'editor', 'commercial')
        OR (public.get_user_role() = 'tester' AND draft = true AND user_id = auth.uid())
    );

-- DELETE: only admin/editor/commercial (testers cannot hard-delete)
CREATE POLICY "Writers can delete scenarios"
    ON scenarios FOR DELETE
    USING (public.get_user_role() IN ('admin', 'editor', 'commercial'));

-- ─── PERSONE (shared, writable by hr) ───────────────────────
CREATE TABLE IF NOT EXISTS persone (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    local_id TEXT NOT NULL UNIQUE,
    codice_fiscale TEXT NOT NULL DEFAULT '',
    cognome TEXT NOT NULL DEFAULT '',
    nome TEXT NOT NULL DEFAULT '',
    societa TEXT NOT NULL DEFAULT '',
    bu TEXT NOT NULL DEFAULT '',
    cdc TEXT NOT NULL DEFAULT '',
    vdc TEXT NOT NULL DEFAULT '',
    tdc TEXT NOT NULL DEFAULT '',
    ruolo TEXT NOT NULL DEFAULT '',
    tipo_contratto TEXT NOT NULL DEFAULT 'DIPENDENTE',
    data_assunzione TEXT NOT NULL DEFAULT '',
    data_termine TEXT NOT NULL DEFAULT '',
    costo_medio_mese NUMERIC NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    attivo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE persone ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read persone"
    ON persone FOR SELECT
    USING (auth.uid() IS NOT NULL);

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

-- ─── ALLOCAZIONI (shared) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS allocazioni (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    local_id TEXT NOT NULL UNIQUE,
    persona_local_id TEXT NOT NULL,
    codice_commessa TEXT NOT NULL DEFAULT '',
    scenario_local_id TEXT,
    percentuale NUMERIC NOT NULL DEFAULT 100,
    data_inizio TEXT NOT NULL DEFAULT '',
    data_fine TEXT NOT NULL DEFAULT '',
    aggancio_inizio BOOLEAN NOT NULL DEFAULT false,
    aggancio_fine BOOLEAN NOT NULL DEFAULT false,
    delta_inizio INTEGER NOT NULL DEFAULT 0,
    delta_fine INTEGER NOT NULL DEFAULT 0,
    origine TEXT NOT NULL DEFAULT 'manuale',
    is_base BOOLEAN NOT NULL DEFAULT false,
    note TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE allocazioni ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read allocazioni"
    ON allocazioni FOR SELECT
    USING (auth.uid() IS NOT NULL);

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

-- ─── AUDIT LOG (shared) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    local_id TEXT NOT NULL UNIQUE,
    entita TEXT NOT NULL,
    entita_id TEXT NOT NULL,
    operazione TEXT NOT NULL,
    vecchio_valore JSONB,
    nuovo_valore JSONB,
    origine TEXT NOT NULL DEFAULT 'manuale',
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read audit"
    ON audit_log FOR SELECT
    USING (auth.uid() IS NOT NULL);

CREATE POLICY "Non-viewers can insert audit"
    ON audit_log FOR INSERT
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'hr', 'commercial'));

CREATE POLICY "Non-viewers can update audit"
    ON audit_log FOR UPDATE
    USING (public.get_user_role() IN ('admin', 'editor', 'hr', 'commercial'))
    WITH CHECK (public.get_user_role() IN ('admin', 'editor', 'hr', 'commercial'));

-- ─── PREFERENCES (per-user) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS preferences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id, key)
);

ALTER TABLE preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD own preferences"
    ON preferences FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ─── SYNC STATE (per-user) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    entity TEXT NOT NULL,
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT '1970-01-01',
    UNIQUE(user_id, entity)
);

ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can CRUD own sync_state"
    ON sync_state FOR ALL
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- ─── INDEXES ────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_scenarios_active ON scenarios(local_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_persone_active ON persone(local_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_allocazioni_active ON allocazioni(local_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_allocazioni_scenario ON allocazioni(scenario_local_id) WHERE NOT deleted;
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_preferences_user ON preferences(user_id);
