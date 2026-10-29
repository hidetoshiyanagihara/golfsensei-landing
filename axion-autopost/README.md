# AXION SALES SNS自動投稿

毎朝7:47に、AIが `prompt.md` に沿ってその日の投稿を作り、X・Instagramに自動投稿します（LinkedInは準備中）。
動かす場所はGitHub（無料）。パソコンを点けておく必要はありません。

- Instagramには文字入りの画像（自動生成）＋キャプション
- LinkedInには画像＋本文（柳原さん個人のアカウントから投稿）
- Xには短い本文のみ
- キーを設定していないSNSは飛ばすので、準備できたものから順に始められます

テスト：`python tests/test_offline.py`（AI・SNSのAPIは差し替えるので何も投稿しません）

**費用の目安（月）**：Claude API 数百円 ／ X 約30投稿×$0.015 ≒ 70円 ／ その他 無料

---

## 準備（PCで作業。全部で1〜2時間）

### 1. GitHubに置く（設置済み・作業なし）
このフォルダは、既にある公開リポジトリ **hidetoshiyanagihara/golfsensei-landing** の `axion-autopost/` に置いてあります。
自動実行の設定（`.github/workflows/axion_daily_post.yml` と `axion_refresh_ig_token.yml`）も入っています。
（Instagramが画像を取りに来るため、リポジトリは Public のままにしてください。キー類は下の「Secrets」に入れるので公開されません）

### 2. 各キーを取得して、GitHubに登録する
登録場所：https://github.com/hidetoshiyanagihara/golfsensei-landing/settings/secrets/actions → **New repository secret**
（名前は下の表の通り、一字一句同じに）

| 名前 | 取得方法 |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys で作成。Billingで$5ほどクレジット購入 |
| `X_API_KEY` / `X_API_SECRET` | console.x.com でアプリ作成 → Keys and tokens |
| `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | **先に** User authentication settings で権限を「Read and write」にしてから発行（順番が逆だと投稿できません）。クレジットも少額購入 |
| `IG_ACCESS_TOKEN` | AXION SALES のInstagramをビジネスアカウントにする → Meta for Developers でアプリ作成 → Instagram →「API Setup with Instagram Login」→ アカウント追加 →「トークンを生成」 |
| `LI_ACCESS_TOKEN` | 下の「LinkedIn」参照 |
| `GH_PAT` | GitHub右上アイコン → Settings → Developer settings → Fine-grained tokens → Repository access で **golfsensei-landing** だけ選択、Permissions の **Secrets** を Read and write にして作成（Instagramトークンの自動延長に使います） |

**LinkedIn**
1. AXION SALES の会社ページを作る（アプリ作成に必須）
2. linkedin.com/developers/apps → Create app → 会社ページを紐付け → Settings で Verify
3. Products タブで「Share on LinkedIn」と「Sign In with LinkedIn using OpenID Connect」を追加
4. 開発者ポータル上部「Docs and tools」→「OAuth Token Tools」→ Create token
   スコープは `openid` `profile` `w_member_social` の3つにチェック → 出たトークンを登録

**YouTube（ショート動画）**
その日の投稿と同じテーマで、AXION SALES のキャラクター2人（アポくん・つながりちゃん）が会話する縦長動画（20〜40秒）を作り、ショートとして投稿します。会話はAIが `prompt.md` の11章に沿って作ります。動画はリポジトリに残しません。
BGMは毎回オリジナル曲を自動で作曲して流します（ポップ／ダンス／チルが日替わり。著作権の申し立ては来ません）。好きな曲に固定したいときは、使ってよい曲（YouTubeオーディオライブラリなど）を `bgm.mp3` として `axion-autopost/` に置くと、そちらが優先されます。ヒット曲は自動投稿では使えません（音が消される・著作権の違反が付く）。
1. AXION SALES の YouTube チャンネルを作る
   - YouTube Studio →「カスタマイズ」→「プロフィール」→「リンク」に LP を追加（タイトル「無料リスト20件のお申し込み」、URL `https://axionsales.vercel.app/youtube`）。YouTubeにはDMがなく、ショートの説明欄のURLは押せないため、動画の最後は「チャンネルのリンクから申し込んでね」と案内しています
