"""content/reels/*.md と content/carousels/*.md を読む。

Markdown の中の決まった名前のコードブロックだけを機械が読む：
  ```cover``` ```telop``` ```caption``` ```hashtags``` ```slides```
冒頭の「| 項目 | 内容 |」の表はメタ情報として読む。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from common import CONTENT, PROMPTS_MD

FENCE_RE = re.compile(r"^```(\w+)[ \t]*\n(.*?)^```[ \t]*$", re.S | re.M)
META_RE = re.compile(r"^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|\s*$", re.M)
TELOP_RE = re.compile(r"^\s*([\d.]+)\s*-\s*([\d.]+)\s*\|\s*(.*)$")
SLIDE_KEYS = {"label", "title", "sub", "body", "note", "prompt", "items", "messages",
              "left_label", "left", "right_label", "right"}
LIST_KEYS = {"items", "messages"}


@dataclass
class Telop:
    start: float
    end: float
    text: str


@dataclass
class Item:
    id: str
    kind: str                # "reel" / "carousel"
    path: Path
    title: str
    meta: dict
    blocks: dict
    cover: dict = field(default_factory=dict)
    telops: list = field(default_factory=list)
    slides: list = field(default_factory=list)
    video: dict = field(default_factory=dict)
    prompt_text: str = ""

    @property
    def caption(self) -> str:
        return self.blocks.get("caption", "").strip()

    @property
    def hashtags(self) -> list[str]:
        return self.blocks.get("hashtags", "").split()

    def full_caption(self) -> str:
        return f"{self.caption}\n.\n.\n{' '.join(self.hashtags)}".strip()


def _unescape(s: str) -> str:
    return s.replace("\\n", "\n")


def parse_kv_block(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            out[k.strip()] = _unescape(v.strip())
    return out


def parse_telop(text: str) -> list[Telop]:
    telops = []
    for line in text.splitlines():
        if not line.strip():
            continue
        m = TELOP_RE.match(line)
        if not m:
            raise ValueError(f"テロップの書式が違います（例「0.0-2.0 | 文字」）：{line}")
        telops.append(Telop(float(m.group(1)), float(m.group(2)), _unescape(m.group(3).strip())))
    return telops


def parse_slides(text: str) -> list[dict]:
    """`=== 種類` で区切り、`key: 値` を読む。値が空か `|` のときは次の行から（2字下げ or `- `）を集める。"""
    slides: list[dict] = []
    cur: dict | None = None
    key: str | None = None
    for raw in text.splitlines():
        m = re.match(r"^===\s*(\w+)\s*$", raw)
        if m:
            cur = {"type": m.group(1)}
            slides.append(cur)
            key = None
            continue
        if cur is None:
            continue
        km = re.match(r"^(\w+):\s?(.*)$", raw)
        if km and km.group(1) in SLIDE_KEYS:
            key, val = km.group(1), km.group(2).strip()
            if key in LIST_KEYS:
                cur[key] = []
            elif val in ("", "|"):
                cur[key] = ""
            else:
                cur[key] = _unescape(val)
                key = None
            continue
        if key is None or not raw.strip():
            continue
        if key in LIST_KEYS:
            cur[key].append(_unescape(re.sub(r"^\s*-\s?", "", raw)))
        else:
            line = raw[2:] if raw.startswith("  ") else raw.lstrip()
            cur[key] = (cur[key] + "\n" + line) if cur[key] else line
    return slides


def parse_file(path: Path, kind: str) -> Item:
    text = path.read_text(encoding="utf-8")
    title_m = re.search(r"^#\s+(.+)$", text, re.M)
    blocks = {m.group(1): m.group(2) for m in FENCE_RE.finditer(text)}
    head = text.split("\n## ", 1)[0]
    meta = {k: v for k, v in META_RE.findall(head) if k not in ("項目", "---") and not set(k) <= set("-")}
    item_id = meta.get("ID") or path.stem.split("_")[0]
    item = Item(id=item_id, kind=kind, path=path, title=title_m.group(1) if title_m else path.stem,
                meta=meta, blocks=blocks)
    if "cover" in blocks:
        item.cover = parse_kv_block(blocks["cover"])
    if "telop" in blocks:
        item.telops = parse_telop(blocks["telop"])
    if "slides" in blocks:
        item.slides = parse_slides(blocks["slides"])
    if "video" in blocks:
        item.video = parse_kv_block(blocks["video"])
    sec = re.search(r"^## 入力するプロンプト[^\n]*\n(.*?)(?=^## )", text, re.S | re.M)
    if sec:
        plain = re.findall(r"^```[ \t]*\n(.*?)^```", sec.group(1), re.S | re.M)
        if plain:
            item.prompt_text = plain[-1].strip()
    return item


def load_items(kind: str | None = None, ids: list[str] | None = None) -> list[Item]:
    items = []
    for k, folder in (("reel", "reels"), ("carousel", "carousels")):
        if kind and kind != k:
            continue
        for p in sorted((CONTENT / folder).glob("*.md")):
            it = parse_file(p, k)
            if ids and it.id not in ids:
                continue
            items.append(it)
    return items


def prompt_numbers() -> set[str]:
    """プロンプト集に載っている番号（#00〜）。"""
    if not PROMPTS_MD.exists():
        return set()
    return set(re.findall(r"^###\s+#(\d{2})", PROMPTS_MD.read_text(encoding="utf-8"), re.M))


def to_srt(telops: list[Telop]) -> str:
    def ts(sec: float) -> str:
        ms = int(round(sec * 1000))
        h, ms = divmod(ms, 3_600_000)
        m, ms = divmod(ms, 60_000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    out = []
    for i, t in enumerate(telops, 1):
        out.append(f"{i}\n{ts(t.start)} --> {ts(t.end)}\n{t.text}\n")
    return "\n".join(out)
