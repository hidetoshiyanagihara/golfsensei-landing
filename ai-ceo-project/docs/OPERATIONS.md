# 運用の手順（バックアップ・復旧・自動点検・上限の変更）

最終更新：2026-11-28

## 1. 毎日のバックアップ（GitHub Actions「AI CEO DB backup」）

- 毎日 日本時間 3時ごろ、データベース（Turso）の全テーブルを読み出し、**暗号化して** Actions の Artifacts に30日残す。
- 同時に **復旧テスト**（暗号化したファイルを開いて空のデータベースに書き戻し、全テーブルの行数が一致するか）を毎回行う。合わなければ失敗にする。
- 暗号化の鍵は、データベースの合鍵（GitHub Secrets の `TURSO_AUTH_TOKEN`）から作る。**合鍵を作り直したら、それより前のバックアップを開くには古い合鍵が必要**。合鍵を作り直したら、すぐに手動でバックアップを1回取る（Actions → AI CEO DB backup → Run workflow）。
- 記録（公開）には、テーブル数と行数だけを出す。

## 2. 復旧のしかた（データが壊れた・消えたとき）

本番のデータベースは上書きしない。新しいデータベースを作って差し替える。

1. Actions → AI CEO DB backup → 戻したい日の実行 → Artifacts から `ai-ceo-backup-…` をダウンロードして解凍する
2. パソコンの `ai-ceo-project` で：
   `BACKUP=ai-ceo-backup.ccbk OUT=restored.db TURSO_AUTH_TOKEN=（バックアップを取ったときの合鍵） npx tsx scripts/db-restore.ts`
3. 中身を確かめる（`DB_PATH=restored.db npm run dev` で管理画面を開く）
4. Turso に新しいデータベースを作る：`turso db create ai-ceo-restored --from-file restored.db`
5. 新しいデータベースの URL と合鍵を、Netlify の環境変数と GitHub Secrets（`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`）に入れ直し、Netlify を再デプロイする

## 3. 自動点検（GitHub Actions「AI CEO health check」）

3時間ごと（とバックアップのあと）に調べ、見つけた問題を管理画面の「次にやること」に **【自動点検】** として載せる。直ったものは次の点検で自動的に「完了」になる。AI は使わない（費用0円）。

| 調べること | 載る条件 |
|---|---|
| 自動投稿の見回り（Netlify・15分ごと） | 90分以上動いていない（Netlify の無料枠切れ・停止の可能性） |
| X の予約投稿 | 予約時刻から2時間過ぎても出ていない |
| Instagram の予約投稿 | 予約時刻から8時間過ぎても出ていない（1日2本・3時間あけるため） |
| 手で投稿する予定（note・YouTube 台本など） | 予定日を過ぎた |
| 承認待ちの下書き | 24時間以内に予定があるのに承認待ち |
| 投稿の失敗 | 失敗のままのものがある |
| Anthropic の残高 | 24時間以内に「残高不足」で失敗した |
| 月間予算・AI API の上限 | 70%以上・85%以上 |
| AI社員ごとの上限 | 80%以上、または停止中 |
| バックアップ | 3日以上取れていない |

## 4. AI社員の月間上限を変える（GitHub Actions「AI CEO agent cap」）

代表者の判断で実行する。AI API の月間上限より大きくはできない。変更は操作ログ（`agent.cap_changed`）に残る。
予算の上限で止まっていた AI社員は、上限を上げて使用額を下回れば「待機中」に戻る。

| 日付 | AI社員 | 変更 | 理由 |
|---|---|---|---|
| 2026-11-28 | 商品開発AI（product） | 3,000円 → 5,000円 | 980円の商品の品質検査（3つ目）の続きのため。代表者の指示 |
