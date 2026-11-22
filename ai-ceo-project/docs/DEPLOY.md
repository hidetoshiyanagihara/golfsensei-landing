# スマホから使えるようにする（Netlify ＋ Turso）

## いまの本番環境（2026-11-22 公開）

| | 内容 |
|---|---|
| URL | **https://ai-ceo-command.netlify.app** |
| 画面を置く場所 | Netlify（無料）サイト名 `ai-ceo-command` |
| データの保存先 | Turso（無料）データベース `ai-ceo`（米国東部・オハイオ。Netlify の処理と同じ地域） |
| ログイン | パスワードは Netlify の **Project configuration → Environment variables → `ADMIN_PASSWORD`** で確認・変更できる（変更したら再公開が必要） |
| Netlify のサイト保護 | 本番は管理画面のログインで保護。プレビュー版（本番以外）は Netlify のログイン保護を残している |
| 公開のしかた | GitHub とは連携していない（ボットの毎日のコミットで無料枠を使わないため）。管理画面を変えたときに `bash scripts/deploy-netlify.sh` で公開する（Claude が実行） |
| 公開前の確認 | Turso のテスト用データベースで、ブラウザの通しテスト43項目に合格してから公開した |

以下は、最初に検討・作成したときの記録です。

2026-11-22 代表者決定：「スマホでも見れるようにする」。

## なぜこの組み合わせか

| | 選んだもの | 理由 |
|---|---|---|
| 画面を置く場所 | **Netlify（無料プラン）** | 無料プランで**商用利用OK**。Next.js に公式対応。※Vercel の無料プラン（Hobby）は「個人・非商用のみ」のため、事業の管理画面には使えない |
| データの保存先 | **Turso（無料プラン）** | 今の SQLite と同じ形式で、コードの変更が最小。無料枠（目安：DB 100個・5GB・月5億行の読み取り）は1人の管理画面には十分。クレジットカード不要 |

**費用：0円**（どちらも無料枠）。
- Netlify の無料プランは月300クレジットまで（超えると翌月までサイトが止まる。勝手に課金はされない）。本番の更新1回で約15クレジットかかるため、**このフォルダ（ai-ceo-project）に変更があったときだけ更新する設定**にしてある（`netlify.toml`）。毎日のボットのコミットでは更新しない。
- 料金や無料枠は変わることがあるので、申し込み時に各社の料金ページで確認する。

## 安全のために

- 管理画面はインターネットに公開されるので、**パスワードは16文字以上**で、他で使っていないものにする（パスワード管理アプリの自動生成がおすすめ）。
- ログインは「同じ接続元から5回失敗」または「全体で30回失敗」で15分止まる。
- 検索エンジンには載らない設定（noindex）。通信は常に https。
- 保存するのは売上・費用・投稿の記録など。顧客の氏名・メールアドレスなどの個人情報は保存しない設計。
- パスワード・トークンは **Netlify の画面にだけ**入力する。チャットやリポジトリには書かない。

---

## 手順

### 準備：このフォルダを main ブランチに取り込む
Netlify は main ブランチの内容を公開します。（取り込みは Claude に依頼できます）

### STEP 1：Turso でデータベースを作る（約5分）
1. https://turso.tech を開き、右上の **Sign up** → **Continue with GitHub**
2. ダッシュボードの **Create Database**（または「New Database」）を押す
3. 名前：`ai-ceo`、場所（Location / Region）：**US East（Ohio または Virginia）**
   - Netlify の処理は米国東部で動くため、近くに置くと画面が速くなります
4. できたデータベースを開き、次の2つを控える（メモ帳でOK。チャットには貼らない）
   - **URL**（`libsql://ai-ceo-〇〇.turso.io` の形）
   - **Create Token**（または「Generate Token」）を押して出る長い文字列（期限：なし／Read & Write）

### STEP 2：Netlify にサイトを作る（約10分）
1. https://app.netlify.com を開き、**Sign up** → **GitHub** でログイン
2. **Add new project**（または「Add new site」）→ **Import an existing project** → **GitHub**
3. リポジトリ一覧から **golfsensei-landing** を選ぶ（出てこないときは「Configure the Netlify app on GitHub」から、このリポジトリへのアクセスを許可）
4. 設定画面で：
   - **Branch to deploy**：`main`
   - **Base directory**：`ai-ceo-project` ← ここが一番大事
   - Build command / Publish directory は自動で入る（`npm run build` / `.next`）
5. 同じ画面の **Add environment variables**（環境変数）に3つ入れる

   | Key | Value |
   |---|---|
   | `ADMIN_PASSWORD` | ログイン用のパスワード（16文字以上） |
   | `TURSO_DATABASE_URL` | STEP 1 で控えた URL |
   | `TURSO_AUTH_TOKEN` | STEP 1 で控えたトークン |

6. **Deploy** を押す。2〜5分で `https://〇〇〇.netlify.app` のURLができる
7. （任意）**Site configuration → Change site name** で、覚えやすい名前（例：`ai-ceo-command`）に変える

### STEP 3：スマホで開く
1. スマホで Netlify のURLを開き、パスワードでログイン
2. iPhone：共有ボタン →「ホーム画面に追加」／Android：メニュー →「ホーム画面に追加」
3. コンテンツ画面の **「自動投稿の結果を取り込む」** を押す（AXION SALES の投稿実績が入る）

### うまくいかないとき
- ログイン画面に「初期設定が必要です」と出る → 環境変数の名前のつづり・パスワードの長さ（12文字以上）を確認し、**Deploys → Trigger deploy** でもう一度デプロイ
- 「処理に失敗しました」やエラー画面 → Turso の URL・トークンを貼り直す（前後に空白が入っていないか）
- パスワードを変えたい → Netlify の環境変数 `ADMIN_PASSWORD` を変えて再デプロイ（今までのログインはすべて無効になる）

## パソコンのデータを本番に移したいとき
パソコンで記録した実データを Turso に移す機能はまだありません（PHASE 1 のデータは試験用のため、本番は新しく始める想定）。必要になったら Claude に依頼してください。
