import { Notice } from "./ui";

/** Server Action の結果（?ok= / ?err=）を表示する */
export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (err) return <div className="mb-4"><Notice tone="bad">{err}</Notice></div>;
  if (ok) return <div className="mb-4"><Notice>{ok}</Notice></div>;
  return null;
}

export type FlashParams = Promise<{ ok?: string; err?: string }>;
