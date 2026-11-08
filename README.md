# x-logger (EmDash Edition) — サーバー契約不要！X (旧Twitter) 全自動バックアップツール

あなたの X（旧Twitter）の毎日のポスト（通常ポスト・リプライ・引用・リポスト/RT）と画像・動画を、**Cloudflare の無料枠だけ（EmDash CMS + D1 データベース + R2 ストレージ）**で全自動保存し、自分専用の高速な日別ログサイト（`xlog.showya-kiss.com` 形式）を構築するツールです。

WordPress サーバーを借りる必要はなく、**パソコンの黒い画面（ターミナル）も一切使いません**。GitHub の画面上でボタンを押すだけで、EmDash サイトも R2 ストレージも D1 データベースもすべて自動で作られます！

---

## ✨ できること

1. **EmDash サイト & ストレージ（R2 + D1）のワンクリック自動構築**
   - GitHub Actions の「1. Setup EmDash & R2/D1」ボタンを押すだけで、あなたの Cloudflare アカウント内に **R2 バケット（画像・動画用）**、**D1 データベース（記事用）**、**EmDash 日別ログサイト**を自動作成します。
2. **X ポストの全自動定期取得（最短1分おき）**
   - 「2. Deploy X-Logger」ボタンを押すと、Cloudflare のタイマー（Cron）が最短1分おきに X API から最新ポストを取得し、日付別（`2026-11-09` など）の記事に自動で追記・更新します。
3. **画像・動画のリンク切れ（リンク死）完全対策**
   - ポストや引用・RTに含まれる画像や動画（`.mp4`）を自動でダウンロードし、あなたの **Cloudflare R2** に永続保存します。あとから元ポストが消えても画像・動画は消えません。
4. **GitHub への Markdown 保存（任意・選択式）**
   - 希望する場合は、GitHub リポジトリ内にもテキストのみの綺麗な Markdown ファイル（`Year2026.md` / `Month202611.md` / `Fulldata.md`）を自動作成・更新できます。
5. **過去のXアーカイブ（ZIP）一括インポートツール同梱**
   - 過去の全ツイート履歴も、`importer/index.html` をブラウザで開くだけで EmDash（D1 + R2）や Markdown に一括取り込みできます。

---

## 🔑 事前に用意するもの（3つだけ！）

WordPress 版と違い、**レンタルサーバーや WordPress の用意は一切不要**です。

