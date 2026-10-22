# 全自動投稿の始め方（APIキーの取得と登録）

最初に一度だけ設定すれば、あとは **GitHub が 30 分おきに `posts.csv` を確認して自動で投稿**します。
PC の電源を入れておく必要も、Python を入れる必要もありません。

```
posts.csv に投稿を書く → GitHub に保存 → GitHub Actions が予定時刻に投稿 → 記録は sns-log ブランチへ
```

## 全体の流れ

| 順番 | やること | 所要時間 | 期限 |
|---|---|---|---|
| 1 | X のキーを取得 → GitHub に登録 | 20 分 | なし |
| 2 | Instagram のキーを取得 → GitHub に登録 | 40 分 | なし（ページトークンを使う） |
| 3 | LinkedIn のキーを取得 → GitHub に登録 | 20 分 | **60 日ごとに更新が必要** |
| 4 | 「SNS 接続チェック」を実行して確認 | 2 分 | — |

**1 媒体ずつ始めて大丈夫です。** キーを登録していない媒体の投稿は、失敗にならず「保留」になります。
まずは X だけ設定して動かし、慣れたら Instagram・LinkedIn を足すのがおすすめです。

> キーはパスワードと同じです。GitHub の「Secrets」以外（チャット、メール、posts.csv など）には貼らないでください。

---

## GitHub への登録方法（各媒体で共通）

1. https://github.com/hidetoshiyanagihara/golfsensei-landing を開く
2. 上のタブの **Settings** → 左メニューの **Secrets and variables** → **Actions**
3. **New repository secret** を押す
4. **Name** に下の表の名前（例 `X_API_KEY`）、**Secret** に値を貼って **Add secret**
5. 必要な数だけ繰り返す

---

## 1. X（Twitter）

**必要なもの**：X のアカウント（AXION SALES 用）

1. AXION SALES のアカウントでログインした状態で https://developer.x.com/ を開き、**Developer Portal** へ
2. 利用プランを選ぶ（無料枠・従量課金など。投稿に使える件数と料金は画面の最新情報を確認。平日 1 本程度なら少量の枠で足ります）
3. 利用目的を聞かれたら、例えば次のように入力
   > I will use the API to publish scheduled posts about my sales outsourcing business to my own account. No data collection or automated engagement.
4. **Projects & Apps** でアプリ（プロジェクトの中に自動で作られている場合はそれ）を開く
5. **User authentication settings** → **Set up**
   - App permissions：**Read and write**
   - Type of App：**Web App, Automated App or Bot**
   - Callback URI：`https://golfsensei-landing.vercel.app/`
   - Website URL：`https://golfsensei-landing.vercel.app/axion-sales.html`
   - 保存
6. **Keys and tokens** タブ
   - **API Key and Secret** → Regenerate → 2 つをメモ
   - **Access Token and Secret** → Generate → 2 つをメモ
     （必ず手順 5 で Read and write にした **後に** 発行する。先に発行したものは投稿できません）
7. GitHub に登録

