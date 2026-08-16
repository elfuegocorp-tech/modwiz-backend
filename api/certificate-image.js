const crypto = require('crypto');

const { supabase } = require('../lib/supabase');
const { WP_BASE_URL } = require('../lib/wp-auth');

// GET /api/certificate-image?id=<certificate id>
//
// The certificate as a HIGH-RES IMAGE (jpeg), not HTML. WordPress's
// modwiz/v1/certificates/<id>/html endpoint (see modwiz-app
// wordpress/modwiz-certificates.php) already builds a complete standalone
// document with the user's name, the award date, LifterLMS's dynamic styles
// and the theme's preset CSS — this function opens that document in headless
// Chromium and photographs it at 2x, which is exactly what the phone's
// WebView used to do live, minus every device-side rendering headache
// (Android needed a fresh eas build just for the webview native module).
//
// Auth is delegated entirely to WordPress: the caller's Basic auth header is
// forwarded to the /html route, which requires login AND checks ownership via
// LifterLMS's can_user_view(). No separate verifyWpUser round trip needed —
// if WordPress serves us the HTML, the caller is allowed to see the image.
//
// Rendered images are cached in the private `certificates` Storage bucket,
// keyed by a hash of the HTML itself — so each certificate renders through
// Chromium exactly once, and a redesign (new background, fixed typo) changes
// the hash and re-renders on next view. Cache hits skip Chromium entirely and
// return in storage-download time.
//
// The response is the image bytes (Content-Type: image/jpeg), NOT a JSON
// envelope with a signed URL — deliberate: the app points expo-image straight
// at this endpoint with the auth header, and because the URL is stable
// (/api/certificate-image?id=N), expo-image's disk cache works. A signed URL
// would be different on every request and defeat the client cache.
//
// JPEG over PNG: the certificate designs carry photographic background art,
// which balloons a 2x PNG toward Vercel's ~4.5MB response ceiling. JPEG at
// quality 92 keeps text crisp and lands well under it.

const BUCKET = 'certificates';
const JPEG_QUALITY = 92;
const SCALE = 2; // deviceScaleFactor — "2x" in the storage filename.

async function renderJpeg(html) {
  // Required lazily so a cache hit never pays the chromium import cost.
  const chromium = require('@sparticuz/chromium');
  const puppeteer = require('puppeteer-core');

  // The WP snippet writes the certificate's true pixel width into the
  // viewport meta so phones scale it; here it sizes the browser window.
  const viewportMatch = html.match(/name="viewport" content="width=(\d+)"/);
  const width = viewportMatch ? parseInt(viewportMatch[1], 10) : 980;

  // Exactly the launch shape @sparticuz/chromium documents. In particular
  // `headless: chromium.headless` (their "shell" mode), NOT `true` — the
  // packaged binary is chrome-headless-shell, and asking it for the regular
  // new-headless mode can fail the launch outright on Vercel.
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height: Math.round(width * 0.75), deviceScaleFactor: SCALE });
    // networkidle0 waits for the background image, block-library CSS and any
    // Google Fonts links; document.fonts.ready then covers font rasterizing.
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    // fullPage: the document is exactly the certificate, so full page = the
    // whole parchment at its true aspect ratio, whatever its height.
    return await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, fullPage: true });
  } finally {
    await browser.close();
  }
}

async function uploadToCache(path, jpeg) {
  const options = { contentType: 'image/jpeg', upsert: true };
  let { error } = await supabase.storage.from(BUCKET).upload(path, jpeg, options);
  if (error && /not found/i.test(error.message || '')) {
    // First certificate ever rendered — create the (private) bucket, retry once.
    await supabase.storage.createBucket(BUCKET, { public: false }).catch(() => {});
    ({ error } = await supabase.storage.from(BUCKET).upload(path, jpeg, options));
  }
  if (error) console.error('Certificate cache upload failed:', error.message);
  // Upload failure is non-fatal — the render already succeeded; worst case the
  // next view renders again.
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const id = parseInt(req.query.id, 10);
  const authHeader = req.headers.authorization;
  if (!id || !authHeader) {
    res.status(400).json({ error: 'Missing certificate id or login' });
    return;
  }

  // WordPress is the gatekeeper: login + ownership + the HTML, one round trip.
  const wpRes = await fetch(`${WP_BASE_URL}/wp-json/modwiz/v1/certificates/${id}/html`, {
    headers: { Authorization: authHeader },
  }).catch(() => null);
  if (!wpRes || !wpRes.ok) {
    const status = wpRes ? wpRes.status : 502;
    res.status(status).json({ error: `Certificate not available (status ${status})` });
    return;
  }
  const { html } = await wpRes.json();
  if (typeof html !== 'string' || !html) {
    res.status(502).json({ error: 'WordPress returned no certificate HTML' });
    return;
  }

  const hash = crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);
  const path = `${id}-${hash}@${SCALE}x.jpg`;

  const cached = await supabase.storage.from(BUCKET).download(path);
  let jpeg;
  if (cached.data) {
    jpeg = Buffer.from(await cached.data.arrayBuffer());
  } else {
    try {
      jpeg = await renderJpeg(html);
    } catch (err) {
      console.error('Certificate render error:', err);
      // detail surfaces the real chromium/puppeteer failure to a curl —
      // this project has no log access from the dev machine (CLI logged
      // out), so the response body IS the debugging channel.
      res.status(500).json({
        error: 'Could not render the certificate image',
        detail: String((err && err.message) || err).slice(0, 500),
      });
      return;
    }
    await uploadToCache(path, jpeg);
  }

  res.setHeader('Content-Type', 'image/jpeg');
  // Private: it has the student's name on it. The hash in our storage key is
  // not in this URL, so the only cache allowed is the caller's own device.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.status(200).send(jpeg);
};
