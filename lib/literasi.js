// Pojok Literasi, the two things the Vercel side decides about an article:
// what it costs to unlock, and what reading it is worth.
//
// Everything else about the shelf lives in the Edge Function
// (supabase/functions/literasi). These two stay here because the Souls
// balance, the unlock claim (user_unlocks) and the XP ledger (xp_events) are
// here, and a currency that can be moved from two places is a support ticket
// waiting to happen.
//
// Product id on the wire: 'literasi:<article id>', e.g. 'literasi:R-04'. The
// prefix keeps the article shelf out of STORE_PRICES (lib/store-products.js),
// whose ids are hand-typed — article prices come from the table, so a new
// article never needs a deploy.
const { supabase } = require('./supabase');

const LITERASI_PREFIX = 'literasi:';
const ARTICLE_ID = /^[A-Z]-\d{2}$/;

function isLiterasiProduct(productId) {
  return typeof productId === 'string' && productId.startsWith(LITERASI_PREFIX);
}

function articleIdOf(productId) {
  const id = isLiterasiProduct(productId) ? productId.slice(LITERASI_PREFIX.length) : '';
  return ARTICLE_ID.test(id) ? id : null;
}

async function loadArticle(articleId) {
  if (!ARTICLE_ID.test(articleId || '')) return null;
  const { data, error } = await supabase
    .from('literasi_articles')
    .select('id, access, price')
    .eq('id', articleId)
    .eq('status', 'published')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function hasPrivilege(wpUserId) {
  const { data, error } = await supabase.rpc('is_privilege', { p_wp_user_id: wpUserId });
  if (error) {
    console.error('literasi: is_privilege failed, treating as no:', error.message);
    return false;
  }
  return data === true;
}

async function isUnlocked(wpUserId, articleId) {
  const { data, error } = await supabase
    .from('user_unlocks')
    .select('product_id')
    .eq('wp_user_id', wpUserId)
    .eq('product_id', LITERASI_PREFIX + articleId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** What unlocking this article costs right now, or null when the id is not a
 *  published Souls-keyed article — never quietly free, same rule as priceOf.
 *  A Privilege member is told it is already open instead of being charged;
 *  the brief says membership opens the whole shelf, and a member who taps a
 *  lock the app should not have shown them must not lose Souls over it. */
async function literasiPriceOf(wpUserId, productId) {
  const articleId = articleIdOf(productId);
  if (!articleId) return { price: null };
  const article = await loadArticle(articleId);
  if (!article || article.access !== 'souls' || typeof article.price !== 'number') return { price: null };
  if (await hasPrivilege(wpUserId)) return { price: article.price, openByPrivilege: true };
  return { price: article.price };
}

/** Reading an article: which XP action it is, after checking the reader may
 *  actually have read it. Also stamps read_at (first time only) on the
 *  reader's row — the tick on the card and the Home "Sudah dibaca" come from
 *  that stamp, and it belongs next to the XP decision so the two can't drift.
 *
 *  Returns { ok: true, actionType } or { ok: false, status, error }. */
async function resolveLiterasiRead(wpUserId, articleId) {
  const article = await loadArticle(articleId);
  if (!article) return { ok: false, status: 400, error: 'Unknown article' };

  let actionType = 'literasi_read';
  if (article.access === 'souls') {
    const open = (await isUnlocked(wpUserId, articleId)) || (await hasPrivilege(wpUserId));
    if (!open) return { ok: false, status: 403, error: 'Artikel ini belum terbuka.' };
    actionType = 'literasi_read_deep';
  }

  const now = new Date().toISOString();
  const { data: existing, error: readError } = await supabase
    .from('literasi_user_articles')
    .select('read_at')
    .eq('wp_user_id', wpUserId)
    .eq('article_id', articleId)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing) {
    const { error } = await supabase
      .from('literasi_user_articles')
      .insert({ wp_user_id: wpUserId, article_id: articleId, read_at: now, updated_at: now });
    // A race with the Edge Function's upsert of a bookmark is fine: the row
    // now exists, and the update below is what a retry does anyway.
    if (error && error.code !== '23505') throw error;
    if (error) {
      const { error: updateError } = await supabase
        .from('literasi_user_articles')
        .update({ read_at: now, updated_at: now })
        .eq('wp_user_id', wpUserId)
        .eq('article_id', articleId)
        .is('read_at', null);
      if (updateError) throw updateError;
    }
  } else if (!existing.read_at) {
    const { error } = await supabase
      .from('literasi_user_articles')
      .update({ read_at: now, updated_at: now })
      .eq('wp_user_id', wpUserId)
      .eq('article_id', articleId);
    if (error) throw error;
  }

  return { ok: true, actionType };
}

module.exports = { LITERASI_PREFIX, isLiterasiProduct, articleIdOf, literasiPriceOf, resolveLiterasiRead };
