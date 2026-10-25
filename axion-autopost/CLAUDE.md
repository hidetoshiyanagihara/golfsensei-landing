# AXION SALES SNS自動投稿 — 引き継ぎメモ

このファイルは、claude.ai で進めてきた作業を Claude Code で続けるための引き継ぎです。
（2026-10-23 時点。同日 Claude Code で golfsensei-landing リポジトリの `axion-autopost/` に設置）

## ユーザーについて
- 柳原秀俊（AXION SALES 代表、名古屋の営業代行。法人化前の個人事業）。やりとりは日本語
- 非エンジニア。手順は「どこを押すか」まで具体的に、1回に1ステップずつ案内する
- 選択肢を並べるより、こちらで決めて提案するのを好む
- APIキーやトークンはチャットに貼らせない。GitHubへの登録は `gh secret set 名前` を実行してもらい、値はユーザー本人がターミナルに貼る（Claude側で値を見ない・扱わない）

## このプロジェクトの目的
毎朝7:47（日本時間）に、AIが `prompt.md`（ユーザー作成の投稿プロンプト）に沿ってその日の投稿を作り、X・Instagram に自動投稿する。
動かす場所は GitHub Actions（無料）。

## 構成
| ファイル | 役割 |
|---|---|
| `prompt.md` | システムプロンプト（使っていい事実・曜日別テーマ・型・禁止事項・自己チェック・出力JSON）。ユーザーが2026-10-23に作成。`{{today}}` `{{weekday}}` `{{recent_posts}}` `{{memo}}` だけ差し込み、他の `{{ }}` は指示文として残す |
| `memo.md` | 追加メモ（任意）。代表の最近の気づき。空なら「（なし）」 |
| `autopost/generate.py` | Claude API（`claude-sonnet-5-5`）でX・Instagramの文章をJSON生成。X140字超・URL・禁止表現・自己チェック3点以下は再生成（最大3回） |
| `autopost/image_card.py` | Instagram/LinkedIn用の1080x1350 **JPEG** 画像（濃紺×ゴールド、文字のみ）をPillowで生成。Instagram APIはPNG不可 |
| `autopost/platforms.py` | X（OAuth1.0a, POST /2/tweets）、Instagram（graph.instagram.com, Instagramログイン版）、LinkedIn（/rest/posts, 個人アカウント投稿）|
| `autopost/main.py` | `generate` / `publish` / `preview` コマンド。直近14日の投稿を被り防止に渡す。キー未設定のSNSはスキップ、成功済みSNSは再実行時スキップ。LinkedIn用本文は現プロンプトでは作らない |
| `../.github/workflows/axion_daily_post.yml` | 毎日 22:47 UTC 実行（working-directory: axion-autopost）。手動実行は dry_run=1 生成のみ／0 投稿／preview 表示のみ |
| `../.github/workflows/axion_refresh_ig_token.yml` | 毎週月曜にInstagramトークンを延長し、`gh secret set` で上書き（`GH_PAT` が必要）|
| `posts/日付.json` | 生成内容と各SNSの結果（`ok:` / `error:` / `skipped`）|
| `history.json` | 過去テーマの記録 |
| `README.md` | ユーザー向けのセットアップ手順・運用・トラブル対応 |

| `tests/test_offline.py` | AI・SNSを差し替えた通しテスト |

Instagramは画像を公開URLから取りに来るため、画像をリポジトリにcommitして `raw.githubusercontent.com` のURL（サブフォルダ込み、`main.public_url`）を渡している。**リポジトリは Public 必須。**

同じリポジトリの `sns/`（posts.csv 方式の予約投稿）は旧方式。二重投稿を避けるため `sns-post.yml` の定期実行は停止済み。LP（`axion-sales.html`）・プロフィール文（`sns/PROFILES.md`）は引き続き使う。

## 進捗（2026-10-23）
| 項目 | 状態 |
|---|---|
| X | ✅ 自動投稿稼働。10/23 にテスト投稿成功 |
| Instagram | ✅ 自動投稿稼働。10/23 にテスト投稿成功。トークン自動延長（GH_PAT）も成功 |
| Secrets | ✅ ANTHROPIC_API_KEY / X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET / IG_ACCESS_TOKEN / GH_PAT 登録済み |
| 投稿プロンプト | ✅ 10/23 に brand.md → prompt.md（ユーザー作成）へ切り替え |
| LinkedIn | ⏸ 保留。会社ページ作成時に「つながりの数が不足」で作れず。つながりが10人前後になったら再挑戦。現プロンプトはLinkedIn用本文を作らないので、再開時はプロンプトの出力に linkedin を足す |

## 今後やること
- LinkedIn（上記）：会社ページ作成 → developer app（Share on LinkedIn ＋ Sign In with LinkedIn using OpenID Connect）→ OAuth Token Tools でスコープ `openid profile w_member_social` のトークン発行 → `LI_ACCESS_TOKEN` 登録
- 料金・成果保証が確定したら `prompt.md` の1章を更新

## 注意点
- **X**：2026-10-23 に OAuth 2.0 のクライアントシークレットがスクショ経由でチャットに出た。本システムでは使わないが、再生成済みか確認すること（console.x.com → アプリ → キー → クライアントシークレット「再生成」）
- **X**：OAuth 2.0 側のアクセストークンは使わない（OAuth 1.0 キーのみ使用）
- **Instagram**：Metaアプリは「未公開（開発モード）」のまま。自社アカウントへの投稿だけなら開発モードで動く想定。`IG_API_VERSION` の既定は `v23.0`
- **Instagram**：トークンは60日有効で、週1で自動延長。ただし `GH_PAT` が未登録だと延長に失敗する
- **LinkedIn**：トークンは60日で切れ、自動延長できない。手動で再発行が必要。`LI_API_VERSION` の既定は `202606`。「version is not active」と出たら新しい年月に変更する
- 投稿内容の禁止事項（架空の実績・お客様の声、誇大表現、他社批判など）は `prompt.md` に記載。勝手に緩めない
- 代表の他の事業（清掃・管理会社の経営）はLP・SNSとも出さない（2026-10-24決定）。prompt.md の代表の考え方は「営業の仕組みで現場を少しよくしたい」。出力に「清掃」が入ったら作り直す
- 料金・成果保証は未確定（2026-10-23決定）。条件を書面で決めるまで、prompt.md・LP・プロフィール・フォーム営業文のどこにも書かない。入口は「見込み客リスト20件の無料作成」で統一
- 費用の目安：Claude API 月数百円、X 1投稿 $0.015、その他は無料
