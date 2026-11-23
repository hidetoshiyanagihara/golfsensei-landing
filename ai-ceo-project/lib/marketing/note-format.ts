/**
 * note 用の記事を「書式つき」でコピーするための変換（Markdown → HTML）。
 * note の編集画面に HTML として貼ると、見出し・太字・箇条書き・引用・区切り線が残る。
 * 使える書き方：## 見出し / ### 小見出し / **太字** / - 箇条書き / 1. 番号 / > 引用 / --- 区切り線 / [図1] 図を入れる場所
 */

export type NoteFigure = { title: string; points: string[] };
export type NoteExtra = { header_subtitle?: string; figures?: NoteFigure[] };

export function parseExtra(json: string | null | undefined): NoteExtra {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

const FIG = /^\[図(\d+)\]$/;

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const t = line.trim();
    let m: RegExpMatchArray | null;
    if (!t) {
      flushPara();
      closeList();
    } else if ((m = t.match(/^(#{2,3})\s+(.+)$/))) {
      flushPara();
      closeList();
      const tag = m[1].length === 2 ? "h2" : "h3";
      out.push(`<${tag}>${inline(m[2])}</${tag}>`);
    } else if (/^#\s+/.test(t)) {
      flushPara();
      closeList();
      out.push(`<h2>${inline(t.replace(/^#\s+/, ""))}</h2>`);
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      closeList();
      out.push("<hr>");
    } else if ((m = t.match(FIG))) {
      flushPara();
      closeList();
      out.push(`<p>▼ここに「図${m[1]}」の画像を入れる</p>`);
    } else if ((m = t.match(/^[-*・]\s+(.+)$/))) {
      flushPara();
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = t.match(/^\d+[.)．]\s+(.+)$/))) {
      flushPara();
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = t.match(/^>\s?(.*)$/))) {
      flushPara();
      closeList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else {
      closeList();
      para.push(t);
    }
  }
  flushPara();
  closeList();
  return out.join("\n");
}

/** 書式なしで貼る場合の文章（記号を取り、図の場所は分かるように残す） */
export function markdownToPlain(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      const f = t.match(FIG);
      if (f) return `▼ここに「図${f[1]}」の画像を入れる`;
      return l.replace(/^#{1,3}\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^>\s?/, "");
    })
    .join("\n");
}
