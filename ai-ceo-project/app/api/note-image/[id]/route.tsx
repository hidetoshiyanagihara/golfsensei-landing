import { ImageResponse } from "next/og";
import { getDb } from "@/lib/database/db";
import { get } from "@/lib/database/db";
import { isAuthenticated } from "@/lib/security/auth";
import { parseExtra } from "@/lib/marketing/note-format";
import { loadJpFont } from "@/lib/marketing/font";
import { verifyImage } from "@/lib/social/image-sign";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

/**
 * 投稿用の画像。ログインしている代表者、または期限つきの署名付きリンク（Instagram 投稿時に Meta が取りに来る）だけが見られる。
 *   note：     /api/note-image/12?kind=header（1280×670） /api/note-image/12?kind=fig&n=1（1280×720）
 *   Instagram：/api/note-image/15?kind=slide&n=1（1080×1350）  &format=jpg で JPEG（Instagram は JPEG のみ）
 */
export const dynamic = "force-dynamic";

const NAVY = "#080d1a";
const PANEL = "#0e1628";
const GOLD = "#d4b062";
const WHITE = "#f4f6fa";
const MUTED = "#a7b1c6";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) return new Response("Not found", { status: 404 });
  const url = new URL(req.url);
  const q = url.searchParams;
  const kind = q.get("kind") === "fig" ? "fig" : q.get("kind") === "slide" ? "slide" : "header";
  const signed = q.has("sig") && verifyImage(id, kind, Number(q.get("n") ?? 0), Number(q.get("exp")), q.get("sig") ?? "");
  if (!signed && !(await isAuthenticated())) return new Response("Unauthorized", { status: 401 });
  const db = await getDb();
  const post = await get<{ title: string; extra: string | null; platform: string }>(
    db,
    "SELECT title, extra, platform FROM content_posts WHERE id = ? AND data_kind = 'actual'",
    [id],
  );
  if (!post || (post.platform !== "note" && post.platform !== "instagram")) return new Response("Not found", { status: 404 });
  if ((kind === "slide") !== (post.platform === "instagram")) return new Response("Not found", { status: 404 });
  const extra = parseExtra(post.extra);
  const download = q.get("download") === "1";
  const asJpeg = q.get("format") === "jpg";

  if (kind === "slide") {
    const slides = extra.slides ?? [];
    const n = Math.max(1, Number(q.get("n") ?? 1));
    const sl = slides[n - 1];
    if (!sl) return new Response("Not found", { status: 404 });
    const total = slides.length;
    const fonts = await fontsFor(`${sl.heading}${sl.text}${n}/${total}HIDE｜AI CEO PROJECT保存して見返す`);
    const cover = n === 1;
    const hs = [...sl.heading].length <= 14 ? 76 : [...sl.heading].length <= 24 ? 64 : 52;
    const res = image(
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: NAVY, padding: "88px 84px 72px", justifyContent: cover ? "center" : "flex-start", gap: 40 }}>
        {!cover && <div style={{ display: "flex", color: GOLD, fontSize: 34, fontWeight: 700 }}>{`${String(n - 1).padStart(2, "0")}`}</div>}
        {cover && <div style={{ display: "flex", width: 64, height: 6, background: GOLD }} />}
        <div style={{ display: "flex", color: WHITE, fontSize: cover ? hs + 8 : hs - 8, fontWeight: 700, lineHeight: 1.35 }}>{sl.heading}</div>
        {sl.text && <div style={{ display: "flex", color: cover ? MUTED : WHITE, fontSize: cover ? 38 : 42, lineHeight: 1.65 }}>{sl.text}</div>}
        <div style={{ display: "flex", flexGrow: 1 }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: `2px solid ${GOLD}`, paddingTop: 24 }}>
          <div style={{ color: WHITE, fontSize: 28, fontWeight: 700 }}>HIDE｜AI CEO PROJECT</div>
          <div style={{ color: GOLD, fontSize: 28 }}>{`${n}/${total}`}</div>
        </div>
      </div>,
      1080,
      1350,
      fonts,
      download ? `instagram-${id}-${n}.${asJpeg ? "jpg" : "png"}` : null,
    );
    return asJpeg ? toJpeg(res, download ? `instagram-${id}-${n}.jpg` : null) : res;
  }
  const title = post.title.replace(/^note[①-⑩\d]*[：:]\s*/, "");

  if (kind === "header") {
    const subtitle = extra.header_subtitle ?? "";
    const allText = `AI CEO PROJECT HIDE｜ONE HUMAN. MANY AI EMPLOYEES.${title}${subtitle}`;
    const fonts = await fontsFor(allText);
    const size = [...title].length <= 18 ? 68 : [...title].length <= 32 ? 56 : 46;
    return image(
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: NAVY, padding: "64px 80px", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 44, height: 4, background: GOLD }} />
          <div style={{ color: GOLD, fontSize: 24, letterSpacing: 8 }}>AI CEO PROJECT</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ color: WHITE, fontSize: size, fontWeight: 700, lineHeight: 1.35 }}>{title}</div>
          {subtitle && <div style={{ color: MUTED, fontSize: 30, lineHeight: 1.5 }}>{subtitle}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", borderTop: `2px solid ${GOLD}`, paddingTop: 20 }}>
          <div style={{ color: WHITE, fontSize: 26, fontWeight: 700 }}>HIDE｜AI CEO PROJECT</div>
          <div style={{ color: GOLD, fontSize: 18, letterSpacing: 4 }}>ONE HUMAN. MANY AI EMPLOYEES.</div>
        </div>
      </div>,
      1280,
      670,
      fonts,
      download ? `note-${id}-header.png` : null,
    );
  }

  const n = Math.max(1, Number(url.searchParams.get("n") ?? 1));
  const fig = extra.figures?.[n - 1];
  if (!fig) return new Response("Not found", { status: 404 });
  const points = fig.points.slice(0, 5);
  const fonts = await fontsFor(`図${n}${fig.title}${points.join("")}0123456789HIDE｜AI CEO PROJECT`);
  return image(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: NAVY, padding: "56px 72px", gap: 32 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ color: NAVY, background: GOLD, fontSize: 24, fontWeight: 700, padding: "6px 16px", borderRadius: 6 }}>{`図${n}`}</div>
        <div style={{ color: WHITE, fontSize: 44, fontWeight: 700 }}>{fig.title}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 18, flexGrow: 1 }}>
        {points.map((p, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 22, background: PANEL, borderLeft: `6px solid ${GOLD}`, padding: "18px 26px", borderRadius: 6 }}>
            <div style={{ color: GOLD, fontSize: 34, fontWeight: 700, width: 40 }}>{String(i + 1)}</div>
            <div style={{ color: WHITE, fontSize: points.length > 4 ? 28 : 32, lineHeight: 1.4, flexShrink: 1 }}>{p}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", color: MUTED, fontSize: 20 }}>HIDE｜AI CEO PROJECT</div>
    </div>,
    1280,
    720,
    fonts,
    download ? `note-${id}-fig${n}.png` : null,
  );
}

async function fontsFor(text: string) {
  const [bold, regular] = await Promise.all([loadJpFont(text, 700), loadJpFont(text, 400)]);
  const fonts: { name: string; data: ArrayBuffer; weight: 400 | 700; style: "normal" }[] = [];
  if (regular) fonts.push({ name: "NotoSansJP", data: regular, weight: 400, style: "normal" });
  if (bold) fonts.push({ name: "NotoSansJP", data: bold, weight: 700, style: "normal" });
  return fonts;
}

function image(el: React.ReactElement, width: number, height: number, fonts: Awaited<ReturnType<typeof fontsFor>>, filename: string | null) {
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

/** PNG を JPEG に変換する（Instagram は JPEG しか受け付けない） */
async function toJpeg(res: Response, filename: string | null): Promise<Response> {
  const png = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
  const out = jpeg.encode({ data: png.data, width: png.width, height: png.height }, 90);
  return new Response(new Uint8Array(out.data), {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, no-store",
      ...(filename ? { "Content-Disposition": `attachment; filename="${filename}"` } : {}),
    },
  });
}
