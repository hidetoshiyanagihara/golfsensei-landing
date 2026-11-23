import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Slide } from "../marketing/note-format";
import { renderSlide } from "../marketing/slide-image";

const exec = promisify(execFile);

/** 1枚あたりの表示秒数：表紙は短め、最後の1枚（保存・フォローのお願い）は長め */
export function slideSeconds(n: number, total: number): number {
  if (n === 1) return 3;
  if (n === total) return 4.5;
  return 4;
}

/** ffmpeg の concat 用の一覧（最後の1枚は2回書くのが決まり） */
export function concatList(files: string[], total: number): string {
  const lines = files.flatMap((f, i) => [`file '${f.replace(/'/g, "'\\''")}'`, `duration ${slideSeconds(i + 1, total)}`]);
  return [...lines, `file '${files[files.length - 1].replace(/'/g, "'\\''")}'`, ""].join("\n");
}

/**
 * スライドから縦長（1080×1920）の動画を作る。音は無音（著作権の心配がない）。
 * ffmpeg が必要（GitHub Actions の ubuntu には最初から入っている）。
 */
export async function makeShortVideo(slides: Slide[], ffmpeg = process.env.FFMPEG_PATH || "ffmpeg"): Promise<Uint8Array> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "short-"));
  try {
    const files: string[] = [];
    for (let n = 1; n <= slides.length; n++) {
      const res = await renderSlide(slides, n, "short");
      if (!res || !res.ok) throw new Error(`${n}枚目の画像を作れませんでした`);
      const f = path.join(dir, `s${String(n).padStart(2, "0")}.png`);
      await fs.writeFile(f, Buffer.from(await res.arrayBuffer()));
      files.push(f);
    }
    const list = path.join(dir, "list.txt");
    await fs.writeFile(list, concatList(files, slides.length));
    const out = path.join(dir, "short.mp4");
    await exec(
      ffmpeg,
      ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
        "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-b:a", "96k",
        "-shortest", "-movflags", "+faststart", out],
      { timeout: 180_000 },
    );
    return new Uint8Array(await fs.readFile(out));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
