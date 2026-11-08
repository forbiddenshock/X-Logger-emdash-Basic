import test from "node:test";
import assert from "node:assert/strict";
import {
  formatInTimezone,
  formatTweetBodyHtml,
  normalizeXApiResponse,
  renderSinglePostHtml,
  extractExistingPostBlocks,
  buildDayContainerHtml,
  renderSinglePostMarkdown,
  buildMergedMarkdownDocument
} from "../src/worker.js";
import emdashSiteWorker from "../emdash-site/src/worker.js";

test("formatTweetBodyHtml preserves double newlines as paragraphs and single newlines as <br />", () => {
  const single = formatTweetBodyHtml("1行目\n2行目");
  assert.equal(single, "1行目<br />\n2行目");

  const multi = formatTweetBodyHtml("段落1の1行目\n段落1の2行目\n\n段落2\n\n段落3");
  assert.ok(multi.includes('<p style="margin: 0 0 1em 0;">段落1の1行目<br />\n段落1の2行目</p>'));
  assert.ok(multi.includes('<p style="margin: 0 0 1em 0;">段落2</p>'));
  assert.ok(multi.includes('<p style="margin: 0;">段落3</p>'));
});

test("formatInTimezone converts UTC ISO string to Asia/Tokyo date and time", () => {
  // 2026-11-08T17:30:00Z -> 2026-11-09 02:30 JST
  const res = formatInTimezone("2026-11-08T17:30:00.000Z", "Asia/Tokyo");
  assert.equal(res.dateStr, "2026-11-09");
  assert.equal(res.timeStr, "02:30");
  assert.equal(res.yearStr, "2026");
  assert.equal(res.yearMonthStr, "202611");
});

