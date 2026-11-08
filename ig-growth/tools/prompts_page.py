"""assets/プロンプト集_無料配布.md から、プロフィールのリンク先ページ（output/prompts.html）を作る。

スマホで開いて「コピー」を押すだけで使える。Google ドキュメントを作る手間をなくすための自動生成。
公開 URL：https://golfsensei-landing.vercel.app/ai（vercel.json で転送）
"""
from __future__ import annotations

import html
import re

from common import OUTPUT, PROMPTS_MD, load_brand


def parse_prompts() -> list[dict]:
    text = PROMPTS_MD.read_text(encoding="utf-8")
    out = []
    for m in re.finditer(r"^### #(\d{2}) (.+?)\n```\n(.*?)```\n((?:※[^\n]*\n)?)", text, re.S | re.M):
        out.append({"no": m.group(1), "title": m.group(2).strip(), "prompt": m.group(3).rstrip(),
                     "note": m.group(4).strip()})
    return out


def write_page() -> str:
    b = load_brand()
    c = b["colors"]
    handle = b["handle"].lstrip("@")
    items = parse_prompts()
    toc = "".join(f'<a href="#p{p["no"]}">#{p["no"]} {html.escape(p["title"])}</a>' for p in items)
    cards = "".join(
        f'''<section class=card id="p{p["no"]}"><h2><span>#{p["no"]}</span>{html.escape(p["title"])}</h2>
<pre>{html.escape(p["prompt"])}</pre>{f'<p class=note>{html.escape(p["note"])}</p>' if p["note"] else ''}
<button onclick="cp(this)">コピーする</button></section>''' for p in items)
    page = f'''<!doctype html><html lang=ja><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>仕事で使うプロンプト集（無料）｜{html.escape(b["display_name"])}</title>
<meta name=description content="コピペで使えるAIの頼み方。メール・議事録・商談準備・Excelなど。無料のAIで使えます。">
<style>
:root{{--ink:{c["ink"]};--or:{c["orange"]};--bg:{c["cream"]};--gr:{c["gray"]};--ln:{c["line"]}}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--ink);font-family:"Noto Sans JP",-apple-system,"Hiragino Sans",sans-serif;line-height:1.7}}
header{{background:var(--ink);color:#fff;padding:28px 16px}}header h1{{margin:0 0 6px;font-size:24px}}header p{{margin:0;color:#C9CED8;font-size:14px}}
main{{max-width:720px;margin:0 auto;padding:16px}}.warn{{background:#fff;border-left:6px solid var(--or);padding:12px 14px;border-radius:8px;font-size:14px}}
nav{{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0}}nav a{{font-size:12px;background:#fff;border:1px solid var(--ln);border-radius:99px;padding:4px 10px;color:var(--ink);text-decoration:none}}
.card{{background:#fff;border:1px solid var(--ln);border-radius:14px;padding:16px;margin:14px 0;scroll-margin-top:12px}}
.card h2{{font-size:17px;margin:0 0 10px}}.card h2 span{{color:var(--or);margin-right:8px}}
pre{{white-space:pre-wrap;word-break:break-word;background:var(--bg);border-radius:10px;padding:12px;font-size:14px;margin:0;font-family:inherit}}
.note{{font-size:13px;color:var(--gr);margin:8px 0 0}}button{{margin-top:10px;width:100%;padding:12px;border:0;border-radius:10px;background:var(--or);color:#fff;font-size:15px;font-weight:bold}}
button.done{{background:var(--ink)}}footer{{text-align:center;padding:24px 16px 40px}}footer a{{display:inline-block;background:var(--ink);color:#fff;padding:12px 22px;border-radius:99px;text-decoration:none;font-weight:bold}}
</style></head><body>
<header><h1>仕事で使うプロンプト集</h1><p>Instagram @{html.escape(handle)} で紹介した、コピペで使えるAIの頼み方（無料）</p></header>
<main>
<div class=warn><b>使う前に</b><br>（　）の部分を自分の内容に変えて、お使いのAI（ChatGPT・Gemini・Claude・Copilot など）に貼ってください。<br>
お客さんの名前・連絡先、社外秘の数字、パスワードは入れないでください（#02）。AIの答えの数字・日付・名前は、送る前に自分で確認してください（#08）。会社にAIの利用ルールがある場合はそちらに従ってください。</div>
<nav>{toc}</nav>
{cards}
</main>
<footer><p>毎日1つ、新しい頼み方を追加しています</p><a href="https://www.instagram.com/{html.escape(handle)}/">Instagramをフォローする</a></footer>
<script>function cp(b){{const t=b.parentElement.querySelector('pre').innerText;
(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>{{b.textContent='コピーしました';b.classList.add('done');setTimeout(()=>{{b.textContent='コピーする';b.classList.remove('done')}},1600)}})
.catch(()=>{{const r=document.createRange();r.selectNodeContents(b.parentElement.querySelector('pre'));const s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='選択しました。長押しでコピー'}})}}</script>
</body></html>'''
    OUTPUT.mkdir(parents=True, exist_ok=True)
    path = OUTPUT / "prompts.html"
    path.write_text(page, encoding="utf-8")
    return f"{path.name}：{len(items)}件"
