# AXION SALES SNS自動投稿 — 引き継ぎメモ

このファイルは、claude.ai で進めてきた作業を Claude Code で続けるための引き継ぎです。
（2026-10-23 時点。同日 Claude Code で golfsensei-landing リポジトリの `axion-autopost/` に設置）

## ユーザーについて
- 柳原秀俊（AXION SALES 代表、名古屋の営業代行。法人化前の個人事業）。やりとりは日本語
- 非エンジニア。手順は「どこを押すか」まで具体的に、1回に1ステップずつ案内する
- 選択肢を並べるより、こちらで決めて提案するのを好む
- APIキーやトークンはチャットに貼らせない。GitHubへの登録は `gh secret set 名前` を実行してもらい、値はユーザー本人がターミナルに貼る（Claude側で値を見ない・扱わない）

## このプロジェクトの目的
毎朝7:47（日本時間）に、AIが `brand.md` を読んでその日の投稿を作り、X・Instagram・LinkedIn に自動投稿する。
動かす場所は GitHub Actions（無料）。

## 構成
| ファイル | 役割 |
|---|---|
| `brand.md` | 発信設定（会社情報・ターゲット・テーマ・口調・禁止事項）。投稿内容はここで調整する |
| `autopost/generate.py` | Claude API（`claude-sonnet-5-5`）で3SNS分の文章をJSON生成。URL混入時は再生成 |
| `autopost/image_card.py` | Instagram/LinkedIn用の1080x1350 **JPEG** 画像（濃紺×ゴールド、文字のみ）をPillowで生成。Instagram APIはPNG不可 |
| `autopost/platforms.py` | X（OAuth1.0a, POST /2/tweets）、Instagram（graph.instagram.com, Instagramログイン版）、LinkedIn（/rest/posts, 個人アカウント投稿）|
| `autopost/main.py` | `generate` / `publish` コマンド。キー未設定のSNSはスキップ、成功済みSNSは再実行時スキップ |
| `../.github/workflows/axion_daily_post.yml` | 毎日 22:47 UTC 実行（working-directory: axion-autopost）。手動実行時は dry_run=1 で投稿せず生成のみ |
| `../.github/workflows/axion_refresh_ig_token.yml` | 毎週月曜にInstagramトークンを延長し、`gh secret set` で上書き（`GH_PAT` が必要）|
| `posts/日付.json` | 生成内容と各SNSの結果（`ok:` / `error:` / `skipped`）|
| `history.json` | 過去テーマ（直近30件を被り防止に使う）|
| `README.md` | ユーザー向けのセットアップ手順・運用・トラブル対応 |

| `tests/test_offline.py` | AI・SNSを差し替えた通しテスト |

Instagramは画像を公開URLから取りに来るため、画像をリポジトリにcommitして `raw.githubusercontent.com` のURL（サブフォルダ込み、`main.public_url`）を渡している。**リポジトリは Public 必須。**

同じリポジトリの `sns/`（posts.csv 方式の予約投稿）は旧方式。二重投稿を避けるため `sns-post.yml` の定期実行は停止済み。LP（`axion-sales.html`）・プロフィール文（`sns/PROFILES.md`）は引き続き使う。

## 進捗
| 項目 | 状態 |
|---|---|
| プログラム一式 | 完成。ダミーデータで生成→画像→投稿→失敗時リトライの流れを確認済み。**実APIでの投稿テストは未実施** |
| Instagram | ✅ Metaアプリ「AXION SALES 自動投稿」作成済み（Instagramログイン版API）。axion_sales をInstagramテスターとして承認済み。権限 `instagram_business_basic` / `instagram_business_content_publish` 追加済み。**トークン取得済み（ユーザーのメモ帳に保管）** |
| X | ✅ console.x.com で開発者登録済み（@axion_sales）。OAuth1.0a 権限「読み取りと書き込み」。**キー4つ取得済み（メモ帳に保管）**。クレジット$5購入済み、自動チャージはオフ |
| LinkedIn | ⏸ 保留。会社ページ作成時に「つながりの数が不足」で作れず。つながりが10人前後になったら再挑戦 |
| Anthropic APIキー | ❌ 未取得 |
| GitHub | ✅ アカウントあり（hidetoshiyanagihara）。新規リポジトリは作らず golfsensei-landing（Public）の `axion-autopost/` に設置。❌ Secrets登録は未 |
| 画像形式 | ✅ PNG→JPEG に修正（Instagram APIはJPEGのみ）|

## 次にやること（この順で）
1. **Anthropic APIキー取得**：console.anthropic.com → API Keys。Billingで$5程度購入
2. ~~GitHub リポジトリ作成~~（golfsensei-landing に設置済み）
3. **Secrets登録**（ユーザーが https://github.com/hidetoshiyanagihara/golfsensei-landing/settings/secrets/actions で値を貼る）
   - `ANTHROPIC_API_KEY`
   - `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET`
   - `IG_ACCESS_TOKEN`
   - `GH_PAT`（Fine-grained token、golfsensei-landing のみ、Secrets: Read and write）
4. **テスト**：`gh workflow run daily_post.yml -f dry_run=1` → `posts/` と `images/` の中身を確認 → `dry_run=0` で実投稿
5. 実投稿で失敗したら、`posts/日付.json` のエラーを見て修正
6. 後日 **LinkedIn**：会社ページ作成 → developer app（Share on LinkedIn ＋ Sign In with LinkedIn using OpenID Connect）→ OAuth Token Tools でスコープ `openid profile w_member_social` のトークン発行 → `LI_ACCESS_TOKEN` 登録

## 注意点
- **X**：2026-10-23 に OAuth 2.0 のクライアントシークレットがスクショ経由でチャットに出た。本システムでは使わないが、再生成済みか確認すること（console.x.com → アプリ → キー → クライアントシークレット「再生成」）
- **X**：OAuth 2.0 側のアクセストークンは使わない（OAuth 1.0 キーのみ使用）
- **Instagram**：Metaアプリは「未公開（開発モード）」のまま。自社アカウントへの投稿だけなら開発モードで動く想定。`IG_API_VERSION` の既定は `v23.0`
- **Instagram**：トークンは60日有効で、週1で自動延長。ただし `GH_PAT` が未登録だと延長に失敗する
- **LinkedIn**：トークンは60日で切れ、自動延長できない。手動で再発行が必要。`LI_API_VERSION` の既定は `202606`。「version is not active」と出たら新しい年月に変更する
- 投稿内容の禁止事項（実績・数字・顧客の声の捏造、成果の断定、他社批判、電話番号・住所・URL）は `brand.md` に記載済み。勝手に緩めない
- 費用の目安：Claude API 月数百円、X 1投稿 $0.015、その他は無料
