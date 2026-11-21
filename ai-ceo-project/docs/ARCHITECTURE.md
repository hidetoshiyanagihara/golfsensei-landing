# 構成

```
ai-ceo-project/
├── app/                    画面（Next.js App Router）
│   ├── (cc)/               ログイン後の画面（dashboard, agents, business, products, marketing, finance, reports, settings）
│   ├── login/              ログイン画面
│   └── actions.ts          画面からの操作（Server Actions）。全操作で認証・入力チェック・操作ログ
├── components/common/      共通の部品（カード・数値タイル・データ種別バッジ・メニュー）
├── components/dashboard/   グラフ
├── lib/
│   ├── database/           SQLite の定義（schema.ts）・接続とマイグレーション（db.ts）・初期データ（seed.ts）・読み書き（repo.ts）
│   ├── security/           ログインセッション（session.ts）・認証チェック（auth.ts）
│   ├── finance/            売上と利益の計算ルール
│   ├── automation/         予算ガード
│   ├── ai/                 AI社員の定義・モデル料金
│   ├── analytics/          ダッシュボード集計・経営会議（ルールベース）
│   ├── importers/          既存データの取り込み（axion-autopost）
│   └── rules.ts            承認フロー（品質検査・販売開始・投稿の状態遷移・事業評価）
├── knowledge/              ブランド・運営ルール（AI社員が参照する）
├── scripts/                セットアップ・DB初期化・取り込み・サンプル
├── tests/unit/             単体テスト（node:test）
├── tests/e2e/              ブラウザ通しテスト（Playwright）
├── proxy.ts                未ログインのアクセスを /login へ（Next.js 16 の旧 middleware）
└── data/                   SQLite ファイル（Git 管理外）
```

## 設計の決まりごと

- **実データとサンプルの分離**：全テーブルに `data_kind`（actual / sample / forecast）。集計関数は `View` を受け取り、既定は actual のみ。経営会議は常に actual のみ。
- **売上と利益**：`lib/finance/calc.ts` の定義に一本化。売上総額 → 純売上（返金差引）→ 粗利益（決済手数料差引）→ 営業利益（運営費差引）→ 税引後。
- **AIの判断と実行結果**：`agent_runs.ai_output`（AIが出した内容）と `agent_runs.execution_result`（実際に行われたこと）を別の列で保存。
- **承認が必要な操作**：`lib/rules.ts` で判定し、画面のボタンを無効化するだけでなく Server Action 側でも拒否する。
- **認証**：proxy.ts で入口チェック＋各ページ・各 Server Action で `requireAuth()`。Cookie は httpOnly・SameSite=Lax・本番は Secure。
- **秘密情報**：`.env.local` のみ。ブラウザに渡すコードに API キーを書かない（`NEXT_PUBLIC_` を使わない）。
- **費用**：追加の有料サービスなし。AI の呼び出しは PHASE 1 では 0 回。

## 技術選定の理由

| 選択 | 理由 |
|---|---|
| Next.js 16（App Router） | 画面とサーバー処理を1つで書ける。将来 Vercel 無料枠に置ける |
| SQLite（better-sqlite3） | 無料・設定不要・ファイル1つ。将来 Supabase/Turso に移すときは `lib/database` だけを差し替える |
| node:test | 追加の依存なしでテストできる |
| 自前の署名Cookie | 利用者は代表者1人。外部認証サービス（有料・外部連携）を使わずに済む |
