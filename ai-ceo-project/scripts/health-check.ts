/**
 * 自動点検（GitHub Actions：.github/workflows/ai_ceo_health.yml から数時間ごと）。AI は使わない（費用0円）。
 * 見つけた問題は、管理画面の「次にやること」に【自動点検】として載せる。記録（公開）には件名だけを出す。
 */
import { getDb } from "../lib/database/db";
import { healthIssues, syncHealthTasks } from "../lib/ops/health";

async function main() {
  const db = await getDb();
  const issues = await healthIssues(db);
  const r = await syncHealthTasks(db, issues);
  console.log(issues.length ? `見つかった問題：${issues.length}件` : "問題は見つかりませんでした");
  for (const i of issues) console.log(`  - ${i.title}`);
  console.log(`「次にやること」：追加 ${r.added}件・完了にした ${r.closed}件`);
}

main().catch((e) => {
  console.error("エラー：", e instanceof Error ? e.message : e);
  process.exit(1);
});
