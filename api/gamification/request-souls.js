// A user's "please give me more Souls" ask. Files into a queue for an admin
// to review — nothing is granted automatically here, ever.

const { verifyWpUser } = require('../../lib/wp-auth');
const { supabase } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }

  const wpUser = await verifyWpUser(authHeader).catch(() => null);
  if (!wpUser) {
    res.status(401).json({ error: 'Could not verify your Modwiz Mastery login' });
    return;
  }

  const message =
    typeof (req.body && req.body.message) === 'string' ? req.body.message.trim().slice(0, 500) : null;

  try {
    const { error } = await supabase.from('souls_requests').insert({
      wp_user_id: wpUser.id,
      message,
    });
    if (error) throw error;

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('gamification/request-souls error:', err);
    res.status(500).json({ error: 'Could not send your request right now.' });
  }
};
