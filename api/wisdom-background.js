const { verifyWpUser } = require('../lib/wp-auth');

const UNSPLASH_API_URL = 'https://api.unsplash.com';

// One function, two jobs, split by method — merged from wisdom-background-search
// (GET) and wisdom-background-select (POST) to free a slot under Vercel's
// 12-function cap for api/certificate-image.js. Same auth, same env var, and
// the app's services/wisdomBackend.ts was updated in the same change.
//
// GET  ?query=&page=  — Unsplash portrait search (key stays server-side, same
//                       reason the Anthropic key stays out of the app).
// POST {downloadLocation} — Unsplash's required download ping, called once when
//                       a photo is actually picked, not on every search result.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
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

  if (req.method === 'POST') {
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
    return;
  }

  const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const params = new URLSearchParams({
    orientation: 'portrait',
    per_page: '24',
    page: String(page),
  });
  if (query) params.set('query', query);

  const endpoint = query ? '/search/photos' : '/photos';
  try {
    const upstream = await fetch(`${UNSPLASH_API_URL}${endpoint}?${params.toString()}`, {
      headers: { Authorization: `Client-ID ${accessKey}` },
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: data?.errors?.[0] || 'Unsplash request failed' });
      return;
    }

    const rawResults = query ? data.results : data;
    const results = (rawResults || []).map((photo) => ({
      id: photo.id,
      thumbUrl: photo.urls.small,
      fullUrl: photo.urls.regular,
      downloadLocation: photo.links.download_location,
      credit: { name: photo.user?.name || 'Unsplash', profileUrl: photo.user?.links?.html || null },
    }));

    res.status(200).json({ results });
  } catch (err) {
    console.error('Unsplash search error:', err);
    res.status(502).json({ error: 'Could not reach Unsplash right now. Please try again.' });
  }
};
