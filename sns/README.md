# AXION SALES SNS運用（X / Instagram / LinkedIn）

> **自動投稿は [`../axion-autopost/`](../axion-autopost/)（毎朝AIが投稿を作る方式）に一本化しました。**
> このフォルダの予約投稿ツール（posts.csv 方式）は定期実行を止めています。戦略・プロフィール文は引き続き使えます。

| ファイル | 内容 |
|---|---|
| [`API_SETUP.md`](API_SETUP.md) | **全自動投稿の始め方**（APIキーの取得手順と GitHub への登録） |
| [`STRATEGY.md`](STRATEGY.md) | 運用戦略（ターゲット・媒体の役割・投稿の柱・KPI・週次ルーティン・運用ルール） |
| [`PROFILES.md`](PROFILES.md) | 各 SNS のプロフィール文（貼り付け用） |
| [`../axion-sales.html`](../axion-sales.html) | SNS からの誘導先 LP（無料相談の申込） |
| `posts.csv` | 投稿予定（サンプル 2 週間分入り） |
| `cards.csv` → `images/` | Instagram 用画像の内容 → 生成した画像（1080×1350 JPEG） |
| `main.py` ほか | 予約投稿ツール（下記） |

## 予約投稿ツール

Python。`posts.csv` に書いた投稿を、予定日時を過ぎたら各 SNS の**公式 API** で投稿し、`result.csv` に記録します。

### セットアップ

```bash
cd sns
pip install -r requirements.txt
playwright install chromium   # 画像生成用（form_sender でインストール済みなら不要）
cp .env.example .env          # 各 SNS の認証情報を記入（下記「API の準備」）
python main.py verify         # 認証情報を確認し、LinkedIn の URN・IG ユーザーID・長期トークンを自動で記入
```

### 使い方

```bash
python main.py check                        # posts.csv の検査（文字数・日時・画像URL）
python main.py post --mode test             # テスト: API を呼ばず、投稿予定の本文を表示
python main.py post --mode test --platform x
python main.py post --mode live             # 本番: 予定日時を過ぎた未投稿分を投稿（yes の確認あり）
python main.py post --mode live --yes       # 定期実行用（確認なし）
python main.py status                       # 媒体ごとの予定・投稿済み・失敗の件数
python main.py verify                       # 認証情報の確認（ID の自動記入も）
python main.py images [P020 ...]            # cards.csv から画像を生成し、posts.csv の画像URLを記入
```

### Instagram 用画像（cards.csv）

| 列 | 内容 |
|---|---|
| `ID` | posts.csv の Instagram 投稿と同じ ID |
| `ラベル` | 左上のタグ（例 `保存版`） |
| `見出し` | 大見出し。改行は `\n`、`**ここ**` はオレンジで強調 |
| `項目` | 番号付きの項目。`\|` で区切る（項目内の改行は `\n`） |
| `結び` | 下部のひとこと（`**強調**` 可） |

`python main.py images` で `images/ID.jpg` を作り、posts.csv の空の画像URLに
`https://golfsensei-landing.vercel.app/sns/images/ID.jpg` を入れます。
**画像は main ブランチにマージ（push）して Vercel に公開されてから投稿されるようにしてください**（Instagram はその URL から画像を取りに行きます）。

### posts.csv

| 列 | 内容 |
|---|---|
| `ID` | 任意の一意な ID（例 `P018`）。同じ ID・媒体は二度投稿しない |
| `予定日時` | `2026-11-16 07:30` 形式 |
| `媒体` | `x` / `instagram` / `linkedin`（1 行に 1 媒体） |
| `本文` | 改行は `\n`。`{LP}` は `LP URL?src=媒体` に置換される |
| `画像URL` | Instagram は必須（https:// で公開されている JPEG）。X・LinkedIn は未使用 |

Excel で編集する場合は「CSV UTF-8」形式で保存してください。

### 定期実行

**おすすめ：GitHub Actions（PC 不要）**。`.github/workflows/sns-post.yml` が 30 分おきに日本時間で投稿します。
認証情報はリポジトリの Secrets に登録し、投稿記録は `sns-log` ブランチの `result.csv` に保存されます。
手順は [`API_SETUP.md`](API_SETUP.md)。認証情報の確認は Actions の「SNS 接続チェック」から。

自分の PC で動かす場合は、30 分おきに `python main.py post --mode live --yes` を実行します
（GitHub Actions と併用すると記録が別々になり二重投稿になるので、どちらか一方にしてください）。

- **Windows（タスクスケジューラ）**：「基本タスクの作成」→ 毎日・繰り返し間隔 30 分 →
  プログラム `python`、引数 `main.py post --mode live --yes`、開始 `C:\…\golfsensei-landing\sns`
- **Mac / Linux（cron）**：`*/30 * * * * cd /path/to/golfsensei-landing/sns && python3 main.py post --mode live --yes >> post.log 2>&1`

### 動作仕様

- 予定日時を過ぎた未投稿分を古い順に投稿。予定から 24 時間以上過ぎたものは自動では出さない
  （PC を止めていた後の一斉投稿を防ぐ。出す場合は予定日時を直す）
- 1 日の上限：X 5 件・Instagram 2 件・LinkedIn 2 件（`config.py`）。超えた分は翌日に回す
- 認証情報が 1 つも設定されていない媒体は「保留」（失敗にしない。1 媒体ずつ始められる）
- 検査で問題がある投稿はスキップ、API エラーは失敗として記録し、次回の実行で再試行
  （同じスキップ・失敗は `result.csv` に重複して記録しない）
- テストモードの記録は本番の投稿済み判定に使わない（`モード` 列で区別）
- いいね・フォロー・DM の自動化はしない（各 SNS の規約違反になるため）

### API の準備

| 媒体 | 必要なもの | `.env` |
|---|---|---|
| X | [X Developer Portal](https://developer.x.com/) でアプリを作成し、User authentication で **Read and write** を有効化 → API Key/Secret と Access Token/Secret を発行（書き込み権限に変更した後に Access Token を再発行）。投稿 API の利用料金・上限は契約プランを確認 | `X_API_KEY` `X_API_SECRET` `X_ACCESS_TOKEN` `X_ACCESS_SECRET` |
| LinkedIn | [LinkedIn Developers](https://developer.linkedin.com/) でアプリを作成し、「Share on LinkedIn」と「Sign In with LinkedIn using OpenID Connect」を追加 → `w_member_social` 付きのアクセストークンを発行。`LINKEDIN_AUTHOR_URN` は `verify` が自動で記入する。トークンは約 60 日で期限切れになるので再発行する | `LINKEDIN_ACCESS_TOKEN` `LINKEDIN_AUTHOR_URN` |
| Instagram | Instagram をビジネスアカウントにして Facebook ページと連携 → [Meta for Developers](https://developers.facebook.com/) でアプリを作成し、グラフ API エクスプローラで `instagram_basic` `instagram_content_publish` `pages_show_list` 付きのユーザートークンを発行。`FB_APP_ID` `FB_APP_SECRET`（アプリの設定 → ベーシック）も入れておくと、`verify` が長期トークン（約60日）への交換と IG ユーザーID の取得を自動で行う | `IG_ACCESS_TOKEN` `FB_APP_ID` `FB_APP_SECRET`（`IG_USER_ID` は自動） |

`config.py` の `LINKEDIN_VERSION`（YYYYMM）と `INSTAGRAM_GRAPH_URL` のバージョンは、古くなると API が使えなくなるので年 1 回程度更新してください。

### テスト

```bash
python tests/run_tests.py    # オフライン。実際の SNS には投稿しない
```
