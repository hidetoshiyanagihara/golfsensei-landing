"""リール動画（1080x1920・30fps）を台本から自動で作る。

- テロップ 1 行＝1 シーン。最初はフック（濃紺）、最後は CTA（濃紺）、間は生成りの背景に大きな文字
- ```video``` の prompt: の時間帯は「コピペ用」カードにプロンプトが打ち込まれていく演出
- AI の返答そのものは映さない（作り話をしないため。返答の例が必要なら手で画面録画する）
- BGM は ../axion-autopost/autopost/bgm.py で毎回オリジナル曲を作曲（著作権の心配なし・無料）
- 文字は Instagram の UI と重ならない範囲（左右 80〜900px、上下 260〜1400px）に置く
"""
from __future__ import annotations

import importlib.util
import re
import subprocess
import tempfile
import zlib
from pathlib import Path

from PIL import Image, ImageDraw

import render as R
from common import OUTPUT, ROOT, load_brand

FPS = 30
W, H = 1080, 1920
X0, X1 = 80, 900          # 右 180px はいいね・コメントのボタン
Y0, Y1 = 260, 1400        # 下 25% はキャプション
POP = 0.25                # 文字が出てくるアニメーションの秒数


def _bgm_module():
    path = ROOT.parent / "axion-autopost" / "autopost" / "bgm.py"
    spec = importlib.util.spec_from_file_location("ig_bgm", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _accent_quotes(text: str) -> str:
    """「」で囲まれた部分をオレンジにする（すでに ** があればそのまま）。"""
    if "**" in text:
        return text
    return re.sub(r"(「[^」]+」)", r"**\1**", text)


BREAK_AFTER = set("、。はがをにでともへ」”？！")


def smart_break(text: str, limit: int = 9) -> str:
    """改行のない長い行を、助詞・読点の後ろで真ん中に近い位置で 2 行に分ける（「」の中では切らない）。"""
    out = []
    for line in text.split("\n"):
        plain = line.replace("**", "")
        if len(plain) <= limit:
            out.append(line)
            continue
        depth, best, mid = 0, None, len(line) / 2
        for i, ch in enumerate(line[:-2]):
            depth += (ch == "「") - (ch == "」")
            if ch in BREAK_AFTER and depth == 0 and i >= 2 and len(line) - (i + 1) >= 3:
                if best is None or abs(i + 1 - mid) < abs(best - mid):
                    best = i + 1
        out.append(line[:best] + "\n" + line[best:] if best else line)
    return "\n".join(out)


def build_scenes(item) -> list[dict]:
    rng = item.video.get("prompt", "")
    p0 = p1 = None
    if rng:
        a, b = rng.split("-")
        p0, p1 = float(a), float(b)
    scenes = []
    for i, t in enumerate(item.telops):
        if p0 is not None and t.start >= p0 - 1e-6 and t.end <= p1 + 1e-6:
            if scenes and scenes[-1]["kind"] == "prompt":
                scenes[-1]["end"] = t.end
            else:
                scenes.append({"kind": "prompt", "start": t.start, "end": t.end,
                               "text": item.video.get("heading") or t.text})
            continue
        kind = "hook" if i == 0 else ("cta" if i == len(item.telops) - 1 else "text")
        scenes.append({"kind": kind, "start": t.start, "end": t.end, "text": t.text})
    return scenes


class ReelVideo:
    def __init__(self, item, brand: dict):
        self.item = item
        self.b = brand
        self.c = {k: R.hex2rgb(v) for k, v in brand["colors"].items()}
        self.scenes = build_scenes(item)
        self.total = item.telops[-1].end if item.telops else 0
        self._cache: dict = {}

    # ------------------------------------------------------------ 部品
    def _progress(self, d, t):
        d.rectangle([0, 0, W, 10], fill=(60, 68, 86) if t is None else self.c["line"])
        if t is not None:
            d.rectangle([0, 0, int(W * min(t / self.total, 1)), 10], fill=self.c["orange"])

    def _label(self, d, y):
        lab = self.item.cover.get("label", "")
        if lab:
            R.pill(d, X0, y, lab, R.font("Bold", 40), self.c["orange"], self.c["white"], 30, 14)

    def _base(self, scene) -> Image.Image:
        """アニメーションしない部分（背景・文字）を 1 回だけ描く。"""
        key = ("base", id(scene))
        if key in self._cache:
            return self._cache[key]
        dark = scene["kind"] in ("hook", "cta")
        img = Image.new("RGB", (W, H), self.c["ink"] if dark else self.c["cream"])
        d = ImageDraw.Draw(img)
        pal = {"text": self.c["white"] if dark else self.c["ink"], "accent": self.c["orange"], "marker": self.c["marker"]}
        text = _accent_quotes(smart_break(scene["text"]))
        if scene["kind"] == "hook":
            self._label(d, Y0 + 40)
            f, lines, lh = R.fit(text, "Black", 120, 64, X1 - X0, 620, 1.3, f"{self.item.id} 動画", keep_lines=True)
            y = Y0 + 200 + max(0, (620 - len(lines) * lh) // 2)
            R.draw_lines(d, lines, f, lh, X0, y, pal)
        elif scene["kind"] == "cta":
            f, lines, lh = R.fit(text, "Black", 92, 56, X1 - X0, 400, 1.3, f"{self.item.id} 動画", keep_lines=True)
            y = R.draw_lines(d, lines, f, lh, X0, Y0 + 180, pal) + 70
            d.rounded_rectangle([X0, y, X1, y + 300], radius=30, fill=self.c["white"])
            d.text((X0 + 44, y + 44), self.b["handle"], font=R.font("Black", 48), fill=self.c["ink"])
            d.text((X0 + 44, y + 120), self.b["promise"], font=R.font("Medium", 34), fill=self.c["gray"])
            R.pill(d, X0 + 44, y + 192, "フォローする", R.font("Bold", 34), self.c["orange"], self.c["white"], 40, 14)
        elif scene["kind"] == "text":
            f, lines, lh = R.fit(text, "Black", 104, 56, X1 - X0, 700, 1.35, f"{self.item.id} 動画", keep_lines=True)
            block_h = len(lines) * lh
            y = Y0 + (Y1 - Y0 - block_h) // 2 - 60
            R.draw_lines(d, lines, f, lh, X0, y, pal)
            d.rectangle([X0, y + block_h + 30, X0 + 90, y + block_h + 40], fill=self.c["orange"])
        else:  # prompt の見出し
            f, lines, lh = R.fit(text, "Black", 80, 48, X1 - X0, 240, 1.3, f"{self.item.id} 動画", keep_lines=True)
            R.draw_lines(d, lines, f, lh, X0, Y0 + 60, pal)
            scene["_card_top"] = Y0 + 60 + len(lines) * lh + 70
        d.text((X0, Y1 + 40), self.b["handle"], font=R.font("Medium", 32),
               fill=self.c["cover_sub"] if dark else self.c["gray"])
        self._cache[key] = img
        return img

    def _prompt_frame(self, scene, local_t: float) -> Image.Image:
        dur = scene["end"] - scene["start"]
        text = self.item.prompt_text or "（プロンプト）"
        n = len(text)
        typed = min(n, int(n * min(local_t / (dur * 0.7), 1)))
        caret = (int(local_t * 2) % 2 == 0) or typed < n
        key = ("p", id(scene), typed, caret)
        if key in self._cache:
            return self._cache[key]
        img = self._base(scene).copy()
        d = ImageDraw.Draw(img)
        top = scene["_card_top"]
        pad = 40
        # カードの大きさは全文で決める（打っている途中で枠が伸び縮みしない）
        f, lines_all, lh = R.fit(text, "Medium", 44, 26, X1 - X0 - pad * 2, Y1 - top - pad * 2 - 30, 1.55,
                                 f"{self.item.id} 動画プロンプト")
        card_h = len(lines_all) * lh + pad * 2
        d.rounded_rectangle([X0, top, X1, top + card_h], radius=26, fill=self.c["white"], outline=self.c["ink"], width=4)
        R.pill(d, X0 + 28, top - 26, "コピペ用", R.font("Bold", 30), self.c["orange"], self.c["white"], 22, 8)
        shown = R.wrap(text[:typed], f, X1 - X0 - pad * 2) if typed else [[]]
        y_end = R.draw_lines(d, shown, f, lh, X0 + pad, top + pad, {"text": self.c["ink"], "accent": self.c["orange"],
                                                                    "marker": self.c["marker"]})
        if caret:
            cx = X0 + pad + R.line_width(shown[-1], f) + 4
            cy = y_end - lh
            d.rectangle([cx, cy + 6, cx + 5, cy + f.size + 10], fill=self.c["orange"])
        if typed >= n:
            note = "全文はプロフィールのリンクに"
            d.text((X0, top + card_h + 30), note, font=R.font("Bold", 34), fill=self.c["orange"])
        if len(self._cache) > 400:
            self._cache = {k: v for k, v in self._cache.items() if k[0] == "base"}
        self._cache[key] = img
        return img

    def frame(self, t: float) -> Image.Image:
        scene = next((s for s in self.scenes if s["start"] <= t < s["end"]), self.scenes[-1])
        local = t - scene["start"]
        if scene["kind"] == "prompt":
            img = self._prompt_frame(scene, local)
        else:
            base = self._base(scene)
            if local < POP and scene["kind"] != "hook":  # ふわっと出る（最初の画面は 0 秒から見せる）：背景に重ねて透明度と位置を変える
                a = local / POP
                bg = Image.new("RGB", (W, H), base.getpixel((5, H // 2)))
                shifted = Image.new("RGB", (W, H), base.getpixel((5, H // 2)))
                shifted.paste(base, (0, int(40 * (1 - a))))
                img = Image.blend(bg, shifted, a)
            else:
                img = base
        img = img.copy()
        d = ImageDraw.Draw(img)
        self._progress(d, t)
        return img

    # ------------------------------------------------------------ 書き出し
    def write(self, out: Path) -> Path:
        import imageio_ffmpeg
        out.parent.mkdir(parents=True, exist_ok=True)
        n_frames = int(round(self.total * FPS))
        with tempfile.TemporaryDirectory() as tmp:
            bgm = Path(tmp) / "bgm.wav"
            _bgm_module().make_bgm(self.total + 1, str(bgm), zlib.crc32(self.item.id.encode()) + 7)
            fade = f"afade=t=in:st=0:d=0.4,afade=t=out:st={max(0, self.total - 1.2):.2f}:d=1.2"
            cmd = [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error",
                   "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                   "-i", str(bgm), "-filter_complex", f"[1:a]aresample=44100,volume=0.55,{fade}[a]",
                   "-map", "0:v", "-map", "[a]", "-t", f"{self.total:.2f}",
                   "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "23", "-r", str(FPS),
                   "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", str(out)]
            proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
            last_key, last_bytes = None, None
            for i in range(n_frames):
                img = self.frame(i / FPS)
                b = img.tobytes() if img is not last_key else last_bytes
                last_key, last_bytes = img, b
                proc.stdin.write(b)
            proc.stdin.close()
            if proc.wait() != 0:
                raise RuntimeError(f"{self.item.id}: 動画の書き出しに失敗しました（ffmpeg）")
        return out


def render_videos(ids: list[str] | None = None) -> list[Path]:
    import content
    brand = load_brand()
    outs = []
    for it in content.load_items("reel", ids or None):
        if not it.telops:
            continue
        outs.append(ReelVideo(it, brand).write(OUTPUT / "videos" / f"{it.id}.mp4"))
    return outs


def preview_frames(item_id: str, times: list[float], out: Path) -> Path:
    """確認用：指定した秒のコマを横に並べた画像。"""
    import content
    it = content.load_items("reel", [item_id])[0]
    v = ReelVideo(it, load_brand())
    frames = [v.frame(t).resize((360, 640)) for t in times]
    sheet = Image.new("RGB", (370 * len(frames), 640), "white")
    for i, f in enumerate(frames):
        sheet.paste(f, (i * 370, 0))
    sheet.save(out)
    return out
