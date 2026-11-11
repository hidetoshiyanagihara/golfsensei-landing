# ig-growth｜Instagram フォロワー増加プロジェクト（0円運用）

**コンセプト**：「その場でコピペして、今日の仕事が 1 つ早く終わる。」
営業会社の代表が、仕事で実際に使っている AI の頼み方を、無料版だけで・コピペできる形で出す新しい Instagram アカウント。

- 費用：初期 0 円・月額 0 円（GitHub Actions・Vercel・Meta 公式 Instagram API はいずれも無料枠。有料 AI・有料 API は使わない）
- 投稿・記録・レポートは全自動。自動いいね・自動フォロー・自動 DM・自動コメントはしない
- 目標（挑戦目標）：30 日 1,000 人／60 日 3,000 人／90 日 5,000 人

既存の AXION SALES の SNS 自動投稿（`../axion-autopost/`）とは**別のアカウント・別の仕組み**です。

---

## まず読む順番

| 順 | ファイル | 内容 |
|---|---|---|
| 1 | この README の「自動でやること・あなたがやること」 | あなたがやるのは最初の 1 回・約 30 分だけ |
| 2 | [docs/02_ジャンル選定.md](docs/02_ジャンル選定.md) | なぜこのジャンルか（比較表） |
| 3 | [docs/03_コンセプト設計.md](docs/03_コンセプト設計.md) | ターゲット・5 つの柱・口調 |
| 4 | [docs/04_アカウント名・プロフィール・デザイン.md](docs/04_アカウント名・プロフィール・デザイン.md) | 名前・プロフィール文・デザインのルール |
| 5 | [content/calendar_30days.csv](content/calendar_30days.csv) | 30 日分の投稿予定（1 行＝1 投稿） |

## フォルダの中身

```
ig-growth/
├─ README.md                    ← ここ（運用開始の手順・ツールの使い方）
├─ brand.json                   ← アカウント名・色・運用開始日・目標（変えたら画像を作り直す）
├─ docs/                        ← 戦略（STEP1〜4）と運用ルール
│   ├─ 01_市場・競合分析.md         STEP1
│   ├─ 02_ジャンル選定.md           STEP2
│   ├─ 03_コンセプト設計.md         STEP3
│   ├─ 04_アカウント名・プロフィール・デザイン.md  STEP4
│   ├─ 05_成長戦略・KPI.md          フォロワー獲得の戦略・90日ロードマップ・見直し手順・収益化
│   ├─ 06_バズ研究・フック集.md     伸びる投稿の分解方法・フック15型・構成5型・採点表
│   ├─ 07_週次レビュー・改善.md     毎週日曜の振り返り手順
│   ├─ 08_ストーリーズ運用.md
│   ├─ facts.md                    投稿に書いてよい事実（ここにない数字は書かない）
│   └─ competitor_research_sheet.csv  競合調査シート（アプリで30分調べて埋める）
├─ content/                     ← 投稿の中身（STEP5〜7）
│   ├─ calendar_30days.csv         30日カレンダー（リール22・カルーセル10・ストーリーズ毎日）
│   ├─ reels/R01〜R22_*.md         リール台本22本（タイトル・フック・台本・ナレーション・テロップ・撮影・キャプション・ハッシュタグ・CTA）
│   ├─ carousels/C01〜C10_*.md     カルーセル原稿10本（スライドの文章・キャプション）
│   ├─ captions.csv                キャプション管理（自動生成）
│   └─ ideas_backlog.csv           次回投稿候補リスト
├─ assets/プロンプト集_無料配布.md  ← プロフィールのリンク先の原稿（#00〜#34）。output/prompts.html に自動変換
├─ output/                      ← 投稿に使う画像（自動生成）
│   ├─ index.html                  素材ギャラリー
│   ├─ prompts.html                プロンプト集ページ（/ai で公開）
│   ├─ videos/R01〜R22.mp4         リール動画（自動生成）
│   ├─ carousels/C01〜C10/         カルーセル画像（1080×1350）
│   ├─ reels/                      リールの表紙（1080×1920）と字幕ファイル（.srt）
│   ├─ stories/                    ストーリーズの背景6種・auto/ にお知らせストーリーズ
│   └─ brand/                      アイコン3案・ハイライト表紙5種
├─ data/                        ← 数字の記録（STEP8）
│   ├─ 管理シート.xlsx             Google スプレッドシート用（カレンダー・投稿実績・フォロワー推移・集計・改善案・候補…）
│   ├─ posts_log.csv               投稿実績（空欄＝未取得）
│   ├─ followers_daily.csv         フォロワー推移
│   └─ improvements.csv            改善案管理
├─ reports/                     ← 週次レポート（自動生成）
├─ tools/igtool.py              ← 制作・管理ツール（publish.py＝自動投稿、video.py＝リール動画、insights.py＝数字の取得）
└─ tests/test_igtool.py         ← オフラインのテスト
```

