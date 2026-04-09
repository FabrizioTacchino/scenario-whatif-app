// ─── Supabase Client — Scenario Whatif ───────────────────────
// Singleton client + auth helper functions.
// Runs entirely in the renderer process (ES module).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://qqxttvtofnpvuakzqdcg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFxeHR0dnRvZm5wdnVha3pxZGNnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDYzMjMsImV4cCI6MjA5MDUyMjMyM30.dlvfjMJ0IAkpYjZks4TS_vIyQYAlq4OFTVSHjwhKZmE';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        storageKey: 'whatif_supabase_auth',
    }
});

// ─── Auth helpers ────────────────────────────────────────────

export async function signUp(email, password) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    return data;
}

export async function signIn(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
}

export async function signOut() {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
}

export async function getSession() {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    return data.session;
}

export async function getUser() {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    return data.user;
}

export function onAuthStateChange(callback) {
    return supabase.auth.onAuthStateChange((_event, session) => {
        callback(session);
    });
}

// ─── Role management ────────────────────────────────────────

/**
 * Get current user's role. Auto-inserts a 'viewer' row if first time
 * (the DB trigger promotes the first user to 'admin').
 */
export async function getUserRole() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;

    let { data } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();

    if (!data) {
        const { data: inserted, error: insertErr } = await supabase
            .from('user_roles')
            .insert({ user_id: user.id, role: 'viewer', email: user.email || '' })
            .select('role')
            .single();
        if (insertErr) throw insertErr;
        data = inserted;
    }

    return data.role;
}

/**
 * List all users with their roles (any authenticated user can read).
 */
export async function listUsers() {
    const { data, error } = await supabase
        .from('user_roles')
        .select('user_id, role, email, created_at')
        .order('created_at');
    if (error) throw error;
    return data;
}

/**
 * Update a user's role (admin only — enforced by RLS).
 */
export async function updateUserRole(targetUserId, newRole) {
    const { data, error } = await supabase
        .from('user_roles')
        .update({ role: newRole })
        .eq('user_id', targetUserId)
        .select()
        .single();
    if (error) throw error;
    return data;
}
