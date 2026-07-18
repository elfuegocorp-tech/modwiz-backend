const { verifyWpUser } = require('../lib/wp-auth');

const UNSPLASH_API_URL = 'https://api.unsplash.com';

// Keeps the Unsplash Access Key server-side, same reason the Anthropic key
// stays out of the app — and forces every search to portrait orientation
// since that's the only shape the Wisdom quote card template supports.
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
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