---

## 自動でやること・あなたがやること

### 自動（GitHub Actions・無料）
| いつ | 何を | 仕組み |
|---|---|---|
| 予定の時刻（リール 20:00、カルーセル 12:10） | カレンダーどおりにリール・カルーセルを投稿（キャプション・ハッシュタグ・表紙つき） | `IG growth post`（20 分ごと）→ `tools/publish.py` |
| 投稿の 40 分後 | 「新しい投稿」のお知らせストーリーズ | 同上 |
| 毎朝 8:23 | 再生数・リーチ・保存・シェア・フォロー数などを記録、フォロワー数を記録 | `IG growth insights` → `data/` |
| 毎週日曜の朝 | 週次レポート（伸びた・伸びなかった投稿、柱・フック別の比較、目標ペース） | 同上 → `reports/` |
| 毎週月曜 | トークンの延長（60 日で切れないように） | `Refresh Instagram token` |
| 登録が遅れたとき | 未投稿の予定を丸ごと後ろへずらす（まとめて連投しない） | `tools/publish.py` |

- 投稿するものは全部このフォルダで作成済み：リール動画 22 本（`output/videos/`、文字アニメ＋プロンプト入力の演出＋オリジナル BGM、各 20 秒）、カルーセル 10 本、お知らせストーリーズ 32 枚
- プロフィールのリンク先（プロンプト集）も自動で公開：**https://copipe-ai.vercel.app** （コピーボタンつき。`assets/プロンプト集_無料配布.md` を直すと次の公開で反映）
  - 短いアドレスは 2026-11-09 に有効化済み（https://golfsensei-landing.vercel.app/ai でも同じページが開きます）
- 自動投稿を止める：`brand.json` の `"auto_post"` を `false` にする（Claude Code に「自動投稿を止めて」でも可）
- いいね・フォロー・DM・コメントの自動化はしない（規約違反・アカウント停止の原因になるため）

### あなたがやること（最初の 1 回だけ・約 30 分）
Instagram の規約上、アカウント作成とログインが必要な操作は本人にしかできないため、ここだけお願いします。

0. **短いリンクを有効にする（2026-11-09 完了済み・アドレスを変えるときだけ）**
   - Vercel のトークンを発行：https://vercel.com/account/tokens →「Create Token」→ 名前 `ig-growth`、Scope は golfsensei-landing のプロジェクトがあるアカウント（またはチーム）、Expiration は「1 day」で OK →「Create」→ 表示されたトークンをコピー
   - GitHub に登録：https://github.com/hidetoshiyanagihara/golfsensei-landing/settings/secrets/actions →「New repository secret」→ Name `VERCEL_TOKEN`、Secret に貼る →「Add secret」
   - Actions → IG growth short link →「Run workflow」で `copipe-ai.vercel.app` を追加（**2026-11-09 完了済み**）
   - トークンを作らない方法：Vercel の golfsensei-landing プロジェクト → Settings → Domains → `copipe-ai.vercel.app` を Add（1 分）
1. **アカウントを作る（10分）**
   Instagram アプリ → プロフィール → 右上の名前 →「アカウントを追加」→「新しいアカウントを作成」→ ユーザーネーム `copipe_ai_shigoto`（使えなければ docs/04 の別案。**別の名前にしたら Claude Code に伝える**。画像・動画の名前を作り直します）
2. **プロアカウントにする（2分）** ※自動投稿に必須
   設定 →「アカウントの種類とツール」→「プロアカウントに切り替える」→ **クリエイター** → カテゴリ「デジタルクリエイター」
3. **プロフィールを入れる（5分）**
   - 名前：`コピペAI仕事術｜営業社長のAI活用`
   - 自己紹介：docs/04 の **A案** をコピー
   - リンク：`https://copipe-ai.vercel.app`（タイトル「仕事で使うプロンプト集（無料）」）
   - アイコン：`output/brand/icon_A.jpg`（GitHub アプリでこのファイルを開いて長押し →「写真に保存」）
