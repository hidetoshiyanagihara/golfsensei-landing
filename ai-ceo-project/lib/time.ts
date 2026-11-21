/** 日付はすべて日本時間（Asia/Tokyo）で扱う。DB には 'YYYY-MM-DD' の文字列で保存する。 */

const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function jstDate(d: Date = new Date()): string {
  return fmt.format(d); // en-CA は YYYY-MM-DD 形式
}

export function jstMonth(d: Date = new Date()): string {
  return jstDate(d).slice(0, 7);
}

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function daysBetween(fromYmd: string, toYmd: string): number {
  const a = Date.parse(fromYmd + "T00:00:00Z");
  const b = Date.parse(toYmd + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

export function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));
}

export function formatDateTimeJst(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") || iso.endsWith("Z") ? iso : iso.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
