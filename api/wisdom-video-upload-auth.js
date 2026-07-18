const crypto = require('crypto');
const { verifyWpUser } = require('../lib/wp-auth');

// Bunny Stream's TUS (resumable) upload protocol lets the phone upload the
// video file directly to Bunny — never through this backend — using a
// signature that's only valid for a short window, so the permanent Bunny
// Stream API key never has to leave this server.
//
// NOTE: verify this exact signature formula (sha256 of libraryId + apiKey +
// expiration + videoId) and the create-video/tus endpoint URLs against
// Bunny's current Stream API docs before relying on this in production —
// same "check the live docs first" rule this project applies to Expo.
const BUNNY_STREAM_API = 'https://video.bunnycdn.com';
const UPLOAD_TTL_SECONDS = 3600;
const MAX_TITLE_LENGTH = 120;

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

  const libraryId = process.env.BUNNY_STREAM_LIBRARY_ID;
  const apiKey = process.env.BUNNY_STREAM_API_KEY;
  // The lesson videos already playing in the app (PrestoPlayer) use a
  // direct Bunny CDN URL with expo-video, not the iframe embed — this
  // library's own pull zone hostname (found on the Stream library's
  // dashboard, looks like vz-xxxxxxxx-xxx.b-cdn.net) lets Wisdom videos play
  // the same native way instead of needing a WebView.
  const pullZoneHostname = process.env.BUNNY_STREAM_PULL_ZONE_HOSTNAME;
  if (!libraryId || !apiKey || !pullZoneHostname) {
    res.status(500).json({
      error: 'Backend is missing BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY / BUNNY_STREAM_PULL_ZONE_HOSTNAME',
    });
    return;
  }

  const rawTitle = typeof (req.body || {}).title === 'string' ? req.body.title.trim() : '';
  const title = (rawTitle || `wisdom-${wpUser.id}-${Date.now()}`).slice(0, MAX_TITLE_LENGTH);

  try {
    const createRes = await fetch(`${BUNNY_STREAM_API}/library/${libraryId}/videos`, {
      method: 'POST',
      headers: { AccessKey: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const created = await createRes.json();
    if (!createRes.ok || !created?.guid) {
      res.status(502).json({ error: created?.message || 'Could not create the video on Bunny Stream' });
      return;
    }

    const videoId = created.guid;
    const expiration = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
    const signature = crypto
      .createHash('sha256')
      .update(`${libraryId}${apiKey}${expiration}${videoId}`)
      .digest('hex');

    res.status(200).json({
      videoId,
      libraryId,
      expiration,
      signature,
      tusEndpoint: `${BUNNY_STREAM_API}/tusupload`,
      // HLS playback URL, playable directly in expo-video — same shape as
      // the lesson videos already working in the app. Not ready instantly:
      // Bunny needs a little time to finish processing after upload, so the
      // app should tolerate an initial playback failure and let the video
      // segment retry rather than assuming this URL is live right away.
      playbackUrl: `https://${pullZoneHostname}/${videoId}/playlist.m3u8`,
    });
  } catch (err) {
    console.error('Bunny Stream upload-auth error:', err);
    res.status(502).json({ error: 'Could not reach Bunny Stream right now. Please try again.' });
  }
};