test("normalizeXApiResponse handles normal, quoted, reply, and retweet posts with media & videos", () => {
  const sampleApiData = {
    data: [
      {
        id: "2119482641405841775",
        created_at: "2026-11-08T17:30:00.000Z",
        text: "通常のポスト本文\n2行目",
        attachments: { media_keys: ["3_1001"] }
      },
      {
        id: "2119446764751319383",
        created_at: "2026-11-08T15:07:00.000Z",
        text: "引用コメント",
        referenced_tweets: [{ type: "quoted", id: "2119444839943352573" }]
      },
      {
        id: "2119382588934828384",
        created_at: "2026-11-08T10:52:00.000Z",
        text: "RT @_298rock: RT元のテキスト",
        referenced_tweets: [{ type: "retweeted", id: "2119076485541908598" }]
      }
    ],
    includes: {
      media: [
        {
          media_key: "3_1001",
          type: "photo",
          url: "https://pbs.twimg.com/media/sample1.jpg"
        },
        {
          media_key: "3_1002",
          type: "video",
          preview_image_url: "https://pbs.twimg.com/media/thumb.jpg",
          variants: [
            { bit_rate: 256000, content_type: "video/mp4", url: "https://video.twimg.com/low.mp4" },
            { bit_rate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/high.mp4" }
          ]
        },
        {
          media_key: "3_1003",
          type: "photo",
          url: "https://pbs.twimg.com/media/rt_nested_quote.jpg"
        }
      ],
      users: [
        { id: "u_quoted", username: "2026musyoku" },
        { id: "u_rt", username: "_298rock" },
        { id: "u_nested", username: "nested_author" }
      ],
      tweets: [
        {
          id: "2119444839943352573",
          author_id: "u_quoted",
          text: "引用元ポスト本文",
          attachments: { media_keys: ["3_1002"] }
        },
        {
          id: "2119076485541908598",
          author_id: "u_rt",
          text: "RT元のテキスト全文",
          referenced_tweets: [{ type: "quoted", id: "2119000000000000001" }]
        },
        {
          id: "2119000000000000001",
          author_id: "u_nested",
          text: "RT先が引用していた画像付きポスト",
          attachments: { media_keys: ["3_1003"] }
        }
      ]
    }
  };

  const posts = normalizeXApiResponse(sampleApiData, "showya_kiss", {
    timeZone: "Asia/Tokyo",
    includeReplies: true,
    includeQuotes: true,
    includeRetweets: true
  });

  assert.equal(posts.length, 3);
  assert.equal(posts[0].media[0].url, "https://pbs.twimg.com/media/sample1.jpg");
  assert.equal(posts[1].referencedPost.username, "2026musyoku");
  assert.equal(posts[1].referencedPost.media[0].type, "video");
  assert.equal(posts[1].referencedPost.media[0].url, "https://video.twimg.com/high.mp4");
  assert.deepEqual(posts[1].referencedPost.media[0].fallbackUrls, ["https://video.twimg.com/low.mp4"]);

  // RTでも本文側 (post.media) と引用側 (post.referencedPost.media) の両方に画像が入ること
  assert.equal(posts[2].referencedPost.username, "_298rock");
  assert.equal(posts[2].media.length, 1);
  assert.equal(posts[2].media[0].url, "https://pbs.twimg.com/media/rt_nested_quote.jpg");
  assert.equal(posts[2].referencedPost.media.length, 1);
  assert.equal(posts[2].referencedPost.media[0].url, "https://pbs.twimg.com/media/rt_nested_quote.jpg");

  const rtHtml = renderSinglePostHtml(posts[2]);
  assert.ok(rtHtml.includes("https://pbs.twimg.com/media/rt_nested_quote.jpg"));

  const videoHtml = renderSinglePostHtml(posts[1]);
  assert.ok(videoHtml.includes('<video controls playsinline preload="metadata"'));
  assert.ok(videoHtml.includes('<source src="https://video.twimg.com/high.mp4" type="video/mp4" />'));
});

test("extractExistingPostBlocks and buildDayContainerHtml preserve and merge posts accurately", () => {
  const post1 = {
    id: "100",
    username: "showya_kiss",
    dateStr: "2026-11-09",
    timeStr: "01:00",
    text: "最初のポスト",
    media: [{ type: "photo", wpUrl: "https://xlog.showya-kiss.com/wp-content/uploads/1.jpg" }],
    referencedPost: {
      id: "99",
      username: "other_user",
      text: "引用元",
      media: []
    }
  };

  const post2 = {
    id: "200",
    username: "showya_kiss",
    dateStr: "2026-11-09",
    timeStr: "02:30",
    text: "2つ目のポスト",
    media: [],
    referencedPost: null
  };

  const initialMap = new Map([[post1.id, renderSinglePostHtml(post1)]]);
  const initialDayHtml = buildDayContainerHtml("2026-11-09", initialMap);

  const parsedMap = extractExistingPostBlocks(initialDayHtml);
  assert.equal(parsedMap.size, 1);
  assert.ok(parsedMap.has("100"));
  assert.ok(parsedMap.get("100").includes("x-log-quoted"));

  // 新規ポストをマージ
  parsedMap.set(post2.id, renderSinglePostHtml(post2));
  const mergedDayHtml = buildDayContainerHtml("2026-11-09", parsedMap);

  // 新しいポスト (id=200) が古いポスト (id=100) より上に配置されること
  const idx200 = mergedDayHtml.indexOf('id="x-post-200"');
  const idx100 = mergedDayHtml.indexOf('id="x-post-100"');
  assert.ok(idx200 !== -1 && idx100 !== -1 && idx200 < idx100);
});

test("buildMergedMarkdownDocument merges posts without images/videos and deduplicates", () => {
  const postA = {
    id: "100",
    username: "showya_kiss",
    dateStr: "2026-11-08",
    timeStr: "23:00",
    text: "昨日のポスト",
    media: [{ type: "photo", url: "https://pbs.twimg.com/media/ignore.jpg" }],
    referencedPost: null
  };

  const postB = {
    id: "200",
    username: "showya_kiss",
    dateStr: "2026-11-09",
    timeStr: "02:30",
    text: "今日のポスト",
    media: [{ type: "video", url: "https://video.twimg.com/ignore.mp4" }],
    referencedPost: {
      id: "150",
      username: "ref_user",
      text: "引用されたテキスト"
    }
  };

  const firstRun = buildMergedMarkdownDocument("X Log - Year 2026", "", [postA]);
  assert.equal(firstRun.addedCount, 1);
  assert.ok(!firstRun.content.includes("ignore.jpg"));

  const secondRun = buildMergedMarkdownDocument("X Log - Year 2026", firstRun.content, [postA, postB]);
  assert.equal(secondRun.addedCount, 1);
  assert.equal(secondRun.totalCount, 2);
  assert.ok(secondRun.content.includes("## 2026-11-09"));
  assert.ok(secondRun.content.includes("## 2026-11-08"));
  assert.ok(!secondRun.content.includes("ignore.mp4"));
});

test("emdashSiteWorker handles R2 media upload and retrieval", async () => {
  const r2Store = new Map();
  const mockEnv = {
    MEDIA: {
      async put(key, buf, opts) {
        r2Store.set(key, {
          body: buf,
          size: buf.byteLength,
          httpEtag: '"etag-1"',
          contentType: opts?.httpMetadata?.contentType || "image/jpeg",
          writeHttpMetadata(headers) {
            headers.set("Content-Type", this.contentType);
          }
        });
      },
      async get(key) {
        return r2Store.get(key) || null;
      }
    },
    DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async run() {
            return { success: true };
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [] };
          }
        };
      }
    }
  };

  const uploadReq = new Request("https://emdash-xlog.example.workers.dev/_emdash/api/media", {
    method: "POST",
    headers: {
      "Content-Type": "video/mp4",
      "X-Filename": "test-video.mp4"
    },
    body: new Uint8Array([1, 2, 3, 4]).buffer
  });

  const uploadRes = await emdashSiteWorker.fetch(uploadReq, mockEnv);
  assert.equal(uploadRes.status, 200);
  const uploadJson = await uploadRes.json();
  assert.equal(uploadJson.ok, true);
  assert.equal(uploadJson.url, "/media/test-video.mp4");

  const getReq = new Request("https://emdash-xlog.example.workers.dev/media/test-video.mp4", {
    method: "GET"
  });
  const getRes = await emdashSiteWorker.fetch(getReq, mockEnv);
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get("Content-Type"), "video/mp4");
  assert.equal(getRes.headers.get("Accept-Ranges"), "bytes");
});


