"""テスト用のローカル疑似サイト。ホスト(127.0.0.X)ごとに別会社のサイトとして振る舞う。"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = 8765
POSTS = []  # 受信したフォーム送信

H = lambda title, body: f"""<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>{title}</title></head><body>{body}</body></html>"""

FORM_A = """
<h1>お問い合わせ</h1>
<p>お問い合わせいただきありがとうございます。下記フォームにご入力ください。</p>
<form method="post" action="/confirm">
<table>
<tr><th>会社名</th><td><input type="text" name="company"></td></tr>
<tr><th>お名前<span>必須</span></th><td><input type="text" name="sei" placeholder="姓" required><input type="text" name="mei" placeholder="名" required></td></tr>
<tr><th>フリガナ<span>必須</span></th><td><input type="text" name="sei_kana" placeholder="セイ" required><input type="text" name="mei_kana" placeholder="メイ" required></td></tr>
<tr><th>メールアドレス<span>必須</span></th><td><input type="email" name="email" required></td></tr>
<tr><th>メールアドレス（確認用）<span>必須</span></th><td><input type="email" name="email2" required></td></tr>
<tr><th>電話番号<span>必須</span></th><td><input type="tel" name="tel1" size="4" required>-<input type="tel" name="tel2" size="4" required>-<input type="tel" name="tel3" size="4" required></td></tr>
<tr><th>郵便番号</th><td><input type="text" name="zip" placeholder="1234567"></td></tr>
<tr><th>ご住所</th><td><input type="text" name="address"></td></tr>
<tr><th>お問い合わせ種別<span>必須</span></th><td>
 <label><input type="radio" name="kind" value="見積">お見積りのご依頼</label>
 <label><input type="radio" name="kind" value="採用">採用について</label>
 <label><input type="radio" name="kind" value="other">その他</label></td></tr>
<tr><th>お問い合わせ内容<span>必須</span></th><td><textarea name="body" required></textarea></td></tr>
</table>
<label><input type="checkbox" name="agree" value="1" required> 個人情報の取り扱いに同意する</label>
<button type="reset">リセット</button>
<input type="submit" value="確認画面へ">
</form>"""

FORM_F = """
<h2>CONTACT</h2>
<p>営業時間 9:00〜18:00（営業時間外のお電話はご遠慮ください）</p>
<div class="form" id="f">
 <div class="row"><label for="c">貴社名</label><input id="c" name="your-company" maxlength="15"></div>
 <div class="row"><label for="n">お名前 *</label><input id="n" name="your-name" required></div>
 <div class="row"><label for="k">ふりがな *</label><input id="k" name="your-kana" required></div>
 <div class="row"><label for="m">E-mail *</label><input id="m" name="your-email" type="text" required></div>
 <div class="row"><label for="t">TEL</label><input id="t" name="your-tel" maxlength="11" placeholder="09012345678"></div>
 <div class="row"><label for="s">件名</label><input id="s" name="your-subject"></div>
 <div class="row"><label for="cat">ご用件 *</label><select id="cat" name="cat" required>
   <option value="">選択してください</option><option>施工のご依頼</option><option>その他のお問い合わせ</option></select></div>
 <div class="row"><label for="pref">都道府県</label><select id="pref" name="pref"><option value="">--</option><option>岐阜県</option><option>愛知県</option></select></div>
 <div class="row"><label for="a">住所</label><input id="a" name="addr"></div>
 <div class="row"><label for="msg">メッセージ *</label><textarea id="msg" name="msg" required></textarea></div>
 <span class="chk"><input type="checkbox" id="pp" name="pp" style="opacity:0;position:absolute"><label for="pp">プライバシーポリシーに同意</label></span>
 <button type="button" id="send">送信する</button>
 <div id="out"></div>
