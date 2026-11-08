# AXION SALES SNS自動投稿 — 引き継ぎメモ

このファイルは、claude.ai で進めてきた作業を Claude Code で続けるための引き継ぎです。
（2026-10-23 時点。同日 Claude Code で golfsensei-landing リポジトリの `axion-autopost/` に設置）

## ユーザーについて
- 柳原秀俊（AXION SALES 代表、名古屋の営業代行。法人化前の個人事業）。やりとりは日本語
- 非エンジニア。手順は「どこを押すか」まで具体的に、1回に1ステップずつ案内する
- 選択肢を並べるより、こちらで決めて提案するのを好む
- **Claude API のクレジットは自動投稿のために使う**（2026-10-29 ユーザー指示）。試し実行・調査・リスト作成・フォーム営業など、自動投稿以外でクレジットを使う作業は、**実行する前に「何に・いくらくらいかかるか」を伝えて了承をもらう**。フォローする相手リストは同日に定期実行を停止、フォーム営業は `LIVE_ON` を置くまで動かない（置く前に月1〜1.5万円かかることの了承が必要）
- APIキーやトークンは原則チャットに貼らせない。ただし2026-10-27以降、ユーザーが「自動でやって」と希望し、Vercel・Googleのキーはチャット経由で受け取った。GitHub Secrets への登録は、リポジトリの公開鍵で暗号化して一時ブランチのワークフロー（`GH_PAT` 使用）から行った（プロキシ経由では Secrets API に直接アクセスできない）
- LPの短いURL：`https://axionsales.vercel.app`（Vercel のドメイン追加済み）。`/youtube` `/x` `/instagram` などは `?src=` 付きでLPへリダイレクト（`vercel.json`）

## このプロジェクトの目的
毎朝7:47（日本時間）に、AIが `prompt.md`（ユーザー作成の投稿プロンプト）に沿ってその日の投稿を作り、X・Instagram に自動投稿する。
動かす場所は GitHub Actions（無料）。

## 構成
| ファイル | 役割 |
|---|---|
| `prompt.md` | システムプロンプト。ユーザーが2026-10-23に作成、2026-10-30 にユーザー了承のうえ成長戦略（https://claude.ai/artifact/EEwfLARPbgTDeTm3ZcPscF）に合わせて書き換え：ポジション「営業を考え続けている人が結果として代行もやっている」、経営者の痛み、今日の枠（比率 有益40/本音25/実験20/活動10/訴求5）、フック20個から選ぶ、100点審査（70点未満は作り直し、実験枠は除く）、契約0社の公開可。`{{today}}` `{{weekday}}` `{{slot}}` `{{recent_posts}}` `{{memo}}` だけ差し込み、他の `{{ }}` は指示文として残す |
| `memo.md` | 代表の活動・数字・気づき（週5分で書き足してもらう）。投稿に使ってよい数字はここにあるものだけ。2026-10-30 に現在地の実数を記入 |
| `autopost/generate.py` | Claude API（`claude-sonnet-5-5`）でX・Instagram・ショートの会話をJSON生成。今日の枠は `slot_for`（曜日で決定、金曜の無料リスト案内はISO週番号が4の倍数の週だけ）。X140字超・URL・禁止表現・フック10個未満・審査の配点外・合計70点未満（実験枠は除く）は再生成（最大3回）。投稿JSONに slot / pain / hooks / score / score_total を残す（週次分析用） |
| `autopost/image_card.py` | Instagram/LinkedIn用の1080x1350 **JPEG** 画像（濃紺×ゴールド、文字のみ）をPillowで生成。Instagram APIはPNG不可 |
| `autopost/platforms.py` | X（OAuth1.0a, POST /2/tweets）、Instagram（graph.instagram.com, Instagramログイン版）、LinkedIn（/rest/posts, 個人アカウント投稿）|
| `autopost/characters.py` / `assets/` | ショートのキャラクター2人。ユーザー提供の公式イラスト（2026-10-26）をアニメ向け切り抜きモデル（anime-seg isnetis）で切り抜いた `assets/apo.png`・`assets/tsunagari.png` を使う。アポくん＝行動派の営業マン・一人称「俺」・答える役（青）／つながりちゃん＝気配り上手・本音を引き出す役（ピンク）。話している方の後ろに色の光 |
| `autopost/video.py` | YouTubeショート用の縦長動画（1080x1920）。prompt.md 11章の `short_dialogue` をもとに2人が会話（話す方が光って跳ね、聞く方は少し暗く、吹き出しに1文字ずつ表示）、アポくんが無料リストを案内し、最後に公式ロゴ（`assets/logo.png`、ユーザー提供のステッカー画像から切り出し）と「営業代行」のカードで、つながりちゃんが「営業代行の、アクシオンセールスでした！」と締める。上部の社名の横に常に「営業代行」の札。YouTubeのタイトルは「見出し｜営業代行 AXION SALES #Shorts」、説明欄の1行目で営業代行と名乗る（2026-10-28 ユーザー希望）。動画・YouTubeでは「建設・不動産専門」「名古屋」とは書かない。対象は全国（同日ユーザー指示）。BGMは `autopost/bgm.py` が毎回オリジナル曲を作曲（投稿内容から曲調・コード進行・キーが決まる。bgm.mp3 を置けば優先）。imageio-ffmpeg で書き出し。ショート再生画面で隠れる右180px・下520pxには大事なものを置かない |
| `autopost/bgm.py` | ショートのBGMをnumpyで作曲（王道進行・丸サ進行など×ポップ/ダンス/チル）。ヒット曲は自動投稿だとミュート・著作権違反になるため使わない（2026-10-28 ユーザーに説明済み） |
| `autopost/voice.py` | ショートの声。VOICEVOX ENGINE（Docker `voicevox/voicevox_engine:cpu-0.26.0`、Actions内で起動）で読み上げ。アポくん＝白上虎太郎(12)、つながりちゃん＝春日部つむぎ(8)（2026-10-28 ユーザー希望で高め・テンション高めに変更。pitch+0.04・抑揚1.35）。各キャラの規約によりYouTube説明欄に「VOICEVOX:名前」を自動で入れる。エンジンが無ければ声なしで続行 |
| `autopost/main.py` | `generate` / `publish` / `preview` コマンド。直近14日の投稿を被り防止に渡す。キー未設定のSNSはスキップ、成功済みSNSは再実行時スキップ。LinkedIn用本文は現プロンプトでは作らない |
| `../.github/workflows/axion_daily_post.yml` | 毎日 22:47 UTC 実行（working-directory: axion-autopost）。手動実行は dry_run=1 生成のみ／0 投稿／preview 表示のみ／video ショート動画を作って artifact（short-preview）に置く |
| `../.github/workflows/axion_refresh_ig_token.yml` | 毎週月曜にInstagramトークンを延長し、`gh secret set` で上書き（`GH_PAT` が必要）|
| `autopost/follow.py` / `follow/` | 毎朝「フォローする相手リスト」（`follow/latest.md`、日付.md、`history.json`）。Claude（`claude-opus-5-5`）のWeb検索で中小企業向けSaaSの社長・営業責任者・資金調達/営業募集した会社の公式を X 7・Instagram 3 探す。フォローはユーザーが手で押す（自動フォローは規約違反のため 2026-10-29 に断って代替として作成）。`../.github/workflows/axion_follow_list.yml`（2026-10-29 ユーザー指示で定期実行は停止。手動実行のみ） |
| `posts/日付.json` | 生成内容と各SNSの結果（`ok:` / `error:` / `skipped`）|
| `history.json` | 過去テーマの記録 |
| `README.md` | ユーザー向けのセットアップ手順・運用・トラブル対応 |

