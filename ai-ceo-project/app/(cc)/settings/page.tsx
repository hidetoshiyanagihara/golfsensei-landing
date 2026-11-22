import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { runAgentTask, setAutomation, updateSettings } from "@/app/actions";
import { formatDateTimeJst } from "@/lib/time";
import { Button, Card, Notice, PageHeader } from "@/components/common/ui";
import { Flash, type FlashParams } from "@/components/common/Flash";

export const metadata = { title: "設定" };

const INTEGRATIONS: [string, string, boolean, string][] = [
  ["データベース（Turso）", "TURSO_DATABASE_URL", !!process.env.TURSO_DATABASE_URL, "スマホから使う本番環境のデータ保存先。未設定のときはパソコン内のファイル（data/）を使います。"],
  ["Claude API（AI社員）", "ANTHROPIC_API_KEY", !!process.env.ANTHROPIC_API_KEY, "AI CEO・市場調査AIが使います（モデル：Claude Opus 5.5）。キーはサーバー側だけで使い、ブラウザには出しません。AXION SALES の自動投稿と同じアカウントの料金になります。"],
  ["X / Instagram / YouTube への投稿", "—", false, "AI CEO PROJECT の新アカウントは、承認後に手で投稿します（自動投稿は各SNSの公式APIと規約を確認してから PHASE 4 で判断）。AXION SALES は既存の自動投稿が担当。"],
  ["note（販売）", "—", false, "note には公開された販売APIがないため、売上は note の売上管理画面を見て財務画面に記録します。"],
  ["決済・広告出稿", "—", false, "支払い・契約・広告は代表者の承認が必須。自動化しません。"],
];

export default async function SettingsPage({ searchParams }: { searchParams: FlashParams }) {
  const sp = await searchParams;
  const db = await getDb();
  const s = await repo.getSettings(db);
  const automation = s.automation_enabled === "true";
  const logs = await repo.recentAudit(db, 30);

  return (
    <>
      <PageHeader title="設定" en="SETTINGS" description="予算の上限・AIの自動実行・外部サービスの接続状況・操作ログ" />
      <Flash {...sp} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="予算と上限">
          <form action={updateSettings} className="grid grid-cols-2 gap-3">
            <div><label htmlFor="monthly_budget_jpy">月間運営予算（円）</label><input id="monthly_budget_jpy" name="monthly_budget_jpy" inputMode="numeric" defaultValue={s.monthly_budget_jpy} /></div>
            <div><label htmlFor="ai_api_monthly_cap_jpy">AI API の月間上限（円）</label><input id="ai_api_monthly_cap_jpy" name="ai_api_monthly_cap_jpy" inputMode="numeric" defaultValue={s.ai_api_monthly_cap_jpy} /></div>
            <div><label htmlFor="budget_warn_ratio">警告ライン（0.5〜0.95）</label><input id="budget_warn_ratio" name="budget_warn_ratio" inputMode="decimal" defaultValue={s.budget_warn_ratio} /></div>
            <div><label htmlFor="usd_jpy">円換算レート（1ドル＝円）</label><input id="usd_jpy" name="usd_jpy" inputMode="numeric" defaultValue={s.usd_jpy} /></div>
            <div className="col-span-2"><Button>保存</Button></div>
          </form>
          <p className="mt-3 text-xs text-fg-subtle">上限に達したAI社員は自動で停止し、操作ログに記録されます。円換算レートは推計用の設定値です。</p>
        </Card>

        <Card title="AIの自動実行">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm">現在：<span className={automation ? "text-good" : "text-fg-muted"}>{automation ? "ON" : "OFF"}</span></p>
              <p className="text-xs text-fg-subtle">OFFの間は、AI社員は一切実行されません（費用は発生しません）。</p>
            </div>
            <form action={setAutomation}>
              <input type="hidden" name="on" value={automation ? "false" : "true"} />
              <Button variant={automation ? "danger" : "ghost"}>{automation ? "OFFにする" : "ONにする"}</Button>
            </form>
          </div>
          <div className="mt-3"><Notice>これは「定期的な自動実行」のスイッチです。代表者がボタンを押して頼む仕事は、OFFのままでも予算の範囲で実行されます。定期実行は PHASE 5 で追加予定のため、ONにしても今は何も起きません。</Notice></div>
        </Card>
      </div>

      <Card title="外部サービスの接続状況" className="mt-4">
        <ul className="divide-y divide-line/60">
          {INTEGRATIONS.map(([name, key, on, note]) => (
            <li key={name} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm">{name}</p>
                <p className="text-xs text-fg-subtle">{note}</p>
              </div>
              <span className={`shrink-0 text-xs ${on ? "text-good" : "text-fg-subtle"}`}>{on ? `設定済み（${key}）` : "未接続"}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="裏側の実行の動作確認" className="mt-4">
        <form action={runAgentTask} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="task" value="system.ping" />
          <input type="hidden" name="seconds" value="70" />
          <Button variant="ghost">動作確認（AIは使わない・0円）</Button>
          <span className="text-xs text-fg-subtle">70秒かかる処理を裏側で動かし、時間のかかるAIの仕事が途中で止まらないかを確かめます。結果は AI CEO の画面に出ます。</span>
        </form>
      </Card>

      <Card title="操作ログ（直近30件）" className="mt-4">
        <ul className="divide-y divide-line/60 text-xs">
          {logs.map((l) => (
            <li key={l.id} className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:gap-3">
              <span className="num shrink-0 text-fg-subtle">{formatDateTimeJst(l.at)}</span>
              <span className="shrink-0 text-gold">{l.actor}</span>
              <span className="shrink-0">{l.action}</span>
              <span className="min-w-0 truncate text-fg-subtle">{l.target} {l.detail}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