4. **投稿用のトークンを発行する（10分）** — AXION SALES のときと同じ画面です
   [Meta for Developers](https://developers.facebook.com/apps/) → AXION SALES で作ったアプリ → Instagram →「Instagram ログインによる API 設定」→「アカウントを追加」で**新しいアカウント**でログイン → そのアカウントの「トークンを生成」
   （権限は `instagram_business_basic` `instagram_business_content_publish` `instagram_business_manage_insights`。アプリが開発モードの場合は、新しいアカウントを「Instagram テスター」に追加して承認が必要なことがあります）
5. **トークンを GitHub に登録する（2分）**
   https://github.com/hidetoshiyanagihara/golfsensei-landing/settings/secrets/actions →「New repository secret」→ Name `IG_GROWTH_TOKEN`、Secret に 4 のトークン →「Add secret」
   **トークンはチャットに貼らないでください。**
6. **確認（任意）**：Actions →「IG growth post」→「Run workflow」（dry_run は 1）→ ログに投稿予定が出れば準備完了

これで、予定日（最初は 11/15 19:00 の C02）から自動で投稿が始まります。登録が予定より遅れても、予定が自動で後ろにずれるので大丈夫です。

### 自動化できないので、余裕があればやること（任意）
| いつ | やること | 効果 |
|---|---|---|
| 最初の 2 投稿の後 | C01・C02 を「プロフィールに固定」（投稿の「…」から）。ハイライト「はじめに」を作る | プロフィールに来た人のフォロー率 |
| 投稿後 1 時間 | コメントに返信（自動返信はしない方針） | コメント・関係づくり |
| 毎日 10 分 | 同じジャンルの投稿に、本気のコメントを手で 3〜5 件 | 新しい人に見つけてもらう |
| 好きなとき | ストーリーズでアンケート・質問箱（`output/stories/` の背景＋スタンプ） | 次の企画のネタ集め（API ではスタンプを付けられない） |

### 週 1 回の振り返り
日曜の朝に `reports/weekly_日付.md` ができます。Claude Code に
「ig-growth の今週のレポートを見て、docs/07 の 6 つの問いに答えて、来週の企画を直して」
と頼めば、台本の差し替え・新しい台本・画像と動画の作り直しまで行います。
（自分で数字を入れたい場合は `data/管理シート.xlsx` を Google スプレッドシートで使い、`import-sheet` で取り込めます）

---

## ツールの使い方（tools/igtool.py）

Python 3.10 以上・Pillow・openpyxl（動画は numpy・imageio-ffmpeg も）が必要（`pip install -r tools/requirements.txt`）。フォントは初回に自動ダウンロード。

```bash
cd ig-growth
python tools/igtool.py all                 # 画像・字幕・キャプション一覧・投稿実績の行・管理シートを作り、検査する
python tools/igtool.py render C03 R01      # 指定したものだけ作り直す
python tools/igtool.py check               # 文字数・ハッシュタグ数（5個まで）・テロップ・はみ出し・プロンプト番号を検査
python tools/igtool.py calendar --start 2026-11-23   # 運用開始日を変える（カレンダーの日付を振り直す）
python tools/igtool.py report --start 2026-11-16 --end 2026-11-22
python tools/igtool.py import-sheet 管理シート.xlsx
python -c "import sys; sys.path.insert(0,'tools'); import video; video.render_videos(['R01'])"   # リール動画を作り直す
python tools/publish.py plan               # 自動投稿の予定一覧
python tools/publish.py run --dry-run      # 投稿せずに、いま何を投稿するかを表示
python tests/test_igtool.py                # テスト（外部には接続しない）
```

### 原稿の書き方
- **リール**（`content/reels/*.md`）：```` ```cover ```` に表紙（`label:` `title:` `sub:`）、```` ```telop ```` に `0.0-2.0 | 文字`（改行は `\n`）、```` ```caption ```` ```` ```hashtags ```` 。新しく作るときは R01 をコピーして書き換える
- **カルーセル**（`content/carousels/*.md`）：```` ```slides ```` の中に `=== 種類` で 1 枚ずつ。種類は `cover` `text` `list` `prompt` `chat` `compare` `summary` `cta`。`**強調**` はオレンジ、`==マーカー==` は黄色の帯、`\n` で改行、`items:` の各行は `- 見出し｜説明`
- 数字・実績は [docs/facts.md](docs/facts.md) にあるものだけ。新しい投稿のプロンプトは先にプロンプト集に追加してから

### インサイトの自動取得
上の手順 5 のトークンで、Actions の「IG growth insights」が毎朝 `data/posts_log.csv` と `data/followers_daily.csv` を更新します。
- フォロワー外リーチ率・視聴維持率など API で取れない指標は空欄のまま（アプリで確認）
- トークンは毎週月曜に自動で延長されます（`GH_PAT` が登録済みのため）。延長に失敗したときは手順 4〜5 をやり直す
- **リポジトリが Public のため、記録した数字も公開されます**

---

## 守ること
- Instagram の規約：自動いいね・自動フォロー・自動 DM・非公式ツール・フォロワー購入・相互フォロー企画はしない
- 著作権：他人の投稿・画像・動画の転載や切り抜きはしない。音源はアプリ内のライブラリから
- 認証情報：パスワード・トークンをファイル・コード・チャットに書かない
- 事実：測っていない数字・架空の実績・お客様の声は書かない。AI の答えは毎回変わるので「回答の一例」として扱う
