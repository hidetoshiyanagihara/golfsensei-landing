import { ImageResponse } from "next/og";
import { loadJpFont } from "./font";
import type { Slide } from "./note-format";

/**
 * 投稿用の画像の共通部品（note の見出し・図解、Instagram のスライド、YouTube ショートのコマ）。
 * 管理画面の画像（app/api/note-image）と、YouTube ショートを作るスクリプト（scripts/youtube-shorts.ts）の両方で使う。
 */
export const NAVY = "#080d1a";
export const PANEL = "#0e1628";
export const GOLD = "#d4b062";
export const WHITE = "#f4f6fa";
export const MUTED = "#a7b1c6";

export async function fontsFor(text: string) {
  const [bold, regular] = await Promise.all([loadJpFont(text, 700), loadJpFont(text, 400)]);
  const fonts: { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }[] = [];
  if (regular) fonts.push({ name: "NotoSansJP", data: regular, weight: 400, style: "normal" });
  if (bold) fonts.push({ name: "NotoSansJP", data: bold, weight: 700, style: "normal" });
  return fonts;
}

export function image(el: React.ReactElement, width: number, height: number, fonts: Awaited<ReturnType<typeof fontsFor>>, filename: string | null) {
  return new ImageResponse(
    <div style={{ display: "flex", width: "100%", height: "100%", fontFamily: "NotoSansJP" }}>{el}</div>,
    {
      width,
      height,
      fonts: fonts.length ? fonts : undefined,
      headers: {
        "Cache-Control": "private, no-store",
        ...(filename ? { "Content-Disposition": `attachment; filename="${filename}"` } : {}),
      },
    },
  );
}

/**
 * スライド1枚。feed＝Instagram（1080×1350）、short＝YouTube ショート（1080×1920）。
 * ショートは画面の上下に YouTube のボタンや説明文が重なるため、上下を広めにあける。
 */
export async function renderSlide(slides: Slide[], n: number, format: "feed" | "short" = "feed", filename: string | null = null): Promise<Response | null> {
  const sl = slides[n - 1];
  if (!sl) return null;
  const total = slides.length;
  const short = format === "short";
  const fonts = await fontsFor(`${sl.heading}${sl.text}${n}/${total}HIDE｜AI CEO PROJECT0123456789`);
  const cover = n === 1;
  const hs = [...sl.heading].length <= 14 ? 76 : [...sl.heading].length <= 24 ? 64 : 52;
  return image(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: NAVY, padding: short ? "260px 84px 440px" : "80px 84px 72px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, color: GOLD, fontSize: 26, letterSpacing: 6 }}>
        <div style={{ display: "flex", width: 48, height: 5, background: GOLD }} />
        {cover ? "AI CEO PROJECT" : `${String(n - 1).padStart(2, "0")}`}
      </div>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", flexGrow: 1, gap: 44 }}>
        <div style={{ display: "flex", color: WHITE, fontSize: cover ? hs + 18 : hs, fontWeight: 700, lineHeight: 1.32 }}>{sl.heading}</div>
        {sl.text && (
          <div style={{ display: "flex", color: cover ? GOLD : WHITE, fontSize: cover ? 42 : 46, lineHeight: 1.7, borderLeft: cover ? "none" : `6px solid ${GOLD}`, paddingLeft: cover ? 0 : 28 }}>
            {sl.text}
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `2px solid ${GOLD}`, paddingTop: 24 }}>
        <div style={{ color: WHITE, fontSize: 28, fontWeight: 700 }}>HIDE｜AI CEO PROJECT</div>
        <div style={{ color: GOLD, fontSize: 28 }}>{`${n}/${total}`}</div>
      </div>
    </div>,
    1080,
    short ? 1920 : 1350,
    fonts,
    filename,
  );
}
