// Admin-only: lists pending Souls requests so an admin can review and
// approve/deny them from app/admin/grant-souls.tsx.
const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const wpUser = await verifyWpUser(req.headers.authorization).catch(() => null);
  if (!wpUser) {
    res.status(401).json({ error: 'Could not verify your Modwiz Mastery login' });
    return;
  }

  try {
    const { data: allowlisted, error: allowlistError } = await supabase
      .from('admin_allowlist')
      .select('wp_user_id')
      .eq('wp_user_id', wpUser.id)
      .maybeSingle();
    if (allowlistError) throw allowlistError;

    if (!allowlisted) {
      res.status(403).json({ error: 'Not authorized' });
      return;
    }

    const { data, error } = await supabase
      .from('souls_requests')
      .select('id, wp_user_id, message, created_at')
      .eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) throw error;

    res.status(200).json({ requests: data || [] });
  } catch (err) {
    console.error('gamification/list-souls-requests error:', err);
    res.status(500).json({ error: 'Could not load Souls requests right now.' });
  }
};
