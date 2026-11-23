import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, markdownToPlain, parseExtra } from "../../lib/marketing/note-format";

test("note 用の書式つき変換（見出し・太字・箇条書き・番号・引用・区切り線・図の場所）", () => {
  const html = markdownToHtml("## はじめに\n今日は**大事な話**です。\n2行目\n\n- A\n- B\n\n1. 一\n2. 二\n\n> 引用\n\n---\n\n### 小見出し\n[図1]");
  assert.equal(
    html,
    [
      "<h2>はじめに</h2>",
      "<p>今日は<strong>大事な話</strong>です。<br>2行目</p>",
      "<ul>", "<li>A</li>", "<li>B</li>", "</ul>",
      "<ol>", "<li>一</li>", "<li>二</li>", "</ol>",
      "<blockquote>引用</blockquote>",
      "<hr>",
      "<h3>小見出し</h3>",
      "<p>▼ここに「図1」の画像を入れる</p>",
    ].join("\n"),
  );
});

test("HTMLとして危ない文字は無害化する", () => {
  assert.equal(markdownToHtml('<script>alert("x")</script>'), "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>");
});

test("書式なしの文章・追加情報の読み込み", () => {
  assert.equal(markdownToPlain("## 見出し\n**太字**\n[図2]"), "見出し\n太字\n▼ここに「図2」の画像を入れる");
  assert.deepEqual(parseExtra(null), {});
  assert.deepEqual(parseExtra("{"), {});
  assert.deepEqual(parseExtra('{"figures":[{"title":"t","points":["a"]}]}').figures, [{ title: "t", points: ["a"] }]);
});
