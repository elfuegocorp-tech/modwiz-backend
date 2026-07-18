const { verifyWpUser } = require('../lib/wp-auth');

// Unsplash's API guidelines require pinging a photo's download_location the
// moment it's actually used (not just previewed) — call this once, when the
// user picks a background in the submission form, not on every search result.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers.authorization;
  const wpUser = await verifyWpUser(authHeader).catch(() => null);
  if (!wpUser) {
    res.status(401).json({ error: 'Could not verify your Modwiz Mastery login' });
    return;
  }

  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey) {
    res.status(500).json({ error: 'Backend is missing UNSPLASH_ACCESS_KEY' });
    return;
  }

  const { downloadLocation } = req.body || {};
  if (typeof downloadLocation !== 'string' || !downloadLocation.startsWith('https://api.unsplash.com/')) {
    res.status(400).json({ error: 'Invalid downloadLocation' });
    return;
  }

  try {
    await fetch(downloadLocation, { headers: { Authorization: `Client-ID ${accessKey}` } });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unsplash download-ping error:', err);
    // Non-fatal for the user's flow — they've already picked their photo.
    res.status(200).json({ ok: false });
  }
};