</div>
<script>
document.getElementById('send').onclick = async () => {
  const fd = new URLSearchParams();
  document.querySelectorAll('#f input, #f select, #f textarea').forEach(e => { if (e.type !== 'checkbox' || e.checked) fd.append(e.name, e.value); });
  if (!document.getElementById('pp').checked) { document.getElementById('out').innerText = '同意が必要です。入力してください'; return; }
  await new Promise(res => setTimeout(res, 15000));  // 送信処理に時間がかかるサイト
  const r = await fetch('/ajax', {method: 'POST', body: fd});
  document.getElementById('out').innerText = r.ok ? '送信が完了しました。担当者よりご連絡いたします。' : 'エラーが発生しました';
};
</script>"""

SITES = {
    # --- 送信テスト用
    "127.0.0.11": {
        "/": H("株式会社テスト工務店 | 名古屋市の注文住宅", '<a href="/company/">会社概要</a> <a href="/contact/">お問い合わせ</a><p>名古屋市の工務店です</p>'),
        "/contact/": H("お問い合わせ", FORM_A),
        "/company/": H("会社概要", "<table><tr><th>会社名</th><td>株式会社テスト工務店</td></tr><tr><th>所在地</th><td>〒460-0008 名古屋市中区栄1-2-3</td></tr><tr><th>従業員数</th><td>12名</td></tr><tr><th>資本金</th><td>1,000万円</td></tr><tr><th>事業内容</th><td>注文住宅・リフォーム</td></tr></table>"),
    },
    "127.0.0.12": {
        "/": H("お断り建設", '<a href="/inquiry">お問合せ</a>'),
        "/inquiry": H("お問合せ", "<p>※営業目的のお問い合わせはご遠慮ください。</p><form><input name='name'><input type='email' name='mail'><textarea name='b'></textarea></form>"),
    },
    "127.0.0.13": {
        "/": H("キャプチャ設備", '<a href="/contact/">CONTACT</a>'),
        "/contact/": H("contact", "<form><input name='name'><input type='email' name='mail'><textarea name='b'></textarea><div class='g-recaptcha' data-sitekey='x' style='width:304px;height:78px'></div></form>"),
    },
    "127.0.0.17": {  # 見えない reCAPTCHA v3 のみ → 送信対象
        "/": H("見えない認証住宅", '<a href="/contact/">お問い合わせ</a>'),
        "/contact/": H("contact", "<form method='post' action='/thanks'><table><tr><th>お名前</th><td><input name='name' required></td></tr><tr><th>メール</th><td><input type='email' name='mail' required></td></tr><tr><th>内容</th><td><textarea name='b' required></textarea></td></tr></table><input type='submit' value='送信'></form><script src='https://www.google.com/recaptcha/api.js?render=xxx' async></script><div class='grecaptcha-badge' data-style='bottomright'>reCAPTCHA</div>"),
    },
    "127.0.0.18": {  # reCAPTCHA v3 でスパム判定されるサイト
        "/": H("スパム判定工業", '<a href="/contact/">お問い合わせ</a>'),
        "/contact/": H("contact", "<form method='post' action='/spam'><table><tr><th>お名前</th><td><input name='name' required></td></tr><tr><th>メール</th><td><input type='email' name='mail' required></td></tr><tr><th>内容</th><td><textarea name='b' required></textarea></td></tr></table><input type='submit' value='送信'></form><div class='grecaptcha-badge'></div>"),
    },
    "127.0.0.14": {
        "/": H("フォーム無し電気", "<p>お問い合わせはお電話で 052-000-0000</p><a href='/about'>about</a>"),
    },
    "127.0.0.15": {
        "/": H("必須多すぎ不動産", '<a href="/contact/">お問い合わせ</a>'),
        "/contact/": H("contact", "<form><table><tr><th>お名前</th><td><input name='name' required></td></tr><tr><th>メール</th><td><input type='email' name='mail' required></td></tr><tr><th>ご希望の物件番号</th><td><input name='bukken' required></td></tr><tr><th>内容</th><td><textarea name='b' required></textarea></td></tr></table><input type='submit' value='送信'></form>"),
    },
    "127.0.0.16": {
        "/": H("ディブ空調", '<a href="/contact.html">お問い合わせはこちら</a>'),
        "/contact.html": H("お問い合わせ", FORM_F),
    },
    # --- リスト作成テスト用（検索結果から辿る）
    "127.0.0.21": {
        "/": H("有限会社みどり設備｜名古屋市緑区の給排水設備工事", '<a href="/gaiyo.html">会社案内</a><p>給排水設備工事</p>'),
        "/gaiyo.html": H("会社案内", "<dl><dt>商号</dt><dd>有限会社みどり設備</dd><dt>本社所在地</dt><dd>愛知県名古屋市緑区鳴海町1-1</dd><dt>従業員数</dt><dd>8人</dd></dl>"),
    },
    "127.0.0.22": {
        "/": H("大手ホールディングス", "<p>建設事業</p><p>東証プライム市場上場</p><p>名古屋市中区丸の内1-1</p>"),
    },
    "127.0.0.23": {
        "/": H("株式会社トヨタ外工務店", "<p>工務店 本社：愛知県豊田市元町1</p>"),
    },
    "127.0.0.24": {
        "/": H("株式会社なかむら電設 - 電気工事", "<p>電気工事</p><footer>〒453-0000 名古屋市中村区太閤1-1 / 従業員 230名 / © 2024 株式会社なかむら電設</footer>"),
    },
    "127.0.0.25": {
        "/": H("ホーム", "<p>リフォームのことなら</p><p>所在地：名古屋市千種区今池2-2-2</p><footer>Copyright © 株式会社ちくさリフォーム All Rights Reserved.</footer>"),
    },
}


def _search_page(q: str) -> str:
    hosts = ["127.0.0.21", "127.0.0.22", "127.0.0.23", "127.0.0.24", "127.0.0.25", "127.0.0.11"]
    items = "".join(
        f'<article><a data-testid="result-title-a" href="https://duckduckgo.com/l/?uddg=http%3A%2F%2F{h}%3A{PORT}%2Fsomepage&rut=x">r</a></article>'
        for h in hosts
    ) + '<article><a data-testid="result-title-a" href="https://suumo.jp/x">suumo</a></article>'
    return H("search", items)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, html, ctype="text/html; charset=utf-8"):
        b = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        host = self.headers.get("Host", "").split(":")[0]
        path = urlparse(self.path).path
        if host == "127.0.0.2":  # 疑似検索エンジン
            return self._send(200, _search_page(parse_qs(urlparse(self.path).query).get("q", [""])[0]))
        if path == "/__posts":
            return self._send(200, json.dumps(POSTS, ensure_ascii=False), "application/json")
        site = SITES.get(host, {})
        if path == "/somepage" and site:
            path = "/"
        if path in site:
            return self._send(200, site[path])
        self._send(404, H("404", "Not Found"))

    def do_POST(self):
        host = self.headers.get("Host", "").split(":")[0]
        n = int(self.headers.get("Content-Length", 0))
        data = {k: v for k, v in parse_qs(self.rfile.read(n).decode("utf-8"), keep_blank_values=True).items()}
        path = urlparse(self.path).path
        if path == "/confirm":
            hidden = "".join(f'<input type="hidden" name="{k}" value="{v[0]}">' for k, v in data.items())
            rows = "".join(f"<tr><th>{k}</th><td>{v[0]}</td></tr>" for k, v in data.items())
            return self._send(200, H("確認", f"<h1>入力内容の確認</h1><p>入力内容に誤りがなければ送信してください。</p><table>{rows}</table><form method='post' action='/thanks'>{hidden}<input type='submit' value='戻る'><input type='submit' value='送信する'></form>"))
        if path == "/spam":
            return self._send(200, H("エラー", "<p>スパム送信の可能性があります。</p>"))
        if path in ("/thanks", "/ajax"):
            POSTS.append({"host": host, "path": path, "data": data})
            if path == "/ajax":
                return self._send(200, "ok", "text/plain")
            return self._send(200, H("送信完了", "<h1>送信完了</h1><p>お問い合わせありがとうございました。</p>"))
        self._send(404, "")


def serve():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == "__main__":
    serve()
    print(f"serving on {PORT}", flush=True)
    threading.Event().wait()
