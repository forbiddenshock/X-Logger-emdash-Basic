/**
 * x-logger (EmDash Edition) - Cloudflare Worker
 *
 * 1. Cloudflare Cron Triggers で定期実行（最短1分おき）
 * 2. X API v2 からユーザーの最新ポスト（通常・リプライ・引用・RT）を取得
 * 3. ポスト内の画像・動画をダウンロードして Cloudflare R2 ストレージへ永続保存（リンク死対策）
 * 4. 日付別（YYYY-MM-DD）の1記事にまとめて EmDash (Cloudflare D1) に随時上書き保存（xlog.showya-kiss.com 互換整形）
 * 5. (オプション) GitHub リポジトリへ Markdown ファイル（YearYYYY.md / MonthYYYYMM.md / Fulldata.md 選択式、画像・動画なし）として保存
 */

const X_LOG_STYLE = `<style>
    .x-log-day-container { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .x-log-post { border: 1px solid #e1e8ed; border-radius: 8px; padding: 12px; margin-bottom: 16px; background: #fff; }
    .x-log-header { font-size: 0.85em; color: #657786; margin-bottom: 6px; }
    .x-log-header a { color: #1da1f2; text-decoration: none; }
    .x-log-body { font-size: 1.0em; line-height: 1.5; color: #14171a; word-break: break-word; }
    .x-log-body p { margin: 0 0 1em 0; }
    .x-log-body p:last-child { margin-bottom: 0; }
    .x-log-media { margin-top: 10px; }
    .x-log-media img, .x-log-media video { max-width: 100%; height: auto; border-radius: 6px; margin-top: 4px; display: block; }
    .x-log-quoted { border: 1px solid #ccd6dd; border-radius: 6px; margin: 10px 2em; padding: 10px 2em; background: #f5f8fa; }
    .x-log-quoted-header { font-weight: bold; font-size: 0.85em; color: #555; margin-bottom: 4px; }
  </style>`;

// ============================================================================
// ユーティリティ関数（エスケープ・日時変換・OAuth 1.0a 署名）
// ============================================================================

export function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * ツイート本文の改行を整形：
 * - 二重改行（空行）は段落 <p style="margin: 0 0 1em 0;">...</p> として1行分の空白を確実に維持
 * - 単一改行は <br /> に変換
 */
export function formatTweetBodyHtml(text) {
  const normalized = String(text || "")
    .trim()
    .replace(/\r\n|\r/g, "\n");
  if (!normalized) return "";

  const paragraphs = normalized.split(/\n{2,}/);
  if (paragraphs.length === 1) {
    return escapeHtml(paragraphs[0]).replace(/\n/g, "<br />\n");
  }

  return paragraphs
    .map((para, idx) => {
      const inner = escapeHtml(para).replace(/\n/g, "<br />\n");
      const margin = idx < paragraphs.length - 1 ? "0 0 1em 0" : "0";
      return `<p style="margin: ${margin};">${inner}</p>`;
    })
    .join("\n");
}

/**
 * ISO日時文字列を指定タイムゾーン（デフォルト Asia/Tokyo）の YYYY-MM-DD と HH:MM に変換
 */
export function formatInTimezone(isoDateStr, timeZone = "Asia/Tokyo") {
  const date = new Date(isoDateStr);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const map = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }
  const hour = map.hour === "24" ? "00" : map.hour;
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const timeStr = `${hour}:${map.minute}`;
  return {
    dateStr,
    timeStr,
    yearStr: map.year,
    yearMonthStr: `${map.year}${map.month}`
  };
}

/**
 * RFC 3986 パーセントエンコード（OAuth 1.0a 用）
 */
function rfc3986Encode(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * Web Crypto API を用いた OAuth 1.0a Authorization ヘッダー生成
 */
async function buildOAuth1Header(method, urlObj, credentials) {
  const oauthParams = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0"
  };

  const allParams = [];
  for (const [k, v] of urlObj.searchParams.entries()) {
    allParams.push([rfc3986Encode(k), rfc3986Encode(v)]);
  }
  for (const [k, v] of Object.entries(oauthParams)) {
    allParams.push([rfc3986Encode(k), rfc3986Encode(v)]);
  }

  allParams.sort((a, b) => {
    if (a[0] === b[0]) return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
    return a[0] < b[0] ? -1 : 1;
  });

  const normalizedParams = allParams.map(([k, v]) => `${k}=${v}`).join("&");
  const baseUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  const signatureBaseString = [
    method.toUpperCase(),
    rfc3986Encode(baseUrl),
    rfc3986Encode(normalizedParams)
  ].join("&");

  const signingKey = `${rfc3986Encode(credentials.apiSecret)}&${rfc3986Encode(credentials.accessSecret)}`;
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(signingKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(signatureBaseString));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)));

  oauthParams.oauth_signature = signature;
  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${rfc3986Encode(k)}="${rfc3986Encode(oauthParams[k])}"`);

  return `OAuth ${headerParts.join(", ")}`;
}

// ============================================================================
// X API v2 クライアント & データ正規化
// ============================================================================

async function xApiFetch(urlStr, env) {
  const urlObj = new URL(urlStr);
  const headers = {
    Accept: "application/json",
    "User-Agent": "x-logger-cloudflare-worker/1.0"
  };

  if (env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET) {
    headers.Authorization = await buildOAuth1Header("GET", urlObj, {
      apiKey: env.X_API_KEY,
      apiSecret: env.X_API_SECRET,
      accessToken: env.X_ACCESS_TOKEN,
      accessSecret: env.X_ACCESS_SECRET
    });
  } else if (env.X_BEARER_TOKEN) {
    headers.Authorization = `Bearer ${env.X_BEARER_TOKEN}`;
  } else {
    throw new Error(
      "X API認証情報が設定されていません。X_BEARER_TOKEN または (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET) を設定してください。"
    );
  }

  const res = await fetch(urlObj.toString(), { method: "GET", headers });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`X API Error (${res.status}): ${errBody}`);
  }
  return res.json();
}

async function resolveXUser(env) {
  let userId = (env.X_USER_ID || "").trim();
  let username = (env.X_USERNAME || "").trim().replace(/^@/, "");

  if (userId && username) {
    return { userId, username };
  }

  if (username && !userId) {
    const data = await xApiFetch(
      `https://api.x.com/2/users/by/username/${encodeURIComponent(username)}`,
      env
    );
    if (!data?.data?.id) {
      throw new Error(`Xユーザー @${username} のIDを取得できませんでした。`);
    }
    return { userId: data.data.id, username: data.data.username || username };
  }

  if (userId && !username) {
    const data = await xApiFetch(`https://api.x.com/2/users/${encodeURIComponent(userId)}`, env);
    return { userId, username: data?.data?.username || "user" };
  }

  // OAuth 1.0a の場合は /2/users/me から自動解決可能
  const meData = await xApiFetch("https://api.x.com/2/users/me", env);
  if (!meData?.data?.id) {
    throw new Error("X_USERNAME または X_USER_ID を設定してください。");
  }
  return { userId: meData.data.id, username: meData.data.username };
}

/**
 * メディアオブジェクトからダウンロード用URLと種別を抽出
 */
