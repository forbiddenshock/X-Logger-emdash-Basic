/**
 * emdash-xlog - EmDash CMS + xlog.showya-kiss.com スタイル日別Xログサイト (Cloudflare Workers + D1 + R2)
 *
 * - D1 (env.DB): 日別記事 (x_log_posts / ec_posts / revisions) とサイト設定を管理
 * - R2 (env.MEDIA): ポスト内の画像・動画を永続保存し、/media/:key (Rangeリクエスト対応) で高速配信
 * - フロント画面: xlog.showya-kiss.com 互換のシンプルで見やすい日別ログテーマ（月別アーカイブ・検索・ページネーション・RSS対応）
 * - 管理画面 (/_emdash/admin または /admin): 記事の確認・編集・削除・サイトタイトル変更・メディア一覧
 * - REST API (/_emdash/api/posts, /_emdash/api/media): X-Logger ワーカーや過去ログ一括インポーター (importer/index.html) からの連携用
 */

let schemaInitialized = false;

export function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Filename"
};

/**
 * 初回リクエスト時に D1 テーブルを自動初期化（マイグレーションロック等のトラブルを防止）
 */
export async function ensureSchema(db) {
  if (!db || schemaInitialized) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS x_log_posts (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'published',
      post_count INTEGER NOT NULL DEFAULT 0,
      published_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_x_log_posts_slug ON x_log_posts(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_x_log_posts_published_at ON x_log_posts(published_at DESC)`,
    `CREATE TABLE IF NOT EXISTS x_log_media (
      key TEXT PRIMARY KEY,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS x_log_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS _emdash_collections (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      url_pattern TEXT,
      supports_revisions INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS _emdash_fields (
      id TEXT PRIMARY KEY,
      collection_slug TEXT NOT NULL,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      required INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE(collection_slug, slug)
    )`,
    `CREATE TABLE IF NOT EXISTS ec_posts (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'published',
      title TEXT,
      content TEXT,
      html_body TEXT,
      author_id TEXT DEFAULT 'system',
      primary_byline_id TEXT DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      published_at TEXT,
      scheduled_at TEXT,
      deleted_at TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      live_revision_id TEXT,
      draft_revision_id TEXT,
      locale TEXT NOT NULL DEFAULT 'ja',
      translation_group TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY,
      collection_slug TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'published',
      data TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ];

  for (const sql of statements) {
    await db.prepare(sql).run();
  }
  schemaInitialized = true;
}

/**
 * サイト設定（タイトル・サブタイトル）を取得
 */
async function getSiteSettings(env) {
  let title = env.SITE_TITLE || "X-Log";
  let subtitle = env.SITE_SUBTITLE || "Daily X (Twitter) Archive powered by EmDash";

  if (env.DB) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT key, value FROM x_log_settings WHERE key IN ('site_title', 'site_subtitle')`
      ).all();
      for (const row of results || []) {
        if (row.key === "site_title" && row.value) title = row.value;
        if (row.key === "site_subtitle" && row.value !== undefined) subtitle = row.value;
      }
    } catch {
      // ignore
    }
  }
  return { title, subtitle };
}

/**
 * 記事内の x-post ブロック数をカウント
 */
function countPostsInHtml(html) {
  const matches = String(html || "").match(/id="x-post-\d+"/g);
  return matches ? matches.length : 1;
}

/**
 * D1 に日別記事を保存（x_log_posts と EmDash 互換の ec_posts / revisions の両方に同期）
 */
async function upsertDayPostInD1(db, { slug, title, content, publishedAt }) {
  const now = new Date().toISOString();
  const pubDate = publishedAt || `${slug}T00:00:01Z`;
  const postCount = countPostsInHtml(content);

  const existing = await db
    .prepare(`SELECT id, created_at FROM x_log_posts WHERE slug = ?1`)
    .bind(slug)
    .first();

  const id = existing?.id || `post_${slug}`;
  const createdAt = existing?.created_at || now;

  await db
    .prepare(
      `INSERT INTO x_log_posts (id, slug, title, content, status, post_count, published_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'published', ?5, ?6, ?7, ?8)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         post_count = excluded.post_count,
         updated_at = excluded.updated_at`
    )
    .bind(id, slug, title || slug, content, postCount, pubDate, createdAt, now)
    .run();

  // EmDash コアテーブル (ec_posts & revisions) にも同期
  const revId = `rev_${slug}_${Date.now()}`;
  const portableText = JSON.stringify([
    {
      _type: "block",
      style: "normal",
      children: [{ _type: "span", text: `${title || slug} (${postCount} posts)` }]
    }
  ]);
  const revData = JSON.stringify({
    title: title || slug,
    content: JSON.parse(portableText),
    html_body: content
  });

  await db
    .prepare(
      `INSERT INTO revisions (id, collection_slug, entry_id, version, status, data, created_at)
       VALUES (?1, 'posts', ?2, 1, 'published', ?3, ?4)`
    )
    .bind(revId, id, revData, now)
    .run();

  await db
    .prepare(
      `INSERT INTO ec_posts (id, slug, status, title, content, html_body, created_at, updated_at, published_at, live_revision_id)
       VALUES (?1, ?2, 'published', ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         html_body = excluded.html_body,
         updated_at = excluded.updated_at,
         live_revision_id = excluded.live_revision_id`
    )
    .bind(id, slug, title || slug, portableText, content, createdAt, now, pubDate, revId)
    .run();

  return {
    id,
    slug,
    title: title || slug,
    postCount,
    action: existing ? "updated" : "created",
    link: `/posts/${slug}`
  };
}

/**
 * R2 からのメディア配信（iOS/Safari の動画再生に必須の Range リクエスト 206 Partial Content 対応）
 */
async function handleMediaRequest(request, env, key) {
  if (!env.MEDIA) {
    return new Response("R2 MEDIA binding is not configured", { status: 500 });
  }

  const cleanKey = decodeURIComponent(key).replace(/^\/+/, "");
  const rangeHeader = request.headers.get("Range");

  let object;
  if (rangeHeader && request.method === "GET") {
    object = await env.MEDIA.get(cleanKey, { range: request.headers });
  } else {
    object = await env.MEDIA.get(cleanKey);
  }

  if (!object) {
    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  }

  const headers = new Headers(CORS_HEADERS);
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  if (!headers.get("Content-Type")) {
    if (cleanKey.endsWith(".mp4")) headers.set("Content-Type", "video/mp4");
    else if (cleanKey.endsWith(".png")) headers.set("Content-Type", "image/png");
    else if (cleanKey.endsWith(".gif")) headers.set("Content-Type", "image/gif");
    else if (cleanKey.endsWith(".webp")) headers.set("Content-Type", "image/webp");
    else headers.set("Content-Type", "image/jpeg");
  }

  if (rangeHeader && object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size;
    const end = offset + length - 1;
    headers.set("Content-Range", `bytes ${offset}-${end}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

/**
 * API 認証チェック（TRIGGER_SECRET または ADMIN_PASSWORD が設定されている場合のみ検証）
 */
function checkApiAuth(request, env) {
  const secret = (env.TRIGGER_SECRET || env.ADMIN_PASSWORD || "").trim();
  if (!secret) return true;

  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader === `Bearer ${secret}`) return true;

  const url = new URL(request.url);
  if (url.searchParams.get("key") === secret) return true;

  return false;
}

/**
 * 共通ページレイアウト（xlog.showya-kiss.com 風のクリーンな2カラム日別ログデザイン）
 */
function renderLayoutHtml({
  siteTitle,
  siteSubtitle,
  pageTitle,
  mainHtml,
  months = [],
  recentPosts = [],
  totalDays = 0,
  totalTweets = 0,
  searchQuery = ""
}) {
  const fullTitle = pageTitle ? `${pageTitle} - ${siteTitle}` : siteTitle;

  const monthsListHtml =
    months.length > 0
      ? months
          .map(
            (m) =>
              `<li><a href="/archive/${escapeHtml(m.ym)}">${escapeHtml(m.ym)} <span>(${m.count}日 / ${m.tweets || 0}件)</span></a></li>`
          )
          .join("\n")
      : `<li class="muted">まだ記録がありません</li>`;

  const recentListHtml =
    recentPosts.length > 0
      ? recentPosts
          .map(
            (p) =>
              `<li><a href="/posts/${escapeHtml(p.slug)}">${escapeHtml(p.title)} <span>(${p.post_count || 1}件)</span></a></li>`
          )
          .join("\n")
      : `<li class="muted">まだ記事がありません</li>`;

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(fullTitle)}</title>
  <link rel="alternate" type="application/rss+xml" title="${escapeHtml(siteTitle)} RSS" href="/feed.xml" />
  <style>
    :root {
      --bg: #f5f8fa;
      --card-bg: #ffffff;
      --border: #e1e8ed;
      --text: #14171a;
      --muted: #657786;
      --accent: #1da1f2;
      --accent-hover: #0d8bd9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans JP", sans-serif;
      line-height: 1.6;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    /* ヘッダー */
    .site-header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 20px 16px;
      margin-bottom: 24px;
    }
    .site-header-inner {
      max-width: 1080px;
      margin: 0 auto;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .site-brand h1 {
      margin: 0;
      font-size: 1.6rem;
      letter-spacing: -0.02em;
    }
    .site-brand h1 a {
      color: var(--text);
      text-decoration: none;
    }
    .site-brand p {
      margin: 4px 0 0 0;
      font-size: 0.88rem;
      color: var(--muted);
    }
    .header-search {
      display: flex;
      gap: 6px;
    }
    .header-search input {
      padding: 7px 12px;
      border: 1px solid var(--border);
      border-radius: 20px;
      font-size: 0.9rem;
      width: 220px;
      outline: none;
    }
    .header-search input:focus {
      border-color: var(--accent);
    }
    .header-search button {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 20px;
      padding: 7px 14px;
      font-size: 0.88rem;
      font-weight: 600;
      cursor: pointer;
    }
    .header-search button:hover {
      background: var(--accent-hover);
    }

    /* レイアウト */
    .container {
      max-width: 1080px;
      margin: 0 auto;
      padding: 0 16px 48px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 290px;
      gap: 24px;
      align-items: start;
    }
    @media (max-width: 820px) {
      .container {
        grid-template-columns: 1fr;
      }
    }

    /* 日別記事カード */
    .day-article {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px 24px;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.02);
    }
    .day-article-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      border-bottom: 2px solid #f0f3f5;
      padding-bottom: 12px;
      margin-bottom: 18px;
    }
    .day-article-title {
      margin: 0;
      font-size: 1.4rem;
    }
    .day-article-title a {
      color: var(--text);
      text-decoration: none;
    }
    .day-article-title a:hover {
      color: var(--accent);
    }
    .day-badge {
      font-size: 0.82rem;
      color: var(--muted);
      background: #f0f4f8;
      padding: 3px 10px;
      border-radius: 999px;
      font-weight: 600;
    }

    /* X-Log ポストスタイル (xlog.showya-kiss.com 互換) */
    .x-log-day-container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .x-log-post { border: 1px solid #e1e8ed; border-radius: 8px; padding: 12px; margin-bottom: 16px; background: #fff; }
    .x-log-header { font-size: 0.85em; color: #657786; margin-bottom: 6px; }
    .x-log-header a { color: #1da1f2; text-decoration: none; font-weight: 600; }
    .x-log-body { font-size: 1.0em; line-height: 1.55; color: #14171a; word-break: break-word; }
    .x-log-body p { margin: 0 0 1em 0; }
    .x-log-body p:last-child { margin-bottom: 0; }
    .x-log-media { margin-top: 10px; }
    .x-log-media img, .x-log-media video { max-width: 100%; height: auto; max-height: 520px; border-radius: 6px; margin-top: 6px; display: block; }
    .x-log-quoted { border: 1px solid #ccd6dd; border-radius: 6px; margin: 10px 1.2em; padding: 10px 1.2em; background: #f5f8fa; }
    .x-log-quoted-header { font-weight: bold; font-size: 0.85em; color: #555; margin-bottom: 4px; }

    /* ページネーション */
    .pagination {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 20px;
      gap: 12px;
    }
    .page-btn {
      display: inline-block;
      background: var(--card-bg);
      border: 1px solid var(--border);
      padding: 8px 16px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.9rem;
      color: var(--text);
    }
    .page-btn:hover {
      border-color: var(--accent);
      color: var(--accent);
      text-decoration: none;
    }

    /* サイドバー */
    .sidebar-widget {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
      margin-bottom: 20px;
    }
    .sidebar-widget h3 {
      margin: 0 0 12px 0;
      font-size: 1rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .sidebar-list {
      list-style: none;
      margin: 0;
      padding: 0;
      font-size: 0.92rem;
    }
    .sidebar-list li {
      padding: 5px 0;
      border-bottom: 1px dashed #f0f3f5;
    }
    .sidebar-list li:last-child { border-bottom: none; }
    .sidebar-list li a {
      display: flex;
      justify-content: space-between;
      color: var(--text);
    }
    .sidebar-list li a:hover { color: var(--accent); text-decoration: none; }
    .sidebar-list li span { color: var(--muted); font-size: 0.84rem; }
    .stats-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      text-align: center;
    }
    .stat-box {
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
    }
    .stat-num { font-size: 1.3rem; font-weight: 700; color: var(--accent); }
    .stat-label { font-size: 0.78rem; color: var(--muted); }
    .empty-state {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 40px 24px;
      text-align: center;
      color: var(--muted);
    }
    .site-footer {
      text-align: center;
      padding: 24px 16px;
      color: var(--muted);
      font-size: 0.85rem;
      border-top: 1px solid var(--border);
      background: var(--card-bg);
    }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="site-header-inner">
      <div class="site-brand">
        <h1><a href="/">${escapeHtml(siteTitle)}</a></h1>
        <p>${escapeHtml(siteSubtitle)}</p>
      </div>
      <form class="header-search" action="/" method="GET">
        <input type="text" name="q" value="${escapeHtml(searchQuery)}" placeholder="ログを検索..." />
        <button type="submit">検索</button>
      </form>
    </div>
  </header>

  <div class="container">
    <main>
      ${mainHtml}
    </main>
    <aside>
      <div class="sidebar-widget">
        <h3>📊 アーカイブ統計</h3>
        <div class="stats-grid">
          <div class="stat-box">
            <div class="stat-num">${totalDays}</div>
            <div class="stat-label">記録日数</div>
          </div>
          <div class="stat-box">
            <div class="stat-num">${totalTweets}</div>
            <div class="stat-label">総ポスト数</div>
          </div>
        </div>
      </div>

      <div class="sidebar-widget">
        <h3>📅 月別アーカイブ</h3>
        <ul class="sidebar-list">
          ${monthsListHtml}
        </ul>
      </div>

      <div class="sidebar-widget">
        <h3>🕒 最近の日別ログ</h3>
        <ul class="sidebar-list">
          ${recentListHtml}
        </ul>
      </div>
    </aside>
  </div>

  <footer class="site-footer">
    Powered by <strong>EmDash (Cloudflare Workers + D1 + R2)</strong> &amp; <strong>X-Logger</strong>
    | <a href="/feed.xml">RSS</a>
    | <a href="/_emdash/admin">EmDash管理画面</a>
  </footer>
</body>
</html>`;
}

/**
 * サイドバー用の集計データ（月別アーカイブ・最近の記事・総件数）を取得
 */
async function getSidebarData(db) {
  const statsRow = await db
    .prepare(
      `SELECT COUNT(*) as total_days, COALESCE(SUM(post_count), 0) as total_tweets
       FROM x_log_posts WHERE status = 'published'`
    )
    .first();

  const { results: months } = await db
    .prepare(
      `SELECT substr(slug, 1, 7) as ym, COUNT(*) as count, SUM(post_count) as tweets
       FROM x_log_posts
       WHERE status = 'published'
       GROUP BY substr(slug, 1, 7)
       ORDER BY ym DESC
       LIMIT 36`
    )
    .all();

  const { results: recentPosts } = await db
    .prepare(
      `SELECT slug, title, post_count
       FROM x_log_posts
       WHERE status = 'published'
       ORDER BY slug DESC
       LIMIT 10`
    )
    .all();

  return {
    totalDays: statsRow?.total_days || 0,
    totalTweets: statsRow?.total_tweets || 0,
    months: months || [],
    recentPosts: recentPosts || []
  };
}

/**
 * EmDash 管理画面 (/_emdash/admin または /admin)
 */
async function handleAdminPage(request, env) {
  const { title: siteTitle, subtitle: siteSubtitle } = await getSiteSettings(env);
  const { results: posts } = await env.DB.prepare(
    `SELECT slug, title, post_count, updated_at FROM x_log_posts ORDER BY slug DESC LIMIT 100`
  ).all();

  const rowsHtml =
    (posts || [])
      .map(
        (p) => `
      <tr>
        <td><a href="/posts/${escapeHtml(p.slug)}" target="_blank"><strong>${escapeHtml(p.slug)}</strong></a></td>
        <td>${p.post_count || 1} 件</td>
        <td>${escapeHtml(p.updated_at?.slice(0, 19).replace("T", " ") || "")}</td>
        <td>
          <button class="btn-del" onclick="deletePost('${escapeHtml(p.slug)}')">削除</button>
        </td>
      </tr>`
      )
      .join("") || `<tr><td colspan="4" style="text-align:center;color:#657786;">まだ記事がありません</td></tr>`;

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EmDash 管理画面 - ${escapeHtml(siteTitle)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f8fa; color: #14171a; margin: 0; padding: 24px; }
    .wrap { max-width: 900px; margin: 0 auto; }
    .card { background: #fff; border: 1px solid #e1e8ed; border-radius: 10px; padding: 20px 24px; margin-bottom: 20px; }
    h1, h2 { margin-top: 0; }
    label { display: block; font-weight: 600; margin-bottom: 4px; font-size: 0.9rem; }
    input[type="text"], input[type="password"] { width: 100%; padding: 8px 12px; border: 1px solid #ccd6dd; border-radius: 6px; margin-bottom: 12px; font-size: 0.95rem; box-sizing: border-box; }
    button { background: #1da1f2; color: #fff; border: none; border-radius: 6px; padding: 9px 16px; font-weight: 600; cursor: pointer; }
    button.btn-del { background: #e0245e; padding: 5px 10px; font-size: 0.82rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e1e8ed; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top-bar">
      <h1>⚡ EmDash CMS 管理画面</h1>
      <a href="/">← サイトを表示</a>
    </div>

    <div class="card">
      <h2>⚙️ サイト基本設定</h2>
      <label>認証キー (TRIGGER_SECRET を設定している場合のみ入力)</label>
      <input type="password" id="apiKey" placeholder="未設定なら空欄のままでOK" />
      <label>サイトタイトル</label>
      <input type="text" id="siteTitle" value="${escapeHtml(siteTitle)}" />
      <label>サブタイトル（説明文）</label>
      <input type="text" id="siteSubtitle" value="${escapeHtml(siteSubtitle)}" />
      <button onclick="saveSettings()">設定を保存</button>
      <span id="saveMsg" style="margin-left:10px;font-size:0.9rem;color:#17bf63;"></span>
    </div>

    <div class="card">
      <h2>📝 日別ログ記事一覧 (最新100日分)</h2>
      <table>
        <thead>
          <tr><th>日付 (Slug)</th><th>ポスト数</th><th>最終更新 (UTC)</th><th>操作</th></tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  </div>

  <script>
    function getHeaders() {
      const headers = { "Content-Type": "application/json" };
      const key = document.getElementById("apiKey").value.trim();
      if (key) headers["Authorization"] = "Bearer " + key;
      return headers;
    }
    async function saveSettings() {
      const title = document.getElementById("siteTitle").value.trim();
      const subtitle = document.getElementById("siteSubtitle").value.trim();
      const res = await fetch("/_emdash/api/settings", {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({ site_title: title, site_subtitle: subtitle })
      });
      const data = await res.json();
      document.getElementById("saveMsg").textContent = data.ok ? "✔ 保存しました！" : ("エラー: " + data.error);
    }
    async function deletePost(slug) {
      if (!confirm(slug + " の記事を削除しますか？")) return;
      const res = await fetch("/_emdash/api/posts?slug=" + encodeURIComponent(slug), {
        method: "DELETE",
        headers: getHeaders()
      });
      const data = await res.json();
      if (data.ok) location.reload();
      else alert("エラー: " + data.error);
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. R2 メディア配信 (/media/:key または /_emdash/api/media/file/:key)
    if (pathname.startsWith("/media/")) {
      const key = pathname.slice("/media/".length);
      return handleMediaRequest(request, env, key);
    }
    if (pathname.startsWith("/_emdash/api/media/file/")) {
      const key = pathname.slice("/_emdash/api/media/file/".length);
      return handleMediaRequest(request, env, key);
    }

    if (!env.DB) {
      return new Response(
        "D1 Database (DB) binding is not configured. Please run the '1. Setup EmDash & R2/D1' GitHub Action.",
        { status: 500 }
      );
    }

    await ensureSchema(env.DB);

    // 2. EmDash / X-Log REST API: メディアアップロード (POST /_emdash/api/media または POST /api/media)
    if ((pathname === "/_emdash/api/media" || pathname === "/api/media") && request.method === "POST") {
      if (!checkApiAuth(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
      if (!env.MEDIA) {
        return new Response(JSON.stringify({ ok: false, error: "R2 MEDIA binding missing" }), {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }

      const contentType = request.headers.get("Content-Type") || "image/jpeg";
      const rawFilename = request.headers.get("X-Filename") || `media-${Date.now()}.jpg`;
      const safeKey = rawFilename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const arrayBuffer = await request.arrayBuffer();

      await env.MEDIA.put(safeKey, arrayBuffer, {
        httpMetadata: { contentType }
      });

      await env.DB.prepare(
        `INSERT OR REPLACE INTO x_log_media (key, filename, content_type, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
        .bind(safeKey, rawFilename, contentType, arrayBuffer.byteLength, new Date().toISOString())
        .run();

      const publicUrl = `/media/${safeKey}`;
      return new Response(
        JSON.stringify({
          ok: true,
          key: safeKey,
          url: publicUrl,
          source_url: `${url.origin}${publicUrl}`
        }),
        {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // 3. EmDash / X-Log REST API: 記事取得・保存・削除 (/_emdash/api/posts または /api/posts)
    if (pathname === "/_emdash/api/posts" || pathname === "/api/posts") {
      if (request.method === "GET") {
        const slug = url.searchParams.get("slug");
        if (slug) {
          const row = await env.DB.prepare(
            `SELECT id, slug, title, content, status, post_count, published_at, updated_at
             FROM x_log_posts WHERE slug = ?1`
          )
            .bind(slug)
            .first();
          return new Response(JSON.stringify({ ok: true, post: row || null }), {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }
        const { results } = await env.DB.prepare(
          `SELECT id, slug, title, post_count, published_at, updated_at
           FROM x_log_posts ORDER BY slug DESC LIMIT 50`
        ).all();
        return new Response(JSON.stringify({ ok: true, posts: results || [] }), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }

      if (!checkApiAuth(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }

      if (request.method === "POST" || request.method === "PUT") {
        const body = await request.json();
        const slug = String(body.slug || body.title || "").trim();
        if (!slug) {
          return new Response(JSON.stringify({ ok: false, error: "slug is required" }), {
            status: 400,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }
        const saved = await upsertDayPostInD1(env.DB, {
          slug,
          title: body.title || slug,
          content: body.content || "",
          publishedAt: body.date || body.publishedAt
        });
        return new Response(
          JSON.stringify({
            ok: true,
            ...saved,
            link: `${url.origin}/posts/${slug}`
          }),
          {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          }
        );
      }

      if (request.method === "DELETE") {
        const slug = url.searchParams.get("slug");
        if (slug) {
          await env.DB.prepare(`DELETE FROM x_log_posts WHERE slug = ?1`).bind(slug).run();
          await env.DB.prepare(`DELETE FROM ec_posts WHERE slug = ?1`).bind(slug).run();
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
    }

    // 4. サイト設定保存 API (POST /_emdash/api/settings)
    if (pathname === "/_emdash/api/settings" && request.method === "POST") {
      if (!checkApiAuth(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
      const body = await request.json();
      const now = new Date().toISOString();
      if (typeof body.site_title === "string") {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO x_log_settings (key, value, updated_at) VALUES ('site_title', ?1, ?2)`
        )
          .bind(body.site_title, now)
          .run();
      }
      if (typeof body.site_subtitle === "string") {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO x_log_settings (key, value, updated_at) VALUES ('site_subtitle', ?1, ?2)`
        )
          .bind(body.site_subtitle, now)
          .run();
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    // 5. 管理画面 (/_emdash/admin または /admin)
    if (pathname === "/_emdash/admin" || pathname === "/admin") {
      return handleAdminPage(request, env);
    }

    // 6. RSS フィード (/feed.xml または /rss.xml)
    if (pathname === "/feed.xml" || pathname === "/rss.xml") {
      const { title: siteTitle, subtitle: siteSubtitle } = await getSiteSettings(env);
      const { results: posts } = await env.DB.prepare(
        `SELECT slug, title, content, published_at FROM x_log_posts WHERE status = 'published' ORDER BY slug DESC LIMIT 20`
      ).all();

      const itemsXml = (posts || [])
        .map(
          (p) => `    <item>
      <title>${escapeHtml(p.title)}</title>
      <link>${url.origin}/posts/${escapeHtml(p.slug)}</link>
      <guid>${url.origin}/posts/${escapeHtml(p.slug)}</guid>
      <pubDate>${new Date(p.published_at || `${p.slug}T00:00:00Z`).toUTCString()}</pubDate>
      <description><![CDATA[${p.content}]]></description>
    </item>`
        )
        .join("\n");

      const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${escapeHtml(siteTitle)}</title>
    <link>${url.origin}/</link>
    <description>${escapeHtml(siteSubtitle)}</description>
${itemsXml}
  </channel>
</rss>`;

      return new Response(rssXml, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml; charset=utf-8" }
      });
    }

    const { title: siteTitle, subtitle: siteSubtitle } = await getSiteSettings(env);
    const sidebar = await getSidebarData(env.DB);

    // 7. 個別日ページ (/posts/YYYY-MM-DD または /YYYY-MM-DD)
    const singleMatch =
      pathname.match(/^\/posts\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/?$/) ||
      pathname.match(/^\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/?$/);
    if (singleMatch) {
      const slug = singleMatch[1];
      const post = await env.DB.prepare(
        `SELECT slug, title, content, post_count, updated_at FROM x_log_posts WHERE slug = ?1`
      )
        .bind(slug)
        .first();

      if (!post) {
        const notFoundHtml = renderLayoutHtml({
          siteTitle,
          siteSubtitle,
          pageTitle: "記事が見つかりません",
          mainHtml: `<div class="empty-state"><h2>404 Not Found</h2><p>${escapeHtml(slug)} のログはまだ記録されていません。</p><p><a href="/">← トップページへ戻る</a></p></div>`,
          ...sidebar
        });
        return new Response(notFoundHtml, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      const prevPost = await env.DB.prepare(
        `SELECT slug, title FROM x_log_posts WHERE slug < ?1 AND status = 'published' ORDER BY slug DESC LIMIT 1`
      )
        .bind(slug)
        .first();
      const nextPost = await env.DB.prepare(
        `SELECT slug, title FROM x_log_posts WHERE slug > ?1 AND status = 'published' ORDER BY slug ASC LIMIT 1`
      )
        .bind(slug)
        .first();

      const navHtml = `<div class="pagination">
        <div>${prevPost ? `<a class="page-btn" href="/posts/${escapeHtml(prevPost.slug)}">← ${escapeHtml(prevPost.title)}</a>` : ""}</div>
        <div><a class="page-btn" href="/">一覧へ戻る</a></div>
        <div>${nextPost ? `<a class="page-btn" href="/posts/${escapeHtml(nextPost.slug)}">${escapeHtml(nextPost.title)} →</a>` : ""}</div>
      </div>`;

      const mainHtml = `
        <article class="day-article">
          <div class="day-article-header">
            <h2 class="day-article-title"><a href="/posts/${escapeHtml(post.slug)}">${escapeHtml(post.title)}</a></h2>
            <span class="day-badge">${post.post_count || 1} ポスト</span>
          </div>
          ${post.content}
        </article>
        ${navHtml}
      `;

      const html = renderLayoutHtml({
        siteTitle,
        siteSubtitle,
        pageTitle: post.title,
        mainHtml,
        ...sidebar
      });
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 8. 月別アーカイブページ (/archive/YYYY-MM)
    const archiveMatch = pathname.match(/^\/archive\/([0-9]{4}-[0-9]{2})\/?$/);
    if (archiveMatch) {
      const ym = archiveMatch[1];
      const { results: posts } = await env.DB.prepare(
        `SELECT slug, title, content, post_count FROM x_log_posts
         WHERE slug LIKE ?1 AND status = 'published'
         ORDER BY slug DESC`
      )
        .bind(`${ym}-%`)
        .all();

      const articlesHtml =
        (posts || []).length > 0
          ? posts
              .map(
                (p) => `
          <article class="day-article">
            <div class="day-article-header">
              <h2 class="day-article-title"><a href="/posts/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></h2>
              <span class="day-badge">${p.post_count || 1} ポスト</span>
            </div>
            ${p.content}
          </article>`
              )
              .join("\n")
          : `<div class="empty-state"><p>${escapeHtml(ym)} のログはありません。</p></div>`;

      const html = renderLayoutHtml({
        siteTitle,
        siteSubtitle,
        pageTitle: `${ym} のログ一覧`,
        mainHtml: `<h2 style="margin-top:0;">📅 ${escapeHtml(ym)} のアーカイブ</h2>${articlesHtml}`,
        ...sidebar
      });
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 9. トップページ（一覧 & キーワード検索 & ページネーション）
    const searchQuery = (url.searchParams.get("q") || "").trim();
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
    const perPage = Math.max(1, parseInt(env.POSTS_PER_PAGE || "7", 10) || 7);
    const offset = (page - 1) * perPage;

    let posts = [];
    let hasNextPage = false;

    if (searchQuery) {
      const { results } = await env.DB.prepare(
        `SELECT slug, title, content, post_count FROM x_log_posts
         WHERE status = 'published' AND (content LIKE ?1 OR title LIKE ?1)
         ORDER BY slug DESC
         LIMIT ?2 OFFSET ?3`
      )
        .bind(`%${searchQuery}%`, perPage + 1, offset)
        .all();
      posts = (results || []).slice(0, perPage);
      hasNextPage = (results || []).length > perPage;
    } else {
      const { results } = await env.DB.prepare(
        `SELECT slug, title, content, post_count FROM x_log_posts
         WHERE status = 'published'
         ORDER BY slug DESC
         LIMIT ?1 OFFSET ?2`
      )
        .bind(perPage + 1, offset)
        .all();
      posts = (results || []).slice(0, perPage);
      hasNextPage = (results || []).length > perPage;
    }

    const searchBanner = searchQuery
      ? `<h2 style="margin-top:0;">🔍 「${escapeHtml(searchQuery)}」の検索結果</h2>`
      : "";

    const articlesHtml =
      posts.length > 0
        ? posts
            .map(
              (p) => `
        <article class="day-article">
          <div class="day-article-header">
            <h2 class="day-article-title"><a href="/posts/${escapeHtml(p.slug)}">${escapeHtml(p.title)}</a></h2>
            <span class="day-badge">${p.post_count || 1} ポスト</span>
          </div>
          ${p.content}
        </article>`
            )
            .join("\n")
        : `<div class="empty-state">
            <h2>まだXのログがありません</h2>
            <p>X-Logger の自動同期が動くと、ここに日別（YYYY-MM-DD）のポスト一覧が自動的に表示されます。</p>
          </div>`;

    const qParam = searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : "";
    const paginationHtml =
      page > 1 || hasNextPage
        ? `<div class="pagination">
            <div>${page > 1 ? `<a class="page-btn" href="/?page=${page - 1}${qParam}">← 新しい日へ</a>` : ""}</div>
            <div>Page ${page}</div>
            <div>${hasNextPage ? `<a class="page-btn" href="/?page=${page + 1}${qParam}">過去の日へ →</a>` : ""}</div>
          </div>`
        : "";

    const html = renderLayoutHtml({
      siteTitle,
      siteSubtitle,
      pageTitle: searchQuery ? `「${searchQuery}」の検索結果` : "",
      mainHtml: `${searchBanner}${articlesHtml}${paginationHtml}`,
      searchQuery,
      ...sidebar
    });

    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};

