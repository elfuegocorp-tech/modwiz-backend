// Shared Supabase client for the gamification feature (Streak/XP/Souls).
// Uses the service_role key — full read/write access, server-side only.
// Never send this key to the app; the app only ever talks to this backend,
// which is the only thing that talks to Supabase.
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

module.exports = { supabase };