| `tests/test_offline.py` | AI・SNSを差し替えた通しテスト |

Instagramは画像を公開URLから取りに来るため、画像をリポジトリにcommitして `raw.githubusercontent.com` のURL（サブフォルダ込み、`main.public_url`）を渡している。**リポジトリは Public 必須。**

2026-10-28：対象を全国・業種限定なしに変更（ユーザー指示）。LP（`axion-sales.html`）・プロフィール文（`sns/PROFILES.md`）・ショート動画から「名古屋」「建設・不動産専門」を外した（LPフッターの事務所住所は残す）。同日、ユーザー指示で `prompt.md` も全国・業種問わずに書き換え（1章の対象、3章の悩みバンクを業種横断に、6章のハッシュタグ、8章の地域、9章の例）。Instagram画像のフッターも「営業代行｜AXION SALES」

同じリポジトリの `sns/`（posts.csv 方式の予約投稿）は旧方式。二重投稿を避けるため `sns-post.yml` の定期実行は停止済み。LP（`axion-sales.html`）・プロフィール文（`sns/PROFILES.md`）は引き続き使う。

## 進捗（2026-10-23）
| 項目 | 状態 |
|---|---|
| X | ✅ 自動投稿稼働。10/23 にテスト投稿成功 |
| Instagram | ✅ 自動投稿稼働。10/23 にテスト投稿成功。トークン自動延長（GH_PAT）も成功 |
| Secrets | ✅ ANTHROPIC_API_KEY / X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET / IG_ACCESS_TOKEN / GH_PAT 登録済み |
| 投稿プロンプト | ✅ 10/23 に brand.md → prompt.md（ユーザー作成）へ切り替え |
| YouTube | ✅ 2026-10-28 に設定完了。Google Cloud プロジェクト `axion-sns`（OAuth同意画面は本番、ホームページ `https://axionsales.vercel.app`、プライバシーポリシー `/axion-privacy.html`）。`YT_CLIENT_ID` / `YT_CLIENT_SECRET` / `YT_REFRESH_TOKEN` 登録済み（チャンネル「AXION SALES」で確認）。`YT_PRIVACY`（Actions の Variables）で unlisted にできる |
| LinkedIn | ⏸ 保留。会社ページ作成時に「つながりの数が不足」で作れず。つながりが10人前後になったら再挑戦。現プロンプトはLinkedIn用本文を作らないので、再開時はプロンプトの出力に linkedin を足す |