function extractMediaDescriptor(mediaObj) {
  if (!mediaObj) return null;
  if (mediaObj.type === "photo" && (mediaObj.url || mediaObj.preview_image_url)) {
    return {
      mediaKey: mediaObj.media_key,
      type: "photo",
      url: mediaObj.url || mediaObj.preview_image_url,
      alt: mediaObj.alt_text || "Post Media"
    };
  }
  if (mediaObj.type === "video" || mediaObj.type === "animated_gif") {
    const variants = Array.isArray(mediaObj.variants) ? mediaObj.variants : [];
    const mp4Variants = variants
      .filter((v) => v && v.url && (v.content_type === "video/mp4" || v.url.includes(".mp4")))
      .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));

    if (mp4Variants.length > 0) {
      const allMp4Urls = mp4Variants.map((v) => v.url);
      return {
        mediaKey: mediaObj.media_key,
        type: "video",
        url: mp4Variants[0].url,
        fallbackUrls: allMp4Urls.slice(1),
        posterUrl: mediaObj.preview_image_url || mediaObj.url || "",
        alt: mediaObj.alt_text || "Post Video"
      };
    }
    if (mediaObj.preview_image_url || mediaObj.url) {
      return {
        mediaKey: mediaObj.media_key,
        type: "photo",
        url: mediaObj.preview_image_url || mediaObj.url,
        alt: mediaObj.alt_text || "Video Preview"
      };
    }
  }
  return null;
}

function collectTweetMediaDescriptors(tweetObj, mediaMap, defaultAlt = "Post Media") {
  const list = [];
  if (!tweetObj) return list;
  const keys = tweetObj.attachments?.media_keys || [];
  for (const key of keys) {
    const desc = extractMediaDescriptor(mediaMap.get(key));
    if (desc) {
      list.push({ ...desc, alt: desc.alt || defaultAlt });
    }
  }
  return list;
}

function mergeUniqueMediaLists(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || !item.url) continue;
      const key = item.mediaKey || item.url;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...item });
    }
  }
  return merged;
}

/**
 * X API v2 のレスポンスを正規化されたポスト配列に変換
 */
export function normalizeXApiResponse(apiData, ownerUsername, options = {}) {
  const timeZone = options.timeZone || "Asia/Tokyo";
  const includeReplies = options.includeReplies !== false;
  const includeQuotes = options.includeQuotes !== false;
  const includeRetweets = options.includeRetweets !== false;

  const rawTweets = Array.isArray(apiData?.data) ? apiData.data : [];
  const includes = apiData?.includes || {};

  const mediaMap = new Map();
  for (const m of includes.media || []) {
    mediaMap.set(m.media_key, m);
  }

  const userMap = new Map();
  for (const u of includes.users || []) {
    userMap.set(u.id, u);
  }

  const refTweetMap = new Map();
  for (const t of includes.tweets || []) {
    refTweetMap.set(t.id, t);
  }

  const normalized = [];

  for (const tweet of rawTweets) {
    const refs = Array.isArray(tweet.referenced_tweets) ? tweet.referenced_tweets : [];
    const isRetweet = refs.some((r) => r.type === "retweeted");
    const isQuote = refs.some((r) => r.type === "quoted");
    const isReply = refs.some((r) => r.type === "replied_to");

    if (isRetweet && !includeRetweets) continue;
    if (isReply && !isQuote && !isRetweet && !includeReplies) continue;
    if (isQuote && !includeQuotes) continue;

    const fullText = tweet.note_tweet?.text || tweet.text || "";
    const { dateStr, timeStr, yearStr, yearMonthStr } = formatInTimezone(
      tweet.created_at || new Date().toISOString(),
      timeZone
    );

    let mediaList = collectTweetMediaDescriptors(tweet, mediaMap, "Tweet Media");

    // 参照元ポスト（quoted / retweeted / replied_to）の構築
    let referencedPost = null;
    const primaryRef =
      refs.find((r) => r.type === "quoted") ||
      refs.find((r) => r.type === "retweeted") ||
      refs.find((r) => r.type === "replied_to");

    if (primaryRef) {
      const refTweet = refTweetMap.get(primaryRef.id);
      if (refTweet) {
        const refAuthor = userMap.get(refTweet.author_id);
        const refUsername = refAuthor?.username || "i";
        let refText = refTweet.note_tweet?.text || refTweet.text || "";
        let refMediaList = collectTweetMediaDescriptors(refTweet, mediaMap, "Quoted Media");

        // RT先がさらに引用ポスト（2階層目）を持っている場合、そのメディアとテキストも補完する
        const nestedRefs = Array.isArray(refTweet.referenced_tweets)
          ? refTweet.referenced_tweets
          : [];
        for (const nRef of nestedRefs) {
          const nestedTweet = refTweetMap.get(nRef.id);
          if (nestedTweet) {
            const nestedMedia = collectTweetMediaDescriptors(nestedTweet, mediaMap, "Quoted Media");
            refMediaList = mergeUniqueMediaLists(refMediaList, nestedMedia);
            if (nRef.type === "quoted") {
              const nestedAuthor = userMap.get(nestedTweet.author_id);
              const nestedUser = nestedAuthor?.username || "i";
              const nestedText = nestedTweet.note_tweet?.text || nestedTweet.text || "";
              if (nestedText && !refText.includes(nestedText)) {
                refText = `${refText}\n\n(引用 @${nestedUser}: ${nestedText})`;
              }
            }
          }
        }

        // RTの場合は、X API上メディアキーがtweet側またはrefTweet側の片方にしか無いケースや、
        // 本文側と引用ブロック側の両方に表示したいケースに対応するため両方にメディアを持たせる
        if (isRetweet) {
          const combinedRtMedia = mergeUniqueMediaLists(mediaList, refMediaList);
          mediaList = combinedRtMedia.map((m) => ({ ...m, alt: "Tweet Media" }));
          refMediaList = combinedRtMedia.map((m) => ({ ...m, alt: "Quoted Media" }));
        } else {
          refMediaList = refMediaList.map((m) => ({ ...m, alt: "Quoted Media" }));
        }

        referencedPost = {
          id: refTweet.id,
          type: primaryRef.type,
          username: refUsername,
          text: refText,
          media: refMediaList
        };
      } else if (isRetweet) {
        const rtMatch = fullText.match(/^RT @([A-Za-z0-9_]+):\s*([\s\S]*)$/);
        if (rtMatch) {
          referencedPost = {
            id: primaryRef.id,
            type: "retweeted",
            username: rtMatch[1],
            text: rtMatch[2],
            media: mediaList.map((m) => ({ ...m, alt: "Quoted Media" }))
          };
        }
      }
    }

    normalized.push({
      id: String(tweet.id),
      username: ownerUsername,
      createdAt: tweet.created_at,
      dateStr,
      timeStr,
      yearStr,
      yearMonthStr,
      text: fullText,
      media: mediaList,
      referencedPost
    });
  }

  return normalized;
}

// ============================================================================
// WordPress HTML 整形・既存記事パーサー（xlog.showya-kiss.com 準拠）
// ============================================================================