2. console.cloud.google.com でプロジェクトを作り、「YouTube Data API v3」を有効にする
3. 「OAuth 同意画面」を作成（外部）→ 公開ステータスを **本番環境** にする（テストのままだとトークンが7日で切れます）
4. 「認証情報」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」、承認済みのリダイレクト URI に `https://developers.google.com/oauthplayground` を追加して作成
5. developers.google.com/oauthplayground を開き、右上の歯車 →「Use your own OAuth credentials」に 4 のクライアントID・シークレットを入れる
   → 左の一覧で `https://www.googleapis.com/auth/youtube.upload` を選び「Authorize APIs」→ チャンネルのアカウントで許可 →「Exchange authorization code for tokens」
6. 次の3つを登録：`YT_CLIENT_ID`（4のクライアントID）／`YT_CLIENT_SECRET`（4のシークレット）／`YT_REFRESH_TOKEN`（5の Refresh token）

最初は限定公開で試したいときは、Settings → Secrets and variables → Actions → **Variables** に `YT_PRIVACY` = `unlisted` を追加（消すと公開に戻ります）。

### 3. テストする
1. リポジトリの **Actions** タブ → 「Daily SNS post」→「Run workflow」
2. dry_run は `1` のまま実行 → 数分後、`axion-autopost/images/` に画像、`axion-autopost/posts/` に3SNS分の文章ができていれば成功（投稿はされません）
3. 中身に問題なければ、もう一度 dry_run を `0` にして実行 → 実際に投稿されます

あとは毎朝自動で動きます。

---

## 運用

- **投稿の中身・口調を変えたい** → `prompt.md` を書き換えるだけ（GitHub上で鉛筆アイコンから直接編集できます）
- **最近の出来事・気づきを投稿に入れたい** → `memo.md` に一言書く（翌朝の投稿に反映。使い終わったら消す）
- **書き換えた結果を試したい** → Actions →「Daily SNS post」→「Run workflow」で dry_run に `preview` と入れて実行（保存も投稿もせず、文章だけ表示）
- **投稿時刻を変えたい** → `.github/workflows/axion_daily_post.yml` の `cron`（日本時間−9時間で書く）
- **投稿した内容の確認** → `axion-autopost/posts/日付.json`（成功なら `ok:`、失敗なら理由が書いてあります）
- **失敗したら** → GitHubから通知メールが届きます。Actions で「Re-run jobs」すれば、成功済みのSNSは飛ばして失敗分だけやり直します
- **止めたい** → Actions → Daily SNS post → 右上「…」→ Disable workflow

### フォローする相手リスト（毎朝）
営業代行を必要としていそうな会社・人（中小企業向けSaaSの社長・営業責任者、資金調達や営業募集を発表した会社の公式など）を、毎朝AIが探してリストにします。
**見る場所**：https://github.com/hidetoshiyanagihara/golfsensei-landing/blob/main/axion-autopost/follow/latest.md （スマホのブックマークにどうぞ）
リンクを押して「フォロー」を押すだけ。1日 X 7人・Instagram 3人まで、一度載せた相手は二度と載せません（`follow/history.json`）。
自動でフォローはしません（Instagram・Xの規約違反になり、アカウントが止められると自動投稿も止まるため）。

### 定期的にやること
- **LinkedIn：60日ごとにトークン再発行**（LinkedInの仕様で自動延長できません）。上の手順4をやり直して `LI_ACCESS_TOKEN` を上書き
- Instagram：毎週月曜に自動で延長されるので不要
- 各サービスのクレジット残高をたまに確認

### うまくいかないとき
| 症状 | 対処 |
|---|---|
| X「403」 | アクセストークンを権限変更前に作った → 再発行して登録し直す |
| Instagram「画像URLにアクセスできません」 | リポジトリがPrivateになっている → Publicに |
| Instagram「Only photo or video can be accepted」など画像形式のエラー | 画像はJPEGで作っています。`images/` の拡張子が `.jpg` か確認 |
| LinkedIn「401」 | トークン切れ → 再発行 |
| LinkedIn「version is not active」 | Secretsに `LI_API_VERSION` を追加し、最近の年月（例 `202609`）を入れる |
| Instagramトークン延長が失敗 | トークンが切れている → 手動で再発行して `IG_ACCESS_TOKEN` を上書き |