### ① Cloudflare の「Account ID」と「APIトークン」
1. [Cloudflare ダッシュボード](https://dash.cloudflare.com/) にログインします（無料アカウントでOK）。
   - ※ R2 を使うため、Cloudflare ダッシュボード左メニューの **「R2 Object Storage」** を一度開いて有効化（無料枠 10GB/月）しておいてください。
2. 左メニューの **「Workers & Pages」** を開き、画面右側に書いてある **「Account ID」** をメモします。
3. 右上の人型アイコン → **「My Profile」** → 左メニュー **「API Tokens」** → **「Create Token」** を開きます。
4. **「Edit Cloudflare Workers」** の横の **「Use template」** を押し、**「Permissions（権限）」** に以下の2つを **「+ Add more」** で追加します（これで GitHub Actions が D1 と R2 を自動作成できるようになります）：
   - `Account` / **`D1`** / **`Edit`**
   - `Account` / **`Workers R2 Storage`** / **`Edit`**
   - （※さらに `User` / `User Details` / `Read` と `User` / `Memberships` / `Read` も入れておくと確実です）
   - **Account Resources**: `Include` / `All accounts`
   - **Zone Resources**: `Include` / `All zones`
5. 一番下の「Continue to summary」→「Create Token」を押して表示された **APIトークン** をメモします。

### ② X (Twitter) の「Bearer Token」
1. [X Developer Portal](https://developer.x.com/en/portal/dashboard) で App の **「Keys and tokens」** タブを開きます。
2. **「Bearer Token」** を生成（Regenerate）してメモします。

### ③ （GitHubにもMarkdown保存したい人だけ）GitHub の「Personal Access Token」
- GitHub右上の自分のアイコン → **「Settings」** → 一番下の **「Developer settings」** → **「Personal access tokens」** → **「Tokens (classic)」** → **「Generate new token (classic)」** で **`repo`** にチェックを入れて発行し、`ghp_...` の文字列をメモします。

---

## 🚀 使い方（3ステップで完了！）

### ステップ1：このリポジトリを自分のGitHubにコピーする
1. このページ右上の **「Use this template」**（または **「Fork」**）ボタンを押して、自分のアカウントにリポジトリを作成します。

---

### ステップ2：GitHub に 4つの鍵（Secrets）を登録する
1. 自分のリポジトリ上部の **「Settings」** タブ → 左メニューの **「Secrets and variables」** → **「Actions」** を開きます。
2. 緑色の **「New repository secret」** ボタンを押して、以下の **4つ** を1つずつ登録します。

#### 【必須の4つ】

| Name（名前：コピペしてください） | Secret（入力する内容） |
| :--- | :--- |
| `CLOUDFLARE_API_TOKEN` | 準備①で取得した Cloudflare の APIトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 準備①で取得した Cloudflare の Account ID |
| `X_USERNAME` | あなたのXのID（`@`は付けない。例: `showya_kiss`） |
| `X_BEARER_TOKEN` | 準備②で取得した X API の Bearer Token |

#### 【任意：必要な人だけ追加】

| Name（名前） | Secret（入力する内容） |
| :--- | :--- |
| `GH_SYNC_TOKEN` | 準備③で取得した GitHub トークン（`ghp_...`）。登録すると `Year2026.md` 等が自動保存されます |
| `GH_SYNC_REPO` | Markdown保存先リポジトリ（例: `あなたのID/x-archive`）。未登録ならこのリポジトリ自身に保存されます |
| `TRIGGER_SECRET` | 管理画面やインポートAPIにパスワードをかけたい場合の任意の合言葉（未設定ならパスワードなし） |

---

### ステップ3：GitHub Actions を順番に2つ実行する

1. リポジトリ上部の **「Actions」** タブを開きます。
   - ※Forkした場合に緑色のボタン（`I understand my workflows, go ahead and enable them`）が出たら押して有効化します。
2. **【最初に1回だけ】EmDash サイト＋R2＋D1 を自動構築する**
   - 左メニューの **「1. Setup EmDash & R2/D1 (初回サイト構築)」** をクリックします。
   - 右側の **「Run workflow」** → 緑色の **「Run workflow」** を押します（サイトタイトルを変えたい場合は入力欄で自由に変更できます）。
   - 30秒ほどで緑色のチェックマーク ✅ になり、実行結果画面（Summary）に **あなたの EmDash サイトのURL（`https://emdash-xlog.xxxx.workers.dev`）** が表示されます！
3. **【自動取得スタート】X-Logger をデプロイする**
   - 左メニューの **「2. Deploy X-Logger (自動取得ワーカーのデプロイ)」** をクリックします。
   - 右側の **「Run workflow」** を押し、実行間隔（`cron_minutes`：デフォルトは `1` 分おき。X API の制限が気になる場合は `15` や `30` など）を指定して緑色の **「Run workflow」** を押します。
   - 緑色のチェックマーク ✅ が付けば完了です！

🎉 **これだけで、あなたの X ポストと画像・動画が自動的に R2 と D1 に蓄積され、作成された EmDash サイト上で日別アーカイブとしていつでも閲覧できるようになります！**

---

## 📦 おまけ：過去のXアーカイブ（ZIP）を一括インポートしたい場合

X公式からダウンロードした過去ログのZIPファイルを持っている場合は、同梱の [importer/index.html](importer/index.html) を使って一括で EmDash（D1 + R2）や Markdown に取り込めます。

1. このリポジトリをパソコンにダウンロード（Code → Download ZIP）して解凍し、`importer/index.html` をダブルクリックしてブラウザ（Chrome / Edge / Safari）で開きます。
2. 解凍したXアーカイブフォルダを選ぶと、`tweets.js` と `tweets_media/`（画像・動画）が自動で読み込まれます。
3. 画面下のボタンから、以下の好きな方法で出力できます：
   - **⚡ EmDash (D1 + R2) へ直接メディア＋日別記事を一括送信**（ステップ3で作成されたサイトURLを入力してボタンを押すだけ！）
   - **Cloudflare D1 インポート用 SQL (.sql) をダウンロード**
   - **GitHub 用 Markdown (.md) を生成してダウンロード**
