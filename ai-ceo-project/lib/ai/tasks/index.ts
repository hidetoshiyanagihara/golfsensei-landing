import { registerTask, type TaskDef } from "../runner";
import { ceoMeetingTask } from "./ceo-meeting";
import { marketResearchTask } from "./market-research";

/** 動作確認用（AIを使わない・0円）。裏側の実行の仕組みが動くかを確かめる */
export const pingTask: TaskDef = {
  name: "system.ping",
  agentId: "ceo",
  label: "動作確認（AIは使わない・0円）",
  usesAi: false,
  estimateJpy: () => 0,
  async run({ params }) {
    const seconds = Math.min(Math.max(Number(params.seconds ?? 0), 0), 120);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return { aiOutput: "", executionResult: `動作確認OK（${seconds}秒待機）`, model: "none", usage: { inputTokens: 0, outputTokens: 0, webSearches: 0 } };
  },
};

let done = false;
export function registerAllTasks(): void {
  if (done) return;
  done = true;
  registerTask(ceoMeetingTask);
  registerTask(marketResearchTask);
  registerTask(pingTask);
}
registerAllTasks();

export { ceoMeetingTask, marketResearchTask };
