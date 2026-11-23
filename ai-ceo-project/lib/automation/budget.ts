/**
 * 予算ガード（PART 11-7, 11-10）。
 * AIを実行する前に必ず checkRun() を通す。上限を超えそうなら実行せず、AI社員を停止して記録を残す。
 */

export type BudgetLevel = "ok" | "warn" | "stop";

export type BudgetStatus = {
  capJpy: number;
  usedJpy: number;
  remainingJpy: number;
  ratio: number;
  level: BudgetLevel;
};

export function evaluateBudget(capJpy: number, usedJpy: number, warnRatio: number): BudgetStatus {
  const remainingJpy = capJpy - usedJpy;
  const ratio = capJpy > 0 ? usedJpy / capJpy : 1;
  const level: BudgetLevel = capJpy <= 0 || usedJpy >= capJpy ? "stop" : ratio >= warnRatio ? "warn" : "ok";
  return { capJpy, usedJpy, remainingJpy, ratio, level };
}

export type RunCheckInput = {
  /** manual = 代表者がボタンを押した／schedule = 定期実行 */
  trigger?: "manual" | "schedule";
  automationEnabled: boolean;
  agentStatus: string;
  estimateJpy: number;
  /** 月間運営予算（全体） */
  total: { capJpy: number; usedJpy: number };
  /** AI API の月間上限 */
  ai: { capJpy: number; usedJpy: number };
  /** AI社員ごとの月間上限 */
  agent: { capJpy: number; usedJpy: number };
};

export type RunCheckResult = { allowed: true } | { allowed: false; reason: string; pauseAgent: boolean };

export function checkRun(i: RunCheckInput): RunCheckResult {
  // 自動実行のON/OFFは定期実行だけに効く（代表者がボタンを押した実行は、予算の範囲で動く）
  if ((i.trigger ?? "schedule") === "schedule" && !i.automationEnabled)
    return { allowed: false, reason: "自動実行がOFFです（設定画面で代表者がONにするまで動きません）", pauseAgent: false };
  if (i.agentStatus === "paused") return { allowed: false, reason: "このAI社員は停止中です", pauseAgent: false };
  if (i.agentStatus === "not_connected") return { allowed: false, reason: "このAI社員はまだAPIに接続されていません", pauseAgent: false };
  if (!(i.estimateJpy >= 0) || !Number.isFinite(i.estimateJpy)) return { allowed: false, reason: "見積もり金額が不正です", pauseAgent: false };

  const checks: [string, { capJpy: number; usedJpy: number }][] = [
    ["月間運営予算", i.total],
    ["AI API の月間上限", i.ai],
    ["このAI社員の月間上限", i.agent],
  ];
  for (const [label, b] of checks) {
    if (b.usedJpy + i.estimateJpy > b.capJpy) {
      return {
        allowed: false,
        reason: `${label}を超えるため停止しました（使用済み ${b.usedJpy}円 + 見積もり ${i.estimateJpy}円 > 上限 ${b.capJpy}円）`,
        pauseAgent: true,
      };
    }
  }
  return { allowed: true };
}
