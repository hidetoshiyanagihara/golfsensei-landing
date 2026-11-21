import { getDb } from "@/lib/database/db";
import * as repo from "@/lib/database/repo";
import { setAutomation, updateSettings } from "@/app/actions";
import { formatDateTimeJst } from "@/lib/time";
import { Button, Card, Notice, PageHeader } from "@/components/common/ui";
import { Flash, type FlashParams } from "@/components/common/Flash";

export const metadata = { title: "設定" };

const INTEGRATIONS: [string, string, boolean, string][] = [
  ["Anthropic API（AI社員）", "ANTHROPIC_API_KEY", !!process.env.ANTHROPIC_API_KEY, "PHASE 2 で接続。キーはサーバー側だけで使い、ブラウザには出しません。"],
  ["X / Instagram / YouTube への投稿", "（既存の axion-autopost が GitHub Actions で実施）", false, "Command Center からの自動投稿は未実装。各SNSの公式APIと規約を確認してから PHASE 4 で接続します。"],
  ["note 販売・売上の自動取り込み", "—", false, "公式に使えるAPIの有無を確認してから判断します。それまでは財務画面で手入力します。"],
  ["決済・広告出稿", "—", false, "支払い・契約・広告は代表者の承認が必須。自動化しません。"],
];

export default async function SettingsPage({ searchParams }: { searchParams: FlashParams }) {
  const sp = await searchParams;
  const db = getDb();
  const s = repo.getSettings(db);
  const automation = s.automation_enabled === "true";
  const logs = repo.recentAudit(db, 30);

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
          <div className="mt-3"><Notice>AI社員はまだ未接続のため、ONにしても現在は何も実行されません。</Notice></div>
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
