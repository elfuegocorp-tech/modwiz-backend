// Pojok Literasi — the shelf of 60–90 second articles (modwiz-app
// app/literasi/*). One deployed function, four routes:
//
//   GET  /literasi            everything the shelf and the reader need in one
//                             trip: articles (locked ones cut to their first
//                             slide), this reader's own marks, the ids they
//                             unlocked, whether Privilege is on, counters.
//   POST /literasi/bookmark   { articleId, on }
//   POST /literasi/like       { articleId, on }
//   POST /literasi/shared     { articleId }
//
// What is NOT here, and why:
//   - Unlocking with Souls goes through the Vercel backend's spend-souls
//     (action unlock_product, productId 'literasi:<id>'), because that is
//     where the balance, the ledger and the idempotent user_unlocks claim
//     already live. Two places that can move Souls is one too many.
//   - Marking an article read goes through record-action (actionType
//     literasi_read), because reading pays XP and the XP ledger lives there.
//
// WHY THE TEXT IS TRIMMED HERE. Rheza's rule: the hook is free, the content is
// paid. If the app held every slide and only hid them, "locked" would be a
// courtesy. So a locked article leaves this function as its hook plus a slide
// count, and the rest only ever travels to a reader who paid or holds
// Privilege — decided by user_unlocks and is_privilege(), never by a flag the
// app sends (CLAUDE.md: the app's isPrivilege is for Merlin's tone).
//
// verify_jwt = false in supabase/config.toml, like every function here — the
// caller is a WordPress user, re-checked by withAuth on each request.

import { json, supabase, withAuth, type WpUser } from '../_shared/http.ts';

const PRODUCT_PREFIX = 'literasi:';
const ARTICLE_ID = /^[A-Z]-\d{2}$/;

type Slide = { kind: 'hook' | 'wow' | 'aha' | 'coba' | 'cta'; text: string; cta?: { label: string } };
type ArticleRow = {
  id: string;
  category: string;
  title: string;
  access: 'free' | 'souls';
  price: number | null;
  slides: Slide[];
  featured: boolean;
  sort: number;
  published_at: string;
};
type MineRow = {
  article_id: string;
  read_at: string | null;
  bookmarked_at: string | null;
  liked_at: string | null;
  shared_at: string | null;
};
type CountRow = { article_id: string; likes: number; bookmarks: number; shares: number; reads: number };

async function isPrivilege(wpUserId: number): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_privilege', { p_wp_user_id: wpUserId });
  if (error) {
    // Fail CLOSED for access: a reader with Privilege who is briefly shown a
    // lock can tap and pay nothing (the unlock route also checks); a reader
    // without it who is shown the text has read something they did not pay for.
    console.error('literasi: is_privilege failed, treating as no:', error.message);
    return false;
  }
  return data === true;
}

async function unlockedIds(wpUserId: number): Promise<Record<string, string>> {
  const { data, error } = await supabase
    .from('user_unlocks')
    .select('product_id, unlocked_at')
    .eq('wp_user_id', wpUserId)
    .like('product_id', `${PRODUCT_PREFIX}%`);
  if (error) throw error;
  const out: Record<string, string> = {};
  for (const row of data ?? []) out[row.product_id.slice(PRODUCT_PREFIX.length)] = row.unlocked_at;
  return out;
}

async function handleList(user: WpUser): Promise<Response> {
  const [{ data: rows, error }, mineRes, countsRes, unlocks, privilege] = await Promise.all([
    supabase
      .from('literasi_articles')
      .select('id, category, title, access, price, slides, featured, sort, published_at')
      .eq('status', 'published')
      .order('sort', { ascending: true }),
    supabase
      .from('literasi_user_articles')
      .select('article_id, read_at, bookmarked_at, liked_at, shared_at')
      .eq('wp_user_id', user.id),
    supabase.from('literasi_article_counts').select('article_id, likes, bookmarks, shares, reads'),
    unlockedIds(user.id),
    isPrivilege(user.id),
  ]);
  if (error) throw error;
  if (mineRes.error) throw mineRes.error;
  if (countsRes.error) throw countsRes.error;

  const articles = ((rows ?? []) as ArticleRow[]).map((a) => {
    const locked = a.access === 'souls' && !privilege && !unlocks[a.id];
    return {
      id: a.id,
      category: a.category,
      title: a.title,
      access: a.access,
      price: a.price,
      featured: a.featured,
      publishedAt: a.published_at,
      slideCount: a.slides.length,
      locked,
      // A locked article travels as its hook only. The count tells the reader
      // how much is behind the door without handing over any of it.
      slides: locked ? a.slides.slice(0, 1) : a.slides,
    };
  });

  const mine: Record<string, { readAt: string | null; bookmarkedAt: string | null; likedAt: string | null; sharedAt: string | null }> = {};
  for (const m of (mineRes.data ?? []) as MineRow[]) {
    mine[m.article_id] = { readAt: m.read_at, bookmarkedAt: m.bookmarked_at, likedAt: m.liked_at, sharedAt: m.shared_at };
  }
  const counts: Record<string, { likes: number; bookmarks: number; shares: number; reads: number }> = {};
  for (const c of (countsRes.data ?? []) as CountRow[]) {
    counts[c.article_id] = { likes: Number(c.likes), bookmarks: Number(c.bookmarks), shares: Number(c.shares), reads: Number(c.reads) };
  }

  return json({ articles, mine, counts, unlocks, isPrivilege: privilege });
}

async function articleExists(id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('literasi_articles')
    .select('id')
    .eq('id', id)
    .eq('status', 'published')
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

/** Set or clear one timestamp column on this reader's row for the article. */
async function mark(
  user: WpUser,
  articleId: string,
  column: 'bookmarked_at' | 'liked_at' | 'shared_at',
  on: boolean,
): Promise<Response> {
  if (!ARTICLE_ID.test(articleId) || !(await articleExists(articleId))) {
    return json({ error: 'Unknown article' }, 400);
  }
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('literasi_user_articles')
    .upsert(
      { wp_user_id: user.id, article_id: articleId, [column]: on ? now : null, updated_at: now },
      { onConflict: 'wp_user_id,article_id' },
    );
  if (error) throw error;
  const { data: count, error: countError } = await supabase
    .from('literasi_article_counts')
    .select('likes, bookmarks, shares, reads')
    .eq('article_id', articleId)
    .maybeSingle();
  if (countError) throw countError;
  return json({
    ok: true,
    articleId,
    on,
    counts: count ?? { likes: 0, bookmarks: 0, shares: 0, reads: 0 },
  });
}

Deno.serve(
  withAuth('literasi', async (req, user, path) => {
    if (req.method === 'GET' && path === '') return handleList(user);

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const articleId = typeof body?.articleId === 'string' ? body.articleId : '';
      if (path === 'bookmark') return mark(user, articleId, 'bookmarked_at', body?.on !== false);
      if (path === 'like') return mark(user, articleId, 'liked_at', body?.on !== false);
      // Sharing is never un-shared: the card already left the phone.
      if (path === 'shared') return mark(user, articleId, 'shared_at', true);
    }

    return json({ error: 'Not found' }, 404);
  }),
);