function renderMediaItemHtml(m, defaultAlt, indent) {
  const src = escapeHtml(m.wpUrl || m.url);
  const alt = escapeHtml(m.alt || defaultAlt);
  if (m.type === "video") {
    const posterUrl = m.wpPosterUrl || m.posterUrl || "";
    const posterAttr = posterUrl ? ` poster="${escapeHtml(posterUrl)}"` : "";
    return `${indent}<video controls playsinline preload="metadata" src="${src}"${posterAttr} style="max-width: 100%; height: auto; border-radius: 6px; margin-top: 4px;"><source src="${src}" type="video/mp4" /><a href="${src}" target="_blank" rel="noopener">動画を表示</a></video>`;
  }
  return `${indent}<a href="${src}" target="_blank" rel="noopener"><img decoding="async" src="${src}" alt="${alt}" loading="lazy" /></a>`;
}

/**
 * 1件のポストから <div class="x-log-post" id="x-post-..."> ブロックを生成
 */
export function renderSinglePostHtml(post) {
  const postUrl = `https://x.com/${encodeURIComponent(post.username)}/status/${encodeURIComponent(post.id)}`;
  const bodyHtml = formatTweetBodyHtml(post.text);

  let mediaHtml = "";
  if (Array.isArray(post.media) && post.media.length > 0) {
    const items = post.media
      .filter((m) => m.wpUrl || m.url)
      .map((m) => renderMediaItemHtml(m, "Post Media", "        "))
      .join("<br />\n");

    if (items) {
      mediaHtml = `\n    <div class="x-log-media">\n${items}\n    </div>`;
    }
  }

  let quotedHtml = "";
  if (post.referencedPost) {
    const ref = post.referencedPost;
    const refUrl = `https://x.com/${encodeURIComponent(ref.username)}/status/${encodeURIComponent(ref.id)}`;
    const refBodyHtml = formatTweetBodyHtml(ref.text);

    let refMediaHtml = "";
    if (Array.isArray(ref.media) && ref.media.length > 0) {
      const refItems = ref.media
        .filter((m) => m.wpUrl || m.url)
        .map((m) => renderMediaItemHtml(m, "Quoted Media", "        "))
        .join("<br />\n");

      if (refItems) {
        refMediaHtml = `\n      <div class="x-log-media">\n${refItems}\n      </div>`;
      }
    }

    quotedHtml = `\n    <div class="x-log-quoted">
      <div class="x-log-quoted-header">@${escapeHtml(ref.username)} のポスト (<a href="${refUrl}" target="_blank" rel="noopener">元ポスト</a>):</div>
      <div class="x-log-body" style="word-break: break-word;">${refBodyHtml}</div>${refMediaHtml}
    </div>`;
  }

  return `  <div class="x-log-post" id="x-post-${escapeHtml(post.id)}">
    <div class="x-log-header">
      <a href="${postUrl}" target="_blank" rel="noopener">${escapeHtml(post.timeStr)}</a>
    </div>
    <div class="x-log-body" style="word-break: break-word;">${bodyHtml}</div>${mediaHtml}${quotedHtml}
  </div>`;
}

/**
 * 既存のWordPress記事HTMLから <div class="x-log-post" id="x-post-{ID}">...</div> を抽出する
 * ネストした <div> (x-log-header, x-log-body, x-log-quoted, x-log-media) に対応
 */
export function extractExistingPostBlocks(html) {
  const blocks = new Map();
  const str = String(html || "");
  const startRegex = /<div\s+class=["']x-log-post["']\s+id=["']x-post-(\d+)["'][^>]*>/gi;

  let match;
  while ((match = startRegex.exec(str)) !== null) {
    const tweetId = match[1];
    const startIndex = match.index;
    let depth = 0;
    const tagRegex = /<\/?div\b[^>]*>/gi;
    tagRegex.lastIndex = startIndex;

    let tagMatch;
    let endIndex = -1;
    while ((tagMatch = tagRegex.exec(str)) !== null) {
      const tag = tagMatch[0].toLowerCase();
      if (tag.startsWith("</div")) {
        depth--;
        if (depth === 0) {
          endIndex = tagRegex.lastIndex;
          break;
        }
      } else {
        depth++;
      }
    }

    if (endIndex !== -1) {
      let blockHtml = str.slice(startIndex, endIndex).trim();
      // WordPress の wpautop が付与した余分な不整合 </p> をクリーンアップ
      blockHtml = blockHtml.replace(/<\/div>\s*<\/p>\s*<\/div>/g, "</div>\n  </div>");
      blocks.set(tweetId, `  ${blockHtml}`);
    }
  }

  return blocks;
}

/**
 * 1日分の記事全体のHTMLを組み立てる（Tweet ID降順＝新しい順でソート）
 */
export function buildDayContainerHtml(dateStr, postBlocksMap) {
  const sortedIds = Array.from(postBlocksMap.keys()).sort((a, b) => {
    try {
      const bigA = BigInt(a);
      const bigB = BigInt(b);
      return bigB > bigA ? 1 : bigB < bigA ? -1 : 0;
    } catch {
      return b.localeCompare(a);
    }
  });

  const joinedBlocks = sortedIds.map((id) => postBlocksMap.get(id)).join("\n");
  return `<div class="x-log-day-container" data-date="${escapeHtml(dateStr)}">\n  ${X_LOG_STYLE}\n${joinedBlocks}\n</div>`;
}

// ============================================================================
// EmDash (Cloudflare D1 + R2 直接バインディング / HTTP REST API) クライアント
// ============================================================================

let d1SchemaInitialized = false;

async function ensureEmDashD1Schema(db) {
  if (!db || d1SchemaInitialized) return;
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
  d1SchemaInitialized = true;
}

function normalizeEmDashBaseUrl(rawUrl) {
  let u = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) {
    u = `https://${u}`;
  }
  return u;
}

/**
 * 外部の画像・動画をダウンロードして Cloudflare R2 (env.MEDIA) または EmDash API に保存
 */
