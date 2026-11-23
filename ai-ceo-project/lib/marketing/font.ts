/**
 * 画像に使う日本語フォント（Noto Sans JP）を Google Fonts から読み込む。
 * 画像に出てくる文字だけを含む小さなフォントを取り寄せるので速い（数KB〜数十KB）。
 */
const cache = new Map<string, ArrayBuffer>();

export async function loadJpFont(text: string, weight: 400 | 700): Promise<ArrayBuffer | null> {
  const chars = [...new Set([...text])].sort().join("");
  const key = `${weight}:${chars}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const css = await (
      await fetch(`https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@${weight}&text=${encodeURIComponent(chars)}`, { signal: AbortSignal.timeout(8000) })
    ).text();
    const url = css.match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\('(?:truetype|opentype)'\)/)?.[1];
    if (!url) return null;
    const data = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).arrayBuffer();
    if (cache.size > 200) cache.clear();
    cache.set(key, data);
    return data;
  } catch {
    return null;
  }
}
