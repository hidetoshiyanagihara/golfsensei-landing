# AXION SALES SNS運用（X / Instagram / LinkedIn）

| ファイル | 内容 |
|---|---|
| [`STRATEGY.md`](STRATEGY.md) | 運用戦略（ターゲット・媒体の役割・投稿の柱・KPI・週次ルーティン・運用ルール） |
| [`PROFILES.md`](PROFILES.md) | 各 SNS のプロフィール文（貼り付け用） |
| [`../axion-sales.html`](../axion-sales.html) | SNS からの誘導先 LP（無料相談の申込） |
| `posts.csv` | 投稿予定（サンプル 2 週間分入り） |
| `main.py` ほか | 予約投稿ツール（下記） |

## 予約投稿ツール

Python。`posts.csv` に書いた投稿を、予定日時を過ぎたら各 SNS の**公式 API** で投稿し、`result.csv` に記録します。

### セットアップ

```bash
cd sns
pip install -r requirements.txt
cp .env.example .env    # 各 SNS の認証情報を記入（下記「API の準備」）
```

### 使い方

```bash
python main.py check                        # posts.csv の検査（文字数・日時・画像URL）
python main.py post --mode test             # テスト: API を呼ばず、投稿予定の本文を表示
python main.py post --mode test --platform x
python main.py post --mode live             # 本番: 予定日時を過ぎた未投稿分を投稿（yes の確認あり）
python main.py post --mode live --yes       # 定期実行用（確認なし）
python main.py status                       # 媒体ごとの予定・投稿済み・失敗の件数
```

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

30 分おきに `python main.py post --mode live --yes` を実行します。

- **Windows（タスクスケジューラ）**：「基本タスクの作成」→ 毎日・繰り返し間隔 30 分 →
  プログラム `python`、引数 `main.py post --mode live --yes`、開始 `C:\…\golfsensei-landing\sns`
- **Mac / Linux（cron）**：`*/30 * * * * cd /path/to/golfsensei-landing/sns && python3 main.py post --mode live --yes >> post.log 2>&1`

### 動作仕様

- 予定日時を過ぎた未投稿分を古い順に投稿。予定から 24 時間以上過ぎたものは自動では出さない
  （PC を止めていた後の一斉投稿を防ぐ。出す場合は予定日時を直す）
- 1 日の上限：X 5 件・Instagram 2 件・LinkedIn 2 件（`config.py`）。超えた分は翌日に回す
- 検査で問題がある投稿はスキップ、API エラーは失敗として記録し、次回の実行で再試行
  （同じスキップ・失敗は `result.csv` に重複して記録しない）
- テストモードの記録は本番の投稿済み判定に使わない（`モード` 列で区別）
- いいね・フォロー・DM の自動化はしない（各 SNS の規約違反になるため）

### API の準備

| 媒体 | 必要なもの | `.env` |
|---|---|---|
| X | [X Developer Portal](https://developer.x.com/) でアプリを作成し、User authentication で **Read and write** を有効化 → API Key/Secret と Access Token/Secret を発行（書き込み権限に変更した後に Access Token を再発行）。投稿 API の利用料金・上限は契約プランを確認 | `X_API_KEY` `X_API_SECRET` `X_ACCESS_TOKEN` `X_ACCESS_SECRET` |
| LinkedIn | [LinkedIn Developers](https://developer.linkedin.com/) でアプリを作成し、「Share on LinkedIn」と「Sign In with LinkedIn using OpenID Connect」を追加 → `w_member_social` 付きのアクセストークンを発行。個人の URN は `/v2/userinfo` の `sub` から `urn:li:person:{sub}`。トークンは約 60 日で期限切れになるので再発行する | `LINKEDIN_ACCESS_TOKEN` `LINKEDIN_AUTHOR_URN` |
| Instagram | Instagram をビジネスアカウントにして Facebook ページと連携 → [Meta for Developers](https://developers.facebook.com/) でアプリを作成し、`instagram_basic` `instagram_content_publish` `pages_show_list` の権限で長期アクセストークンを発行。IG ユーザー ID はページの `instagram_business_account` | `IG_USER_ID` `IG_ACCESS_TOKEN` |

`config.py` の `LINKEDIN_VERSION`（YYYYMM）と `INSTAGRAM_GRAPH_URL` のバージョンは、古くなると API が使えなくなるので年 1 回程度更新してください。

### テスト

```bash
python tests/run_tests.py    # オフライン。実際の SNS には投稿しない
```