| Name | 値 |
|---|---|
| `X_API_KEY` | API Key |
| `X_API_SECRET` | API Key Secret |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_SECRET` | Access Token Secret |

---

## 2. Instagram

**必要なもの**：Instagram アカウント、Facebook アカウント、Facebook ページ

### 2-1. アカウントの準備（スマホで 10 分）
1. Instagram アプリ → プロフィール → ≡ → **アカウントの種類とツール** → **プロアカウントに切り替える** → **ビジネス**
2. Facebook で AXION SALES の **Facebook ページ** を作る（無ければ。https://www.facebook.com/pages/create ）
3. Instagram アプリ → プロフィールを編集 → **ページ** → 2 のページとリンク

### 2-2. アプリを作る
1. https://developers.facebook.com/ に Facebook でログイン → **マイアプリ** → **アプリを作成**
2. ユースケースは「**Instagram でメッセージとコンテンツを管理**」（または「その他」→ タイプ「ビジネス」）を選び、アプリ名は `AXION SALES Poster` など
3. 作成後のダッシュボードで、Instagram（Instagram Graph API）を **設定** に追加

### 2-3. 期限のないトークンを取る
1. https://developers.facebook.com/tools/explorer/ （グラフ API エクスプローラ）を開く
2. 右側の「Meta アプリ」で 2-2 のアプリを選ぶ
3. 「アクセス許可を追加」で次の 4 つにチェック
   `instagram_basic` `instagram_content_publish` `pages_show_list` `pages_read_engagement`
4. **Generate Access Token** → Facebook の確認画面で、2-1 のページと Instagram アカウントを選んで許可
5. 表示されたトークンの左の **ⓘ** → **アクセストークンツールで開く** → 一番下の **アクセストークンを延長** → 表示された長いトークンをコピー（約 60 日有効）
6. エクスプローラに戻り、トークン欄に 5 のトークンを貼り付け、上の入力欄に次を入れて **送信**
   ```
   me/accounts?fields=name,access_token,instagram_business_account
   ```
7. 結果の中から AXION SALES のページを探し、次の 2 つをメモ
   - `access_token`（**ページのトークン。期限なし**）
   - `instagram_business_account` の `id`（17 から始まる数字）
8. GitHub に登録

| Name | 値 |
|---|---|
| `IG_ACCESS_TOKEN` | 手順 7 の `access_token` |
| `IG_USER_ID` | 手順 7 の `instagram_business_account` の `id` |

> Facebook のパスワードを変えたり、アプリの権限を外したりするとトークンは無効になります。その場合は 2-3 をやり直してください。

---

## 3. LinkedIn

**必要なもの**：LinkedIn の個人アカウント（柳原さん）

1. https://www.linkedin.com/developers/apps → **Create app**
   - App name：`AXION SALES Poster`
   - LinkedIn Page：会社ページが必要です。無ければ https://www.linkedin.com/company/setup/new/ で「AXION SALES」のページを作ってから選ぶ
   - ロゴ：任意の画像で可
2. 作成後、**Products** タブで次の 2 つの **Request access**
   - **Share on LinkedIn**
   - **Sign In with LinkedIn using OpenID Connect**
3. **Auth** タブ → **OAuth 2.0 tools** の **Create token**（または https://www.linkedin.com/developers/tools/oauth/token-generator ）
   - アプリを選び、スコープ `openid` `profile` `w_member_social` にチェック → **Request access token** → 許可
   - 表示された **Access token** をコピー
4. 投稿者 ID（URN）を調べる：同じトークン生成画面の **Token inspector**、または下の「4. 確認」の接続チェックを先に実行すると、ログに `urn:li:person:…` が表示されます
5. GitHub に登録

| Name | 値 |
|---|---|
| `LINKEDIN_ACCESS_TOKEN` | 手順 3 のトークン |
| `LINKEDIN_AUTHOR_URN` | `urn:li:person:` + ID（手順 4） |

> **LinkedIn のトークンは 60 日で切れます。** 切れると投稿が「失敗」になり、GitHub から失敗通知メールが届きます。
> そのときは手順 3 でトークンを作り直し、`LINKEDIN_ACCESS_TOKEN` を更新してください（Secrets の一覧で鉛筆マーク → 値を貼り直し）。

---

## 4. 確認

1. GitHub のリポジトリ → **Actions** タブ
   （初めてのときは「I understand my workflows, go ahead and enable them」を押す）
2. 左の **SNS 接続チェック** → **Run workflow** → **Run workflow**
3. 1 分ほどで結果が出ます。開いて「接続チェック」のログを見る
   - `OK     X: @アカウント名` → 準備完了
   - `未設定` → まだ登録していない媒体（後回しで OK）
   - `NG` → キーの貼り間違い・権限不足。エラー文を見て該当の手順をやり直す

すべて OK になれば、あとは **SNS 予約投稿** が 30 分おきに自動で動きます。
すぐに試したいときは **SNS 予約投稿** → **Run workflow** で手動実行もできます。

---

## 毎週やること（運用が始まったら）

1. GitHub で `sns/posts.csv` を開き、鉛筆マークで翌週分の投稿を追加 → **Commit changes**
   （ID は続き番号、予定日時は `2026-11-16 07:30` 形式、改行は `\n`）
2. Instagram 用の画像が必要なときは Claude に「P020 の画像を作って」と頼む
3. 投稿の結果は `sns-log` ブランチの `result.csv` で確認できます

## よくあるトラブル

| 症状 | 対処 |
|---|---|
| X で `403` | Read and write に変更した後に Access Token を作り直したか確認 |
| X で `402` / `429` | 利用プランの投稿上限・クレジット不足。Developer Portal で確認 |
| Instagram で `image_url` のエラー | 画像が公開されていない。main ブランチに画像が入っているか確認 |
| LinkedIn で `401` | トークン切れ（60 日）。手順 3 で作り直す |
| 何も投稿されない | 予定日時が過去 24 時間より前（自動では出さない）。日時を直す |
| Actions が止まった | 60 日間リポジトリに更新が無いと GitHub が定期実行を止めます。Actions タブで再度有効化 |
