const { verifyWpUser } = require('../lib/wp-auth');

// The composited quote-card image (background + quote text, rendered
// client-side) is small — a few hundred KB — so it's fine to pass through
// this backend as base64 JSON, unlike the video. This keeps the Bunny
// Storage Zone's write password out of the app, same reasoning as the other
// endpoints here.
const MAX_BASE64_LENGTH = 6_000_000; // ~4.5MB decoded, generous for a JPEG card

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

  const storageZone = process.env.BUNNY_WISDOM_STORAGE_ZONE;
  const storagePassword = process.env.BUNNY_WISDOM_STORAGE_PASSWORD;
  // Defaults to Bunny's main storage endpoint — override if your zone was
  // created in a specific region (e.g. "ny.storage.bunnycdn.com").
  const storageHostname = process.env.BUNNY_WISDOM_STORAGE_HOSTNAME || 'storage.bunnycdn.com';
  if (!storageZone || !storagePassword) {
    res.status(500).json({ error: 'Backend is missing BUNNY_WISDOM_STORAGE_ZONE / BUNNY_WISDOM_STORAGE_PASSWORD' });
    return;
  }

  const { imageBase64 } = req.body || {};
  if (typeof imageBase64 !== 'string' || imageBase64.length === 0 || imageBase64.length > MAX_BASE64_LENGTH) {
    res.status(400).json({ error: 'imageBase64 is required and must be a reasonably small JPEG' });
    return;
  }

  const buffer = Buffer.from(imageBase64, 'base64');
  const fileName = `wisdom/${wpUser.id}-${Date.now()}.jpg`;

  try {
    const upstream = await fetch(`https://${storageHostname}/${storageZone}/${fileName}`, {
      method: 'PUT',
      headers: { AccessKey: storagePassword, 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      res.status(502).json({ error: `Bunny storage upload failed: ${text || upstream.status}` });
      return;
    }

    res.status(200).json({ url: `https://${storageZone}.b-cdn.net/${fileName}` });
  } catch (err) {
    console.error('Bunny storage upload error:', err);
    // Surfacing the real cause (e.g. DNS failure on a bad hostname) instead
    // of a generic message — this is a low-traffic internal endpoint, safe
    // to show the underlying error while diagnosing setup issues.
    const detail = err?.cause?.message || err?.message || 'unknown error';
    res.status(502).json({ error: `Could not reach Bunny storage right now: ${detail}` });
  }
};