async function uploadMediaToEmDash(mediaUrl, filenamePrefix, env) {
  const mediaRes = await fetch(mediaUrl, {
    headers: { "User-Agent": "x-logger-cloudflare-worker/1.0" }
  });
  if (!mediaRes.ok) {
    throw new Error(`メディアのダウンロードに失敗しました (${mediaRes.status}): ${mediaUrl}`);
  }

  const rawContentType = (mediaRes.headers.get("content-type") || "").toLowerCase();
  let ext = "jpg";
  let uploadContentType = "image/jpeg";

  if (rawContentType.includes("mp4") || mediaUrl.toLowerCase().includes(".mp4")) {
    ext = "mp4";
    uploadContentType = "video/mp4";
  } else if (rawContentType.includes("png") || mediaUrl.toLowerCase().includes(".png")) {
    ext = "png";
    uploadContentType = "image/png";
  } else if (rawContentType.includes("gif") || mediaUrl.toLowerCase().includes(".gif")) {
    ext = "gif";
    uploadContentType = "image/gif";
  } else if (rawContentType.includes("webp") || mediaUrl.toLowerCase().includes(".webp")) {
    ext = "webp";
    uploadContentType = "image/webp";
  }

  const filename = `${filenamePrefix}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  const arrayBuffer = await mediaRes.arrayBuffer();
  const baseUrl = normalizeEmDashBaseUrl(env.EMDASH_URL || "");

  // 1. R2 バインディング (env.MEDIA) が存在する場合は直接 R2 バケットへ高速保存
  if (env.MEDIA) {
    await env.MEDIA.put(filename, arrayBuffer, {
      httpMetadata: { contentType: uploadContentType }
    });

    if (env.DB) {
      await ensureEmDashD1Schema(env.DB);
      await env.DB.prepare(
        `INSERT OR REPLACE INTO x_log_media (key, filename, content_type, size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`
      )
        .bind(filename, filename, uploadContentType, arrayBuffer.byteLength, new Date().toISOString())
        .run();
    }

    return baseUrl ? `${baseUrl}/media/${filename}` : `/media/${filename}`;
  }

  // 2. フォールバック: EMDASH_URL の HTTP API 経由でアップロード
  if (baseUrl) {
    const headers = {
      "Content-Type": uploadContentType,
      "X-Filename": filename
    };
    const secret = (env.EMDASH_API_KEY || env.TRIGGER_SECRET || "").trim();
    if (secret) {
      headers.Authorization = `Bearer ${secret}`;
    }

    const uploadRes = await fetch(`${baseUrl}/_emdash/api/media`, {
      method: "POST",
      headers,
      body: arrayBuffer
    });
    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      throw new Error(`EmDash メディアアップロード失敗 (${uploadRes.status}): ${errText}`);
    }
    const mediaJson = await uploadRes.json();
    return mediaJson.url || mediaJson.source_url || `/media/${filename}`;
  }

  throw new Error(
    "R2 バインディング (MEDIA) が設定されていません。GitHub Actions のデプロイを実行してください。"
  );
}

/**
 * 1件のメディアアイテム（画像・動画＋サムネイル）を R2 へ保存（同一URLの重複アップロードをキャッシュで防止）
 */
async function resolveMediaItemForEmDash(mediaItem, prefix, uploadCache, env) {
  let uploadedCount = 0;

  // 動画の場合はサムネイル画像（posterUrl）も先に R2 に保存しておく
  if (mediaItem.type === "video" && mediaItem.posterUrl) {
    if (uploadCache.has(mediaItem.posterUrl)) {
      mediaItem.wpPosterUrl = uploadCache.get(mediaItem.posterUrl);
    } else {
      try {
        const uploadedPoster = await uploadMediaToEmDash(
          mediaItem.posterUrl,
          `${prefix}-poster`,
          env
        );
        uploadCache.set(mediaItem.posterUrl, uploadedPoster);
        mediaItem.wpPosterUrl = uploadedPoster;
        uploadedCount++;
      } catch (err) {
        console.error(`動画サムネイル保存失敗 (${prefix}):`, err.message);
        mediaItem.wpPosterUrl = mediaItem.posterUrl;
      }
    }
  }

  if (uploadCache.has(mediaItem.url)) {
    mediaItem.wpUrl = uploadCache.get(mediaItem.url);
    return uploadedCount;
  }

  // 動画の場合は高画質URLから試し、失敗時は低ビットレートのfallbackUrlsを順に試す
  const candidateUrls = [
    mediaItem.url,
    ...(Array.isArray(mediaItem.fallbackUrls) ? [...mediaItem.fallbackUrls].reverse() : [])
  ].filter(Boolean);

  let lastErr = null;
  for (const candidateUrl of candidateUrls) {
    try {
      const uploadedUrl = await uploadMediaToEmDash(candidateUrl, prefix, env);
      uploadCache.set(mediaItem.url, uploadedUrl);
      mediaItem.wpUrl = uploadedUrl;
      uploadedCount++;
      return uploadedCount;
    } catch (err) {
      lastErr = err;
      console.error(`メディア保存試行失敗 (${prefix} -> ${candidateUrl}):`, err.message);
    }
  }

  if (lastErr) {
    console.error(`メディア保存最終フォールバック (${prefix}):`, lastErr.message);
  }
  mediaItem.wpUrl = mediaItem.url;
  return uploadedCount;
}

/**
 * 指定日付（YYYY-MM-DD）の既存記事を D1 または EmDash API から取得
 */
async function findEmDashPostByDateSlug(dateStr, env) {
  if (env.DB) {
    await ensureEmDashD1Schema(env.DB);
    const row = await env.DB.prepare(
      `SELECT id, slug, title, content, created_at FROM x_log_posts WHERE slug = ?1`
    )
      .bind(dateStr)
      .first();
    return row || null;
  }

  const baseUrl = normalizeEmDashBaseUrl(env.EMDASH_URL || "");
  if (baseUrl) {
    const res = await fetch(`${baseUrl}/_emdash/api/posts?slug=${encodeURIComponent(dateStr)}`);
    if (res.ok) {
      const data = await res.json();
      return data.post || null;
    }
  }
  return null;
}

/**
 * 既存の記録済みブロックにメディア欠落や二重改行欠落があるか判定（自動修復用）
 */
function shouldRepairExistingPostBlock(existingBlockHtml, post) {
  const html = String(existingBlockHtml || "");
  const hasPostMedia = Array.isArray(post.media) && post.media.length > 0;
  const hasRefMedia =
    post.referencedPost &&
    Array.isArray(post.referencedPost.media) &&
    post.referencedPost.media.length > 0;

  if ((hasPostMedia || hasRefMedia) && !html.includes("x-log-media")) {
    return true;
  }

  const hasVideo =
    (hasPostMedia && post.media.some((m) => m.type === "video")) ||
    (hasRefMedia && post.referencedPost.media.some((m) => m.type === "video"));
  if (hasVideo && !html.includes("<video")) {
    return true;
  }

  const hasDoubleNewline =
    /\r?\n\s*\r?\n/.test(String(post.text || "").trim()) ||
    /\r?\n\s*\r?\n/.test(String(post.referencedPost?.text || "").trim());
  if (hasDoubleNewline && !html.includes("<p")) {
    return true;
  }

  return false;
}

/**
 * D1（x_log_posts および EmDash コアテーブル ec_posts / revisions）へ記事を保存
 */
async function saveDayPostToD1(db, existingPost, dateStr, fullDayHtml, postCount) {
  await ensureEmDashD1Schema(db);
  const now = new Date().toISOString();
  const id = existingPost?.id || `post_${dateStr}`;
  const createdAt = existingPost?.created_at || now;
  const pubDate = `${dateStr}T00:00:01Z`;

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
    .bind(id, dateStr, dateStr, fullDayHtml, postCount, pubDate, createdAt, now)
    .run();

  // EmDash コアテーブル (ec_posts / revisions) にも同期
  const revId = `rev_${dateStr}_${Date.now()}`;
  const portableText = JSON.stringify([
    {
      _type: "block",
      style: "normal",
      children: [{ _type: "span", text: `${dateStr} (${postCount} posts)` }]
    }
  ]);
  const revData = JSON.stringify({
    title: dateStr,
    content: JSON.parse(portableText),
    html_body: fullDayHtml
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
    .bind(id, dateStr, dateStr, portableText, fullDayHtml, createdAt, now, pubDate, revId)
    .run();

  return { id, link: `/posts/${dateStr}` };
}

/**
 * 1日分のポスト群を EmDash (D1 + R2) に作成または上書き更新する
 */
async function upsertEmDashDayPost(dateStr, dayPosts, env) {
  const existingPost = await findEmDashPostByDateSlug(dateStr, env);
  const existingContent = existingPost?.content || "";
  const postBlocksMap = extractExistingPostBlocks(existingContent);
  const uploadCache = new Map();

  let addedCount = 0;
  let uploadedMediaCount = 0;

  for (const post of dayPosts) {
    if (postBlocksMap.has(post.id)) {
      const existingBlock = postBlocksMap.get(post.id);
      if (!shouldRepairExistingPostBlock(existingBlock, post)) {
        continue; // 正常に記録済みのポストはスキップ（メディア再アップロード防止）
      }
    }

    // 本人のポスト（およびRT本文側）のメディアを R2 へ保存
    if (Array.isArray(post.media)) {
      for (let i = 0; i < post.media.length; i++) {
        const m = post.media[i];
        uploadedMediaCount += await resolveMediaItemForEmDash(
          m,
          `x-media-${post.id}-${i}`,
          uploadCache,
          env
        );
      }
    }

    // 引用・リプライ・RT元のメディアも R2 へ保存（uploadCacheにより同一URLの二重アップロードは自動で防ぐ）
    if (post.referencedPost && Array.isArray(post.referencedPost.media)) {
      for (let i = 0; i < post.referencedPost.media.length; i++) {
        const m = post.referencedPost.media[i];
        uploadedMediaCount += await resolveMediaItemForEmDash(
          m,
          `x-quoted-${post.id}-${i}`,
          uploadCache,
          env
        );
      }
    }

    const blockHtml = renderSinglePostHtml(post);
    postBlocksMap.set(post.id, blockHtml);
    addedCount++;
  }

  if (existingPost && addedCount === 0) {
    return {
      dateStr,
      postId: existingPost.id,
      action: "unchanged",
      addedCount: 0,
      uploadedMediaCount: 0,
      totalPostsInDay: postBlocksMap.size
    };
  }

  const fullDayHtml = buildDayContainerHtml(dateStr, postBlocksMap);
  const baseUrl = normalizeEmDashBaseUrl(env.EMDASH_URL || "");

  let savedPost;
  if (env.DB) {
    savedPost = await saveDayPostToD1(env.DB, existingPost, dateStr, fullDayHtml, postBlocksMap.size);
    if (baseUrl) {
      savedPost.link = `${baseUrl}/posts/${dateStr}`;
    }
  } else if (baseUrl) {
    const headers = { "Content-Type": "application/json" };
    const secret = (env.EMDASH_API_KEY || env.TRIGGER_SECRET || "").trim();
    if (secret) headers.Authorization = `Bearer ${secret}`;

    const saveRes = await fetch(`${baseUrl}/_emdash/api/posts`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        slug: dateStr,
        title: dateStr,
        content: fullDayHtml,
        date: `${dateStr}T00:00:01Z`
      })
    });
    if (!saveRes.ok) {
      const errText = await saveRes.text();
      throw new Error(`EmDash 記事保存エラー (${saveRes.status}): ${errText}`);
    }
    savedPost = await saveRes.json();
  } else {
    throw new Error(
      "D1 バインディング (DB) が設定されていません。GitHub Actions のデプロイを実行してください。"
    );
  }

  return {
    dateStr,
    postId: savedPost.id,
    link: savedPost.link,
    action: existingPost ? "updated" : "created",
    addedCount,
    uploadedMediaCount,
    totalPostsInDay: postBlocksMap.size
  };
}

// ============================================================================
// GitHub Markdown 生成・同期（画像・動画なし、YearYYYY.md / MonthYYYYMM.md / Fulldata.md）
// ============================================================================

function formatMarkdownParagraphs(text) {
  const normalized = String(text || "")
    .trim()
    .replace(/\r\n|\r/g, "\n");
  if (!normalized) return "";
  return normalized
    .split(/\n{2,}/)
    .map((para) => para.replace(/\n/g, "  \n"))
    .join("\n\n");
}

/**
 * URLリンク等（画像・動画のt.co短縮URLなど）を除外・整形してMarkdown用の本文にする
 */
export function renderSinglePostMarkdown(post) {
  const postUrl = `https://x.com/${post.username}/status/${post.id}`;
  const cleanText = formatMarkdownParagraphs(post.text);

  let md = `<!-- x-post:${post.id} date:${post.dateStr} time:${post.timeStr} -->\n`;
  md += `### [${post.timeStr}](${postUrl})\n\n`;
  md += `${cleanText}\n`;

  if (post.referencedPost) {
    const ref = post.referencedPost;
    const refUrl = `https://x.com/${ref.username}/status/${ref.id}`;
    const refFormatted = formatMarkdownParagraphs(ref.text);
    const refLines = refFormatted
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
    md += `\n> **@${ref.username} のポスト ([元ポスト](${refUrl})):**\n${refLines}\n`;
  }

  md += `<!-- /x-post:${post.id} -->`;
  return md;
}

/**
 * 既存のMarkdown文字列から <!-- x-post:{ID} date:{YYYY-MM-DD} time:{HH:MM} --> ... <!-- /x-post:{ID} --> を抽出
 */
export function parseExistingMarkdownEntries(markdownText) {
  const entries = new Map();
  const str = String(markdownText || "");
  const regex =
    /<!--\s*x-post:(\d+)\s+date:(\d{4}-\d{2}-\d{2})\s+time:(\d{2}:\d{2})\s*-->([\s\S]*?)<!--\s*\/x-post:\1\s*-->/g;

  let m;
  while ((m = regex.exec(str)) !== null) {
    const id = m[1];
    const dateStr = m[2];
    const timeStr = m[3];
    const rawBlock = m[0].trim();
    entries.set(id, { id, dateStr, timeStr, rawBlock });
  }
  return entries;
}

/**
 * 既存のMarkdownエントリと新規ポストをマージし、日付見出し（## YYYY-MM-DD）別に整形したMarkdown全文を生成
 */
export function buildMergedMarkdownDocument(title, existingMarkdown, newPosts) {
  const entries = parseExistingMarkdownEntries(existingMarkdown);
  let addedCount = 0;

  for (const post of newPosts) {
    if (!entries.has(post.id)) {
      entries.set(post.id, {
        id: post.id,
        dateStr: post.dateStr,
        timeStr: post.timeStr,
        rawBlock: renderSinglePostMarkdown(post)
      });
      addedCount++;
    }
  }

  // 日付ごとにグループ化
  const byDate = new Map();
  for (const entry of entries.values()) {
    if (!byDate.has(entry.dateStr)) {
      byDate.set(entry.dateStr, []);
    }
    byDate.get(entry.dateStr).push(entry);
  }

  // 日付降順（新しい日付が上）
  const sortedDates = Array.from(byDate.keys()).sort((a, b) => b.localeCompare(a));

  const sections = [];
  for (const dateStr of sortedDates) {
    const list = byDate.get(dateStr);
    // 同じ日付内は Tweet ID 降順（新しい順）
    list.sort((a, b) => {
      try {
        const bigA = BigInt(a.id);
        const bigB = BigInt(b.id);
        return bigB > bigA ? 1 : bigB < bigA ? -1 : 0;
      } catch {
        return b.id.localeCompare(a.id);
      }
    });
    const dayBody = list.map((item) => item.rawBlock).join("\n\n");
    sections.push(`## ${dateStr}\n\n${dayBody}`);
  }

  const content = `# ${title}\n\n${sections.join("\n\n---\n\n")}\n`;
  return { content, addedCount, totalCount: entries.size };
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const clean = String(b64 || "").replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

function normalizeGitHubRepo(rawRepo) {
  let r = String(rawRepo || "").trim();
  r = r.replace(/^https?:\/\/github\.com\//i, "");
  r = r.replace(/\.git$/i, "");
  r = r.replace(/^\/+|\/+$/g, "");
  return r;
}

/**
 * GitHub Contents API で 1 つの Markdown ファイルを取得・マージ・保存
 */
async function upsertGitHubMarkdownFile(filePath, docTitle, postsForFile, env) {
  const repo = normalizeGitHubRepo(env.GITHUB_REPO || env.GH_SYNC_REPO || "");
  const token = (env.GITHUB_TOKEN || env.GH_SYNC_TOKEN || "").trim();
  const branch = (env.GITHUB_BRANCH || env.GH_SYNC_BRANCH || "").trim();

  const normalizedPath = filePath.replace(/^\/+/, "");
  const apiUrl = new URL(`https://api.github.com/repos/${repo}/contents/${normalizedPath}`);
  if (branch) {
    apiUrl.searchParams.set("ref", branch);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "x-logger-cloudflare-worker/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  let existingSha = null;
  let existingMarkdown = "";

  const getRes = await fetch(apiUrl.toString(), { method: "GET", headers });
  if (getRes.ok) {
    const fileData = await getRes.json();
    existingSha = fileData.sha;
    if (fileData.content) {
      existingMarkdown = base64ToUtf8(fileData.content);
    }
  } else if (getRes.status !== 404) {
    const errText = await getRes.text();
    throw new Error(`GitHubファイル取得失敗 (${getRes.status} ${normalizedPath}): ${errText}`);
  }

  const { content, addedCount, totalCount } = buildMergedMarkdownDocument(
    docTitle,
    existingMarkdown,
    postsForFile
  );

  if (existingSha && addedCount === 0) {
    return { filePath: normalizedPath, action: "unchanged", addedCount: 0, totalCount };
  }

  const putBody = {
    message: `Update ${normalizedPath} (+${addedCount} posts)`,
    content: utf8ToBase64(content)
  };
  if (existingSha) putBody.sha = existingSha;
  if (branch) putBody.branch = branch;

  const putUrl = `https://api.github.com/repos/${repo}/contents/${normalizedPath}`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(putBody)
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    throw new Error(
      `GitHubファイル更新失敗 (${putRes.status} ${normalizedPath} [repo=${repo}]): ${errText}`
    );
  }

  return {
    filePath: normalizedPath,
    action: existingSha ? "updated" : "created",
    addedCount,
    totalCount
  };
}

/**
 * GITHUB_MD_TARGETS ("year,month,full") に応じて Markdown ファイルを GitHub に保存
 */
async function syncPostsToGitHub(posts, env) {
  const token = (env.GITHUB_TOKEN || env.GH_SYNC_TOKEN || "").trim();
  const repo = (env.GITHUB_REPO || env.GH_SYNC_REPO || "").trim();
  if (!token || !repo) {
    return { enabled: false, results: [] };
  }

  const rawTargets = (env.GH_MD_TARGETS || env.GITHUB_MD_TARGETS || "year,month,full")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const dirPrefix = (env.GH_MD_DIR || env.GITHUB_MD_DIR || "").trim().replace(/^\/+|\/+$/g, "");
  const withDir = (name) => (dirPrefix ? `${dirPrefix}/${name}` : name);

  const results = [];

  // 1. YearYYYY.md (例: Year2026.md)
  if (rawTargets.includes("year")) {
    const byYear = new Map();
    for (const p of posts) {
      if (!byYear.has(p.yearStr)) byYear.set(p.yearStr, []);
      byYear.get(p.yearStr).push(p);
    }
    for (const [yearStr, yearPosts] of byYear.entries()) {
      const fileName = `Year${yearStr}.md`;
      const res = await upsertGitHubMarkdownFile(
        withDir(fileName),
        `X Log - Year ${yearStr}`,
        yearPosts,
        env
      );
      results.push(res);
    }
  }

  // 2. MonthYYYYMM.md (例: Month202611.md)
  if (rawTargets.includes("month")) {
    const byMonth = new Map();
    for (const p of posts) {
      if (!byMonth.has(p.yearMonthStr)) byMonth.set(p.yearMonthStr, []);
      byMonth.get(p.yearMonthStr).push(p);
    }
    for (const [ymStr, monthPosts] of byMonth.entries()) {
      const fileName = `Month${ymStr}.md`;
      const res = await upsertGitHubMarkdownFile(
        withDir(fileName),
        `X Log - Month ${ymStr}`,
        monthPosts,
        env
      );
      results.push(res);
    }
  }

  // 3. Fulldata.md
  if (rawTargets.includes("full")) {
    const res = await upsertGitHubMarkdownFile(
      withDir("Fulldata.md"),
      "X Log - Full Data",
      posts,
      env
    );
    results.push(res);
  }

  return { enabled: true, targets: rawTargets, results };
}

// ============================================================================
// メイン同期処理 & Cloudflare Worker エントリポイント
// ============================================================================

/**
 * 参照元ポスト（RT先・引用先・さらにその中の引用ポスト）のメディアや動画variantsが
 * タイムラインAPIだけでは展開されないケースを補完する
 */
async function enrichReferencedTweets(apiData, env) {
  if (!apiData || !Array.isArray(apiData.data)) return;
  if (!apiData.includes) apiData.includes = {};
  if (!Array.isArray(apiData.includes.tweets)) apiData.includes.tweets = [];
  if (!Array.isArray(apiData.includes.media)) apiData.includes.media = [];
  if (!Array.isArray(apiData.includes.users)) apiData.includes.users = [];

  const existingTweetMap = new Map(apiData.includes.tweets.map((t) => [t.id, t]));
  const existingMediaMap = new Map(apiData.includes.media.map((m) => [m.media_key, m]));
  const existingUserMap = new Map(apiData.includes.users.map((u) => [u.id, u]));

  const refIdsToFetch = new Set();

  for (const t of apiData.data) {
    for (const ref of t.referenced_tweets || []) {
      if (ref.id) refIdsToFetch.add(ref.id);
    }
  }
  for (const t of apiData.includes.tweets) {
    for (const ref of t.referenced_tweets || []) {
      if (ref.id) refIdsToFetch.add(ref.id);
    }
  }

  if (refIdsToFetch.size === 0) return;

  try {
    const idsParam = Array.from(refIdsToFetch).slice(0, 100).join(",");
    const lookupUrl = new URL("https://api.x.com/2/tweets");
    lookupUrl.searchParams.set("ids", idsParam);
    lookupUrl.searchParams.set(
      "tweet.fields",
      "created_at,text,note_tweet,entities,attachments,referenced_tweets,author_id"
    );
    lookupUrl.searchParams.set(
      "expansions",
      "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys"
    );
    lookupUrl.searchParams.set(
      "media.fields",
      "media_key,type,url,preview_image_url,variants,alt_text"
    );
    lookupUrl.searchParams.set("user.fields", "id,username,name");

    const refData = await xApiFetch(lookupUrl.toString(), env);

    for (const t of refData?.data || []) {
      existingTweetMap.set(t.id, t);
    }
    for (const t of refData?.includes?.tweets || []) {
      if (!existingTweetMap.has(t.id)) {
        existingTweetMap.set(t.id, t);
      }
    }
    for (const m of refData?.includes?.media || []) {
      existingMediaMap.set(m.media_key, m);
    }
    for (const u of refData?.includes?.users || []) {
      existingUserMap.set(u.id, u);
    }

    apiData.includes.tweets = Array.from(existingTweetMap.values());
    apiData.includes.media = Array.from(existingMediaMap.values());
    apiData.includes.users = Array.from(existingUserMap.values());
  } catch (err) {
    console.error("参照元ポストの追加取得をスキップしました:", err.message);
  }
}

export async function runXLoggerSync(env) {
  const timeZone = env.TIMEZONE || "Asia/Tokyo";
  const maxResults = Math.min(100, Math.max(5, parseInt(env.X_MAX_RESULTS || "20", 10) || 20));
  const includeReplies = String(env.INCLUDE_REPLIES ?? "true").toLowerCase() !== "false";
  const includeQuotes = String(env.INCLUDE_QUOTES ?? "true").toLowerCase() !== "false";
  const includeRetweets = String(env.INCLUDE_RETWEETS ?? "true").toLowerCase() !== "false";

  const { userId, username } = await resolveXUser(env);

  const timelineUrl = new URL(`https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`);
  timelineUrl.searchParams.set("max_results", String(maxResults));
  timelineUrl.searchParams.set(
    "tweet.fields",
    "created_at,text,note_tweet,entities,attachments,referenced_tweets,author_id"
  );
  timelineUrl.searchParams.set(
    "expansions",
    "attachments.media_keys,author_id,referenced_tweets.id,referenced_tweets.id.author_id,referenced_tweets.id.attachments.media_keys"
  );
  timelineUrl.searchParams.set(
    "media.fields",
    "media_key,type,url,preview_image_url,variants,alt_text"
  );
  timelineUrl.searchParams.set("user.fields", "id,username,name");

  const apiData = await xApiFetch(timelineUrl.toString(), env);
  await enrichReferencedTweets(apiData, env);

  const posts = normalizeXApiResponse(apiData, username, {
    timeZone,
    includeReplies,
    includeQuotes,
    includeRetweets
  });

  // 日付（YYYY-MM-DD）ごとにグループ化して EmDash (D1 + R2) へ反映
  const postsByDate = new Map();
  for (const post of posts) {
    if (!postsByDate.has(post.dateStr)) {
      postsByDate.set(post.dateStr, []);
    }
    postsByDate.get(post.dateStr).push(post);
  }

  // 古い日付から順に処理
  const sortedDates = Array.from(postsByDate.keys()).sort();
  const emdashResults = [];
  for (const dateStr of sortedDates) {
    const dayPosts = postsByDate.get(dateStr);
    const res = await upsertEmDashDayPost(dateStr, dayPosts, env);
    emdashResults.push(res);
  }

  // オプション：GitHub リポジトリへ Markdown 保存（画像・動画なし）
  const githubResult = await syncPostsToGitHub(posts, env);

  return {
    ok: true,
    executedAt: new Date().toISOString(),
    username,
    fetchedCount: posts.length,
    emdash: emdashResults,
    github: githubResult
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Filename"
};

function checkTriggerAuth(request, env) {
  const secret = (env.TRIGGER_SECRET || env.EMDASH_API_KEY || "").trim();
  if (!secret) return true;
  const auth = request.headers.get("Authorization") || "";
  if (auth === `Bearer ${secret}`) return true;
  const url = new URL(request.url);
  if (url.searchParams.get("key") === secret) return true;
  return false;
}

async function getSiteSettingsFromD1(env) {
  let title = env.SITE_TITLE || "X-Log";
  let subtitle = env.SITE_SUBTITLE || "Daily X (Twitter) Archive powered by EmDash (Cloudflare D1 + R2)";
  if (env.DB) {
    try {
      await ensureEmDashD1Schema(env.DB);
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

async function getSidebarDataFromD1(db) {
  await ensureEmDashD1Schema(db);
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

function renderSiteLayoutHtml({
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
    .site-brand h1 { margin: 0; font-size: 1.6rem; letter-spacing: -0.02em; }
    .site-brand h1 a { color: var(--text); text-decoration: none; }
    .site-brand p { margin: 4px 0 0 0; font-size: 0.88rem; color: var(--muted); }
    .header-search { display: flex; gap: 6px; }
    .header-search input {
      padding: 7px 12px;
      border: 1px solid var(--border);
      border-radius: 20px;
      font-size: 0.9rem;
      width: 220px;
      outline: none;
    }
    .header-search input:focus { border-color: var(--accent); }
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
    .header-search button:hover { background: var(--accent-hover); }
    .container {
      max-width: 1080px;
      margin: 0 auto;
      padding: 0 16px 48px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 290px;
      gap: 24px;
      align-items: start;
    }
    @media (max-width: 820px) { .container { grid-template-columns: 1fr; } }
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
    .day-article-title { margin: 0; font-size: 1.4rem; }
    .day-article-title a { color: var(--text); text-decoration: none; }
    .day-article-title a:hover { color: var(--accent); }
    .day-badge {
      font-size: 0.82rem;
      color: var(--muted);
      background: #f0f4f8;
      padding: 3px 10px;
      border-radius: 999px;
      font-weight: 600;
    }
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
    .page-btn:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
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
    .sidebar-list { list-style: none; margin: 0; padding: 0; font-size: 0.92rem; }
    .sidebar-list li { padding: 5px 0; border-bottom: 1px dashed #f0f3f5; }
    .sidebar-list li:last-child { border-bottom: none; }
    .sidebar-list li a { display: flex; justify-content: space-between; color: var(--text); }
    .sidebar-list li a:hover { color: var(--accent); text-decoration: none; }
    .sidebar-list li span { color: var(--muted); font-size: 0.84rem; }
    .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; text-align: center; }
    .stat-box { background: #f8fafc; border: 1px solid var(--border); border-radius: 8px; padding: 10px; }
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

async function handleAdminPageInWorker(env) {
  await ensureEmDashD1Schema(env.DB);
  const { title: siteTitle, subtitle: siteSubtitle } = await getSiteSettingsFromD1(env);
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
    button.btn-sync { background: #17bf63; }
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
      <h2>🔄 手動X同期（テスト実行）</h2>
      <p style="font-size:0.9rem;color:#657786;margin-top:0;">Cron（自動定期実行）を待たずに、今すぐX APIから最新ポストを取得して反映します。</p>
      <button class="btn-sync" onclick="triggerSync()">🔄 今すぐXから最新ポストを取得</button>
      <span id="syncMsg" style="margin-left:10px;font-size:0.9rem;"></span>
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
    async function triggerSync() {
      const msg = document.getElementById("syncMsg");
      msg.textContent = "⏳ X API から取得中...";
      try {
        const res = await fetch("/trigger", { method: "POST", headers: getHeaders() });
        const data = await res.json();
        if (data.ok) {
          msg.textContent = "✔ 同期成功！ (" + data.fetchedCount + "件取得) ページを再読み込みします...";
          setTimeout(() => location.reload(), 1200);
        } else {
          msg.textContent = "❌ エラー: " + data.error;
        }
      } catch (e) {
        msg.textContent = "❌ 通信エラー: " + e.message;
      }
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

async function handleR2MediaStream(request, env, rawKey) {
  const cleanKey = decodeURIComponent(rawKey).replace(/^\/+/, "");
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
  if (object.httpEtag) headers.set("etag", object.httpEtag);
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

  if (object.size !== undefined) headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runXLoggerSync(env).catch((err) => {
        console.error("[x-logger cron error]", err);
      })
    );
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;

    // 1. R2 メディア配信 (/media/:key または /_emdash/api/media/file/:key、Rangeリクエスト対応)
    if (pathname.startsWith("/media/") && env.MEDIA) {
      return handleR2MediaStream(request, env, pathname.slice("/media/".length));
    }
    if (pathname.startsWith("/_emdash/api/media/file/") && env.MEDIA) {
      return handleR2MediaStream(request, env, pathname.slice("/_emdash/api/media/file/".length));
    }

    // 2. インポーター用 R2 メディアアップロード API (POST /_emdash/api/media または POST /api/media)
    if ((pathname === "/_emdash/api/media" || pathname === "/api/media") && request.method === "POST") {
      if (!checkTriggerAuth(request, env)) {
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

      await env.MEDIA.put(safeKey, arrayBuffer, { httpMetadata: { contentType } });
      if (env.DB) {
        await ensureEmDashD1Schema(env.DB);
        await env.DB.prepare(
          `INSERT OR REPLACE INTO x_log_media (key, filename, content_type, size, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`
        )
          .bind(safeKey, rawFilename, contentType, arrayBuffer.byteLength, new Date().toISOString())
          .run();
      }
      const baseUrl = normalizeEmDashBaseUrl(env.EMDASH_URL || "");
      const mediaUrl = baseUrl ? `${baseUrl}/media/${safeKey}` : `/media/${safeKey}`;
      return new Response(
        JSON.stringify({ ok: true, key: safeKey, url: mediaUrl, source_url: `${url.origin}/media/${safeKey}` }),
        {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // 3. インポーター・管理画面用 D1 記事取得・保存・削除 API (/_emdash/api/posts または /api/posts)
    if ((pathname === "/_emdash/api/posts" || pathname === "/api/posts") && env.DB) {
      if (request.method === "GET") {
        const slug = url.searchParams.get("slug");
        const post = slug ? await findEmDashPostByDateSlug(slug, env) : null;
        return new Response(JSON.stringify({ ok: true, post }), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
      if (request.method === "POST" || request.method === "PUT") {
        if (!checkTriggerAuth(request, env)) {
          return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
            status: 401,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }
        const body = await request.json();
        const slug = String(body.slug || body.title || "").trim();
        const existing = await findEmDashPostByDateSlug(slug, env);
        const content = String(body.content || "");
        const matches = content.match(/id="x-post-\d+"/g);
        const postCount = matches ? matches.length : 1;
        const saved = await saveDayPostToD1(env.DB, existing, slug, content, postCount);
        return new Response(
          JSON.stringify({ ok: true, ...saved, action: existing ? "updated" : "created" }),
          {
            status: 200,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          }
        );
      }
      if (request.method === "DELETE") {
        if (!checkTriggerAuth(request, env)) {
          return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
            status: 401,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
          });
        }
        const slug = url.searchParams.get("slug");
        if (slug) {
          await ensureEmDashD1Schema(env.DB);
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
    if (pathname === "/_emdash/api/settings" && request.method === "POST" && env.DB) {
      if (!checkTriggerAuth(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
      await ensureEmDashD1Schema(env.DB);
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

    // 5. 手動トリガー (POST /trigger)
    if (pathname === "/trigger" && request.method === "POST") {
      if (!checkTriggerAuth(request, env)) {
        return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
          status: 401,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        });
      }
      try {
        const result = await runXLoggerSync(env);
        return new Response(JSON.stringify(result, null, 2), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
        });
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2),
          {
            status: 500,
            headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
          }
        );
      }
    }

    // 6. ステータス確認 JSON (/status)
    if (pathname === "/status" || !env.DB) {
      return new Response(
        JSON.stringify(
          {
            service: "x-logger-emdash",
            status: "running",
            timezone: env.TIMEZONE || "Asia/Tokyo",
            d1Bound: Boolean(env.DB),
            r2Bound: Boolean(env.MEDIA),
            emdashUrl: env.EMDASH_URL || "(direct D1+R2 binding)",
            githubSyncEnabled: Boolean(env.GITHUB_TOKEN && env.GITHUB_REPO),
            githubMdTargets: env.GITHUB_MD_TARGETS || "year,month,full"
          },
          null,
          2
        ),
        {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" }
        }
      );
    }

    // 7. EmDash 管理画面 (/_emdash/admin または /admin)
    if (pathname === "/_emdash/admin" || pathname === "/admin") {
      return handleAdminPageInWorker(env);
    }

    // 8. RSS フィード (/feed.xml または /rss.xml)
    if (pathname === "/feed.xml" || pathname === "/rss.xml") {
      await ensureEmDashD1Schema(env.DB);
      const { title: siteTitle, subtitle: siteSubtitle } = await getSiteSettingsFromD1(env);
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

    await ensureEmDashD1Schema(env.DB);
    const { title: siteTitle, subtitle: siteSubtitle } = await getSiteSettingsFromD1(env);
    const sidebar = await getSidebarDataFromD1(env.DB);

    // 9. 個別日ページ (/posts/YYYY-MM-DD または /YYYY-MM-DD)
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
        const notFoundHtml = renderSiteLayoutHtml({
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

      const html = renderSiteLayoutHtml({
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

    // 10. 月別アーカイブページ (/archive/YYYY-MM)
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

      const html = renderSiteLayoutHtml({
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

    // 11. トップページ（一覧 & キーワード検索 & ページネーション）
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
            <p>1分ごとの自動同期が動くか、<a href="/_emdash/admin">EmDash管理画面</a>の「🔄 今すぐXから最新ポストを取得」ボタンを押すと、ここに日別（YYYY-MM-DD）のポスト一覧が表示されます。</p>
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

    const html = renderSiteLayoutHtml({
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