## フォーム営業（form_sender/、2026-11-01 本番開始）
- 無料版（`free.py`、AIを使わない）。平日10:13に PR TIMES のニュースから送り先を拾い、1日最大10社に決まった文面で送る
- 記録は `form_sender/state.enc`（暗号化）。鍵は Secrets の `FORM_STATE_KEY`（合言葉は柳原さんが保管。チャットで共有済み。リポジトリには書かない）
- 本番は `form_sender/LIVE_ON` があるときだけ。止めるときはこのファイルを消す
- 11/1 のテスト入力で見つけた問題（値が消える欄、VTuber・マッチングアプリ・営業支援の会社の混入）は修正済み
- 実際の定時実行は16時半ごろ（GitHubの遅れ）。11/2〜11/4で11社送信（7・4・0）。送れるのはおよそ3社に1社
- 11/4：「とにかく毎日10件」（柳原さん）。PR TIMES のキーワード検索 API（/api/search_release.php）で過去120日までさかのぼり、送りたい件数の4倍の候補をそろえ、尽きたら探し足す（試算：ニュース153件で条件に合う会社40社、約6分）
- 下請けの売り込み（11/4 柳原さん指示）：`main.py agency` で、PR TIMES から営業代行の会社を探し「協力会社（委託先）として受けます」と1日5件送る（message_agency.txt、単価は書かず「ご相談」）。お客さま向けの10件とは別枠で、候補も混ざらない
- テレアポ担当募集（/apo、axion-caller.html、11/4）：在宅・業務委託・完全成果報酬、商談が実際に行われたアポ1件5,000円（税込）、月末締め翌月末払い。応募は同じGoogleフォームに「ご希望＝テレアポ担当応募」
- LPと紹介パートナー募集（/partner）の申し込みは Googleフォーム「AXION SALES お申し込み」に届く（通知メールは柳原さんのGmail）。パートナー募集は完全成果報酬・業務委託。報酬は「初月の料金100%＋契約が続くかぎり毎月10%、お客さまの入金確認後に支払い」（11/4 柳原さん決定）。ページの文句は柳原さんが選んだ熱い調子（お前呼び）。根拠のない金額・「絶対稼げる」は書かない

## スターストラックのフォーム営業（form_sender/starstruck.py、2026-11-08）
- 株式会社スターストラック（柳原さんの清掃会社。マンション・アパートの共用部清掃）として、マンション管理会社に「共用部清掃の協力会社」の案内を送る。送り先はマンション管理業協会の会員一覧（愛知）。柳原さん指示で1社を除外（指紋で保持。社名はリポジトリに書かない）
- 本番は `form_sender/STARSTRUCK_ON` があるときだけ。返信先は star.struck.hy@gmail.com（ホームページの問い合わせ先）
- スターストラックの情報はAXIONのSNS・LPには出さない方針のまま（文面にも AXION の名前は出さない）

## 今後やること
- LinkedIn（上記）：会社ページ作成 → developer app（Share on LinkedIn ＋ Sign In with LinkedIn using OpenID Connect）→ OAuth Token Tools でスコープ `openid profile w_member_social` のトークン発行 → `LI_ACCESS_TOKEN` 登録

## 注意点
- **X**：2026-10-23 に OAuth 2.0 のクライアントシークレットがスクショ経由でチャットに出た。本システムでは使わないが、再生成済みか確認すること（console.x.com → アプリ → キー → クライアントシークレット「再生成」）
- **X**：OAuth 2.0 側のアクセストークンは使わない（OAuth 1.0 キーのみ使用）
- **Instagram**：Metaアプリは「未公開（開発モード）」のまま。自社アカウントへの投稿だけなら開発モードで動く想定。`IG_API_VERSION` の既定は `v23.0`
- **Instagram**：トークンは60日有効で、週1で自動延長。ただし `GH_PAT` が未登録だと延長に失敗する
- **LinkedIn**：トークンは60日で切れ、自動延長できない。手動で再発行が必要。`LI_API_VERSION` の既定は `202606`。「version is not active」と出たら新しい年月に変更する
- 投稿内容の禁止事項（架空の実績・お客様の声、誇大表現、他社批判など）は `prompt.md` に記載。勝手に緩めない
- 代表の他の事業（清掃・管理会社の経営）はLP・SNSとも出さない（2026-10-24決定）。prompt.md の代表の考え方は「営業の仕組みで現場を少しよくしたい」。出力に「清掃」が入ったら作り直す
- 料金（2026-11-04 柳原さん決定・公開OK）：先着3社は完全成果報酬、商談が実際に行われたアポ1件20,000円（税別）、初期費用・月額0円、ドタキャン・不在は0円。4社目からは月額固定＋成果報酬（例：月10万＋1件1.5万）に見直す予定で金額は未定。成果保証はしない。LP・パートナー募集ページ・フォーム営業文・prompt.md に反映済み
- 費用の目安：Claude API 月数百円、X 1投稿 $0.015、その他は無料
