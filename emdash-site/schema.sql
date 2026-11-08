-- ============================================================================
-- EmDash & X-Log D1 Database Schema (Cloudflare D1 / SQLite)
-- ============================================================================

-- 1. X-Log 日別記事テーブル
CREATE TABLE IF NOT EXISTS x_log_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  post_count INTEGER NOT NULL DEFAULT 0,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x_log_posts_slug ON x_log_posts(slug);
CREATE INDEX IF NOT EXISTS idx_x_log_posts_published_at ON x_log_posts(published_at DESC);

-- 2. R2 メディア管理テーブル
CREATE TABLE IF NOT EXISTS x_log_media (
  key TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x_log_media_created_at ON x_log_media(created_at DESC);

-- 3. サイト設定テーブル
CREATE TABLE IF NOT EXISTS x_log_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 4. EmDash コア互換コレクション・記事・リビジョンテーブル
CREATE TABLE IF NOT EXISTS _emdash_collections (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url_pattern TEXT,
  supports_revisions INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _emdash_fields (
  id TEXT PRIMARY KEY,
  collection_slug TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(collection_slug, slug)
);

CREATE TABLE IF NOT EXISTS ec_posts (
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
);

CREATE INDEX IF NOT EXISTS idx_ec_posts_slug ON ec_posts(slug);
CREATE INDEX IF NOT EXISTS idx_ec_posts_published_at ON ec_posts(published_at DESC);

CREATE TABLE IF NOT EXISTS revisions (
  id TEXT PRIMARY KEY,
  collection_slug TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'published',
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revisions_entry ON revisions(collection_slug, entry_id);

-- 初期コレクション定義（冪等）
INSERT OR IGNORE INTO _emdash_collections (id, slug, name, url_pattern, supports_revisions, created_at, updated_at)
VALUES ('col_posts', 'posts', 'Posts', '/posts/{slug}', 1, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO _emdash_fields (id, collection_slug, slug, name, type, required, sort_order)
VALUES
  ('fld_posts_title', 'posts', 'title', 'Title', 'string', 1, 1),
  ('fld_posts_content', 'posts', 'content', 'Content', 'portableText', 1, 2),
  ('fld_posts_html_body', 'posts', 'html_body', 'HTML Body', 'text', 0, 3);

