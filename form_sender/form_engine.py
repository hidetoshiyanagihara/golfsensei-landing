"""【2〜4】問い合わせフォームの検出・送信前チェック・入力・送信・完了判定（Playwright）。"""
import re
from dataclasses import dataclass, field
from urllib.parse import urljoin, urlparse

from playwright.sync_api import Frame, Page, TimeoutError as PWTimeout

import config
from common import SUBMITTED_PREFIX, nfkc

CONTACT_LINK_RE = re.compile(
    r"お問い?合わ?せ|問い?合わ?せ|お問合せ|ご相談|ご依頼|お見積|contact|inquiry|enquiry|toiawase|otoiawase|(?<![a-z])form(?![a-z])", re.I
)
CONTACT_LINK_NG_RE = re.compile(r"採用|求人|recruit|entry|資料請求|tel:|mailto:|line\.me|instagram|facebook", re.I)
COMMON_CONTACT_PATHS = ["contact/", "contact.html", "inquiry/", "toiawase/", "otoiawase/", "form/", "contact.php"]

CAPTCHA_SELECTORS = [
    "iframe[src*='recaptcha']", "iframe[src*='hcaptcha']", "iframe[src*='challenges.cloudflare.com']",
    ".g-recaptcha", ".h-captcha", ".cf-turnstile", "[data-sitekey]", ".grecaptcha-badge",
    "script[src*='recaptcha']", "script[src*='hcaptcha']", "script[src*='turnstile']",
    "img[src*='captcha' i]", "img[alt*='captcha' i]", "input[name*='captcha' i]", "img[src*='securimage' i]",
]
CAPTCHA_TEXT_RE = re.compile(r"画像認証|画像に表示され|表示されている文字|認証コード|captcha|私はロボットではありません", re.I)

# ページ内の入力欄を列挙するスクリプト。各欄に data-axion-idx を振り、ラベル等の手がかりを返す。
EXTRACT_JS = r"""
(root) => {
  const scope = root || document;
  const visible = (el) => {
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (el.type === 'checkbox' || el.type === 'radio') {
      // 装飾のため本体を隠しているチェックボックスは、ラベルが見えていれば可視扱い
      if (r.width > 0 && r.height > 0) return true;
      const lb = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
      if (lb) { const lr = lb.getBoundingClientRect(); return lr.width > 0 && lr.height > 0; }
      return false;
    }
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) return false;
    return r.width > 1 && r.height > 1;
  };
  const clean = (t) => (t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const textOf = (node) => {
    if (!node) return '';
    const c = node.cloneNode(true);
    c.querySelectorAll('select,option,textarea,script,style,input').forEach(n => n.remove());
    return clean(c.innerText || c.textContent);
  };
  const controls = Array.from(scope.querySelectorAll('input, select, textarea'));
  const isField = (el) => {
    const t = (el.type || '').toLowerCase();
    return !['hidden', 'submit', 'button', 'image', 'reset', 'file'].includes(t);
  };
  const groupLabel = (el) => {
    const tr = el.closest('tr');
    if (tr) { const th = tr.querySelector('th'); if (th) return textOf(th); }
    const dd = el.closest('dd');
    if (dd) { let p = dd.previousElementSibling; while (p && p.tagName !== 'DT') p = p.previousElementSibling; if (p) return textOf(p); }
    const fs = el.closest('fieldset');
    if (fs) { const lg = fs.querySelector('legend'); if (lg) return textOf(lg); }
    // 直前の兄弟要素（テキスト）を見出しとして探し、無ければ親へ。別の欄を含む範囲に達したら止める
    const key = (c) => c.name || c.id || c;
    const ctls = (n) => n.nodeType !== 1 ? [] : (['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName) ? [n] : Array.from(n.querySelectorAll('input,select,textarea'))).filter(isField);
    let node = el;
    for (let level = 0; level < 6 && node && node.parentElement; level++) {
      for (let sib = node.previousSibling; sib; sib = sib.previousSibling) {
        const cs = ctls(sib);
        if (cs.length) {
          if (level > 0 && cs.some(c => key(c) !== key(el))) return '';  // 前の行に到達
          continue;  // 同じ行内の他の欄（姓/名の分割など）は飛ばす
        }
        const t = sib.nodeType === 3 ? clean(sib.textContent) : textOf(sib);
        if (t) return t;
      }
      const parent = node.parentElement;
      // 親が別の欄を含む＝行より外側。ただし同じ行に姓/名などが並ぶ場合(level 0)は行の見出しまで見る
      if (level > 0 && ctls(parent).some(c => key(c) !== key(el))) break;
      node = parent;
    }
    return '';
  };
  const ownLabel = (el) => {
    let parts = [];
    if (el.labels) for (const l of el.labels) parts.push(textOf(l));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach(id => { const n = document.getElementById(id); if (n) parts.push(textOf(n)); });
    if (el.getAttribute('aria-label')) parts.push(el.getAttribute('aria-label'));
    if ((el.type === 'radio' || el.type === 'checkbox') && !parts.join('')) {
      let n = el.nextSibling;
      while (n && !(n.textContent || '').trim()) n = n.nextSibling;
      if (n) parts.push(clean(n.textContent));
    }
    return clean(parts.join(' '));
  };
  const out = [];
  controls.forEach((el, i) => {
    if (!isField(el) || el.disabled || el.readOnly) return;
    if (!visible(el)) return;
    el.setAttribute('data-axion-idx', String(i));
    const anc = el.closest('tr,dl,li,p,div');
    const req = !!(el.required || el.getAttribute('aria-required') === 'true' ||
      /required|must|hissu|wpcf7-validates-as-required/i.test(el.className || ''));
    out.push({
      idx: i,
      tag: el.tagName.toLowerCase(),
      type: (el.type || '').toLowerCase(),
      name: el.name || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      cls: el.className || '',
      maxlength: el.maxLength > 0 ? el.maxLength : null,
      pattern: el.getAttribute('pattern') || '',
      label: ownLabel(el),
      group: groupLabel(el),
      context: anc ? textOf(anc).slice(0, 80) : '',
      required: req,
      value: el.value || '',
      checked: !!el.checked,
      options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => ({value: o.value, text: clean(o.text), disabled: o.disabled})) : null,
    });
  });
  return out;
}
"""


@dataclass
class Outcome:
    result: str  # 成功 / スキップ / 失敗
    reason: str
    screenshot: str = ""


@dataclass
class Sender:
    """送信者情報から各欄に入れる値を作る。"""
    company: str = config.SENDER["company"]
    company_short: str = config.SENDER["company_short"]
    last_name: str = config.SENDER["last_name"]
    first_name: str = config.SENDER["first_name"]
    last_kana: str = config.SENDER["last_kana"]
    first_kana: str = config.SENDER["first_kana"]
    email: str = config.SENDER["email"]
    tel: str = config.SENDER["tel"]
    zip: str = config.SENDER["zip"]
    pref: str = config.SENDER["pref"]
    city: str = config.SENDER["city"]
    street: str = config.SENDER["street"]
    building: str = config.SENDER["building"]
    subject: str = config.SENDER["subject"]
    message: str = ""

    @property
    def full_name(self):
        return f"{self.last_name} {self.first_name}"

    @property
    def full_kana(self):
        return f"{self.last_kana} {self.first_kana}"

    @property
    def address_wo_pref(self):
        return f"{self.city}{self.street} {self.building}"

    @property
    def address_full(self):
        return f"{self.pref}{self.address_wo_pref}"


def to_katakana(s: str) -> str:
    return "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in s)


# ------------------------------------------------------------------ field classification
# (種別, 正規表現) を上から順に評価する。ラベル/グループ名/name/id/placeholder を対象。
RULES = [
    ("agree", r"同意|承諾|個人情報|プライバシー|privacy|policy|規約|agree|accept|acceptance|確認しました"),
    ("email_confirm", r"(メール|mail).*(確認|再入力|もう一度|再度|confirm|again|check|conf|2)|(確認|再入力|もう一度|再度|confirm|re_?)[^a-z]*(メール|mail)"),
    ("email", r"メール|e-?mail|mail"),
    ("kana", r"フリガナ|ふりがな|ﾌﾘｶﾞﾅ|カナ|かな|ｶﾅ|kana|furigana|ruby|yomi|読み"),
    ("company", r"会社|御社|貴社|法人|団体|組織|勤務先|企業|社名|屋号|店名|company|corp|organization|organisation|kaisya|kaisha|firm"),
    ("department", r"部署|所属|department|busho|division"),
    ("position", r"役職|肩書|position|yakushoku|post_?title|job_?title"),
    ("zip", r"郵便|〒|zip|postal|post_?code|postcode|yubin"),
    ("pref", r"都道府県|pref|prefecture|todofuken"),
    ("city", r"市区町村|市町村|city|address_?level2"),
    ("building", r"建物|ビル|マンション|building|address_?line2"),
    ("address", r"住所|所在地|address|addr|jusho|street"),
    ("fax", r"fax|ファックス|ファクス"),
    ("tel", r"電話|携帯|連絡先|tel|phone|mobile|denwa"),
    ("url", r"url|ホームページ|ウェブサイト|website|サイト"),
    ("subject", r"件名|題名|タイトル|表題|subject|title|用件"),
    ("inquiry_type", r"種別|種類|項目|区分|カテゴリ|内容の選択|ご用件|お問い?合わ?せの?(内容|種類|項目|区分)|category|type|kind|topic|select"),
    ("message", r"内容|本文|メッセージ|ご質問|ご相談|ご要望|ご意見|備考|詳細|その他|message|comment|body|inquiry|content|question|textarea|note|remarks"),
    ("name", r"名前|氏名|お名前|ご担当|担当者|name|namae|shimei|your-name"),
]
LAST_RE = re.compile(r"(^|[^名])姓|せい|セイ|苗字|名字|last|family|sei\b|_sei|sei_|name_?1|name\[0\]|\(sei\)|sei$", re.I)
FIRST_RE = re.compile(r"(^|[^氏姓お])名(?!前)|めい|メイ|first|given|mei\b|_mei|mei_|name_?2|name\[1\]|mei$", re.I)
OTHER_CHOICE_RE = [
    re.compile(r"^その他$"), re.compile(r"その他"), re.compile(r"一般|お問い?合わ?せ|ご相談|ご質問|ご意見|ご提案|お知らせ|その他"),
]
INQUIRY_GROUP_RE = re.compile(r"種別|種類|項目|区分|内容|用件|お問い?合わ?せ|カテゴリ|category|type|kind|subject", re.I)
CHOICE_NG_RE = re.compile(r"採用|求人|応募|見積|資料請求|苦情|クレーム|修理|故障|入居|物件|購入|売却|賃貸")


def _signals(f: dict, with_group=True) -> str:
    parts = [f["label"], f["placeholder"], f["name"], f["id"], f["autocomplete"]]
    if with_group:
        parts.insert(1, f["group"])
    return nfkc(" ".join(p for p in parts if p))


def classify(f: dict) -> str:
    t, tag = f["type"], f["tag"]
    if t == "email":
        sig = _signals(f)
        return "email_confirm" if re.search(RULES[1][1] + r"|確認|再入力|confirm", sig, re.I) else "email"
    if tag == "textarea":
        own = nfkc(" ".join([f["label"], f["placeholder"], f["name"], f["id"]]))
        sig = own if re.search(r"[^\s*※]", f["label"] + f["placeholder"]) else _signals(f)
        if re.search(r"住所|address", sig, re.I) and not re.search(r"内容|本文|message|msg|comment|お問|ご相談|ご質問|ご要望", sig, re.I):
            return "address"
        return "message"
    if t == "checkbox":
        sig = nfkc(f"{f['label']} {f['group']} {f['name']}") if f["label"] else nfkc(f"{f['group']} {f['name']} {f['context']}")
        if re.search(RULES[0][1], sig, re.I):
            return "agree"
        return "choice"
    if t == "radio":
        return "choice"
    if t == "tel":
        sig = _signals(f)
        if re.search(r"郵便|〒|zip|post", sig, re.I):
            return "zip"
        if re.search(r"fax", sig, re.I):
            return "fax"
        return "tel"
    if t == "url":
        return "url"
    ac = f["autocomplete"].lower()
    ac_map = {"organization": "company", "email": "email", "tel": "tel", "postal-code": "zip",
              "address-level1": "pref", "address-level2": "city", "family-name": "name", "given-name": "name",
              "name": "name", "street-address": "address", "address-line1": "address"}
    if ac in ac_map:
        return ac_map[ac]
    if tag == "select":
        if re.search(r"都道府県|pref", _signals(f), re.I) or any("愛知" in o["text"] for o in f["options"] or []):
            return "pref"
        return "inquiry_type"
    # 自分のラベル → グループ名（表の見出しなど） → name/id の順で判定
    for sig in (nfkc(" ".join([f["label"], f["placeholder"]])), nfkc(f["group"]), nfkc(" ".join([f["name"], f["id"]]))):
        if not sig.strip():
            continue
        for kind, pat in RULES[1:]:
            if re.search(pat, sig, re.I):
                return kind
    return "unknown"


def name_part(f: dict) -> str | None:
    """姓/名どちらの欄か。判定できなければ None。"""
    own = nfkc(" ".join([f["label"], f["placeholder"]]))
    attr = nfkc(" ".join([f["name"], f["id"]]))
    for sig in (own, attr):
        if not sig:
            continue
        # placeholder 例「山田」「太郎」「やまだ」「タロウ」
        if re.search(r"山田|やまだ|ヤマダ|鈴木|すずき|スズキ", sig) and not re.search(r"太郎|たろう|タロウ|花子|はなこ|ハナコ|一郎", sig):
            return "last"
        if re.search(r"太郎|たろう|タロウ|花子|はなこ|ハナコ|一郎", sig) and not re.search(r"山田|やまだ|ヤマダ|鈴木", sig):
            return "first"
        if LAST_RE.search(sig) and not FIRST_RE.search(sig):
            return "last"
        if FIRST_RE.search(sig) and not LAST_RE.search(sig):
            return "first"
    return None


def wants_katakana(f: dict) -> bool:
    sig = nfkc(" ".join([f["label"], f["group"], f["placeholder"], f["name"], f["id"]]))
    if re.search(r"ふりがな|ひらがな|ふり仮名", sig):
        return False
    if re.search(r"フリガナ|カタカナ|カナ|ヤマダ|タロウ", sig):
        return True
    ph = nfkc(f["placeholder"])
    return bool(re.search(r"[ァ-ン]", ph)) and not re.search(r"[ぁ-ん]", ph)


def wants_no_hyphen(f: dict, full_len: int) -> bool:
    sig = nfkc(" ".join([f["label"], f["group"], f["placeholder"], f["context"]]))
    if re.search(r"ハイフン(なし|無し|不要|を?除|を入れず|は不要)|半角数字のみ|数字のみ", sig):
        return True
    if f["maxlength"] and f["maxlength"] < full_len:
        return True
    if f["pattern"] and "-" not in f["pattern"] and re.search(r"\\d|0-9", f["pattern"]):
        return True
    ph = re.sub(r"\s", "", nfkc(f["placeholder"]))
    return bool(re.fullmatch(r"\d{7,11}", ph))


def is_required(f: dict) -> bool:
    if f["required"]:
        return True
    sig = nfkc(" ".join([f["label"], f["group"]]))
    return bool(re.search(r"必須|\*|required", sig, re.I))


@dataclass
class Plan:
    fills: list = field(default_factory=list)       # (idx, value)
    selects: list = field(default_factory=list)     # (idx, option_value)
    checks: list = field(default_factory=list)      # idx
    problems: list = field(default_factory=list)    # 埋められない必須欄
    has_message: bool = False


def choose_option(texts: list[str]) -> int | None:
    """「その他」等の無難な選択肢のインデックスを返す。"""
    for rx in OTHER_CHOICE_RE:
        for i, t in enumerate(texts):
            if rx.search(nfkc(t)) and not CHOICE_NG_RE.search(nfkc(t)):
                return i
    return None


def build_plan(fields: list[dict], s: Sender) -> Plan:
    plan = Plan()
    kinds = {f["idx"]: classify(f) for f in fields}
    by_kind: dict[str, list[dict]] = {}
    for f in fields:
        by_kind.setdefault(kinds[f["idx"]], []).append(f)

    def put(f, value, alt=None):
        ml = f["maxlength"]
        if ml and len(value) > ml:
            if alt and len(alt) <= ml:
                value = alt
            else:
                plan.problems.append(f"文字数制限({ml}字)のため入力不可: {f['label'] or f['group'] or f['name']}")
                return
        plan.fills.append((f["idx"], value))

    # --- テキスト系
    for f in by_kind.get("company", []):
        put(f, s.company, s.company_short)
    for f in by_kind.get("email", []) + by_kind.get("email_confirm", []):
        put(f, s.email)

    names = by_kind.get("name", [])
    _fill_split(names, s.full_name, s.last_name, s.first_name, put, kana=False)
    kanas = by_kind.get("kana", [])
    _fill_split(kanas, s.full_kana, s.last_kana, s.first_kana, put, kana=True)

    tels = by_kind.get("tel", [])
    tel_digits = s.tel.replace("-", "")
    if len(tels) >= 3:
        for f, part in zip(tels[:3], s.tel.split("-")):
            put(f, part)
    elif tels:
        for f in tels:
            put(f, tel_digits if wants_no_hyphen(f, len(s.tel)) else s.tel)

    zips = by_kind.get("zip", [])
    if len(zips) >= 2:
        for f, part in zip(zips[:2], s.zip.split("-")):
            put(f, part)
    elif zips:
        f = zips[0]
        put(f, s.zip.replace("-", "") if wants_no_hyphen(f, len(s.zip)) else s.zip)

    has_pref = bool(by_kind.get("pref"))
    has_city = bool(by_kind.get("city"))
    has_building = bool(by_kind.get("building"))
    for f in by_kind.get("pref", []):
        if f["tag"] == "select":
            texts = [o["text"] for o in f["options"]]
            i = next((k for k, t in enumerate(texts) if s.pref in nfkc(t) or "愛知" in t), None)
            if i is None:
                plan.problems.append("都道府県の選択肢に愛知県がない")
            else:
                plan.selects.append((f["idx"], f["options"][i]["value"]))
        else:
            put(f, s.pref)
    for f in by_kind.get("city", []):
        put(f, s.city)
    for f in by_kind.get("building", []):
        put(f, s.building)
    addrs = by_kind.get("address", [])
    if addrs:
        street = s.street if has_city else f"{s.city}{s.street}"
        if not has_pref:
            street = s.pref + street
        if len(addrs) >= 2 and not has_building:
            put(addrs[0], street)
            put(addrs[1], s.building)       # 住所2 = 建物名
        else:
            put(addrs[0], street if has_building else f"{street} {s.building}")

    for f in by_kind.get("subject", []):
        put(f, s.subject)

    msgs = by_kind.get("message", [])
    textareas = [f for f in msgs if f["tag"] == "textarea"]
    main_msg = textareas[0] if textareas else (msgs[0] if msgs else None)
    if main_msg:
        put(main_msg, s.message)
        plan.has_message = any(i == main_msg["idx"] for i, _ in plan.fills)
    for f in msgs:
        if f is not main_msg and is_required(f):
            plan.problems.append(f"必須欄を埋められない: {f['label'] or f['group'] or f['name']}")

    # 役職・部署は任意なら空欄、必須なら一般的な値
    for f in by_kind.get("position", []):
        if is_required(f):
            put(f, "代表")
    for f in by_kind.get("department", []):
        if is_required(f):
            put(f, "営業部")

    # --- 選択系（問い合わせ種別など）
    for f in by_kind.get("inquiry_type", []):
        if f["tag"] != "select":
            if is_required(f):
                plan.problems.append(f"必須欄を埋められない: {f['label'] or f['group'] or f['name']}")
            continue
        opts = [o for o in f["options"] if o["value"] != "" and not o["disabled"]
                and not re.search(r"選択|せんたく|---|select", o["text"], re.I)]
        if not (is_required(f) or INQUIRY_GROUP_RE.search(_signals(f))):
            continue  # 任意の無関係な選択欄は触らない
        i = choose_option([o["text"] for o in opts])
        if i is not None:
            plan.selects.append((f["idx"], opts[i]["value"]))
        elif is_required(f):
            plan.problems.append(f"選択肢に「その他」等がない: {f['label'] or f['group'] or f['name']}")

    groups: dict[str, list[dict]] = {}
    for f in by_kind.get("choice", []):
        groups.setdefault(f["name"] or str(f["idx"]), []).append(f)
    for gname, opts in groups.items():
        req = any(is_required(o) for o in opts)
        is_inquiry = INQUIRY_GROUP_RE.search(nfkc(opts[0]["group"] + " " + gname))
        if not (req or is_inquiry):
            continue
        i = choose_option([o["label"] for o in opts])
        if i is not None:
            plan.checks.append(opts[i]["idx"])
        elif req:
            plan.problems.append(f"選択肢に「その他」等がない: {opts[0]['group'] or gname}")

    for f in by_kind.get("agree", []):
        plan.checks.append(f["idx"])

    # --- 埋められない必須欄
    filled = {i for i, _ in plan.fills} | {i for i, _ in plan.selects} | set(plan.checks)
    for f in fields:
        k = kinds[f["idx"]]
        if k in ("choice", "inquiry_type") or f["idx"] in filled:
            continue
        if is_required(f) and k in ("unknown", "url", "fax"):
            plan.problems.append(f"必須欄を埋められない: {f['label'] or f['group'] or f['name'] or f['placeholder']}")
    return plan


def _fill_split(fs, full, last, first, put, kana: bool):
    if not fs:
        return
    if len(fs) >= 2:
        parts = [name_part(f) for f in fs[:2]]
        if parts == ["first", "last"]:
            order = [first, last]
        else:
            order = [last, first]
        for f, v in zip(fs[:2], order):
            put(f, to_katakana(v) if kana and wants_katakana(f) else v)
        return
    f = fs[0]
    put(f, to_katakana(full) if kana and wants_katakana(f) else full)


# ------------------------------------------------------------------ page helpers
def page_text(page: Page) -> str:
    texts = []
    for fr in page.frames:
        try:
            texts.append(fr.evaluate("() => document.body ? document.body.innerText : ''"))
        except Exception:
            pass
    return nfkc("\n".join(texts))


def find_refusal(text: str) -> str | None:
    flat = re.sub(r"[ \t　]+", "", nfkc(text))
    for pat in config.REFUSAL_PATTERNS:
        m = re.search(pat, flat)
        if m:
            return m.group(0)[:40]
    return None


def has_captcha(page: Page) -> str | None:
    for fr in page.frames:
        if re.search(r"recaptcha|hcaptcha|challenges\.cloudflare", fr.url or "", re.I):
            return "reCAPTCHA等の認証あり"
        for sel in CAPTCHA_SELECTORS:
            try:
                if fr.locator(sel).count() > 0:
                    return f"画像認証/reCAPTCHA等あり（{sel}）"
            except Exception:
                continue
    if CAPTCHA_TEXT_RE.search(page_text(page)):
        return "画像認証の記載あり"
    return None


def _form_frames(page: Page) -> list[Frame]:
    """textarea を含むフレーム（iframe 埋め込みフォーム対応）を優先順に返す。"""
    frames = []
    for fr in page.frames:
        try:
            if fr.locator("textarea").count() > 0:
                frames.append(fr)
        except Exception:
            continue
    return frames


def _form_root(fr: Frame):
    """textarea を含む <form> があればそれを、無ければ body を返す。"""
    handle = fr.evaluate_handle(
        """() => {
          const forms = Array.from(document.querySelectorAll('form')).filter(f => f.querySelector('textarea'));
          if (forms.length) return forms.sort((a,b) => b.querySelectorAll('input,textarea,select').length - a.querySelectorAll('input,textarea,select').length)[0];
          return document.body;
        }"""
    )
    return handle


def find_contact_page(page: Page, base_url: str) -> bool:
    """問い合わせフォームのあるページへ移動する。見つかれば True。"""
    if _form_frames(page):
        return True
    host = urlparse(page.url).netloc
    links = page.evaluate(
        """() => Array.from(document.querySelectorAll('a[href]')).map(a => ({href: a.href, text: (a.innerText || a.title || a.getAttribute('aria-label') || '').trim(), img: Array.from(a.querySelectorAll('img')).map(i => i.alt || '').join(' ')}))"""
    )
    scored = []
    for ln in links:
        href, text = ln["href"], nfkc(f"{ln['text']} {ln['img']}")
        if not href.startswith("http") or CONTACT_LINK_NG_RE.search(href + " " + text):
            continue
        if not CONTACT_LINK_RE.search(text + " " + href):
            continue
        score = 0
        if re.search(r"お問い?合わ?せ|お問合せ|問い?合わ?せ|contact", text, re.I):
            score += 10
        if re.search(r"contact|inquiry|toiawase|otoiawase", href, re.I):
            score += 5
        if urlparse(href).netloc != host:
            score -= 3  # 外部フォームサービスも許容するが自社ドメイン優先
        scored.append((score, href))
    tried = set()
    for _, href in sorted(scored, key=lambda x: -x[0])[:5]:
        href = href.split("#")[0]
        if href in tried or href.rstrip("/") == page.url.split("#")[0].rstrip("/"):
            continue
        tried.add(href)
        if _goto(page, href) and _form_frames(page):
            return True
    root = f"{urlparse(base_url).scheme}://{urlparse(base_url).netloc}/"
    for p in COMMON_CONTACT_PATHS:
        u = urljoin(root, p)
        if u in tried:
            continue
        if _goto(page, u) and _form_frames(page):
            return True
    return False


def _goto(page: Page, url: str) -> bool:
    try:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=config.PAGE_TIMEOUT_MS)
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except PWTimeout:
            pass
        return resp is None or resp.status < 400
    except Exception:
        return False


def apply_plan(fr: Frame, plan: Plan) -> None:
    for idx, value in plan.fills:
        loc = fr.locator(f"[data-axion-idx='{idx}']")
        loc.fill(value, timeout=5000)
    for idx, value in plan.selects:
        fr.locator(f"[data-axion-idx='{idx}']").select_option(value=value, timeout=5000)
    for idx in plan.checks:
        loc = fr.locator(f"[data-axion-idx='{idx}']")
        try:
            loc.check(timeout=3000)
        except Exception:
            # 見えないチェックボックスはラベルをクリック／JS で選択
            loc.evaluate("el => { el.checked = true; el.dispatchEvent(new Event('change', {bubbles: true})); el.dispatchEvent(new Event('click', {bubbles: true})); }")


SUBMIT_JS = r"""
(args) => {
  const [root, phase] = args;
  const scope = root || document;
  const cands = Array.from(scope.querySelectorAll('button, input[type=submit], input[type=button], input[type=image], a[role=button], a.btn, a.button'));
  const label = (el) => ((el.innerText || el.value || el.alt || el.getAttribute('aria-label') || '') + '').replace(/\s+/g, '');
  const vis = (el) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
  const ng = /戻る|修正|リセット|クリア|取り消|キャンセル|back|reset|clear|cancel|検索|search|ログイン|login|閉じる/i;
  const send = /送信|送る|この内容で|submit|send|申し?込|問い?合わ?せる/i;
  const confirm = /確認|次へ|進む|next|confirm/i;
  let best = null, bestScore = -1;
  cands.forEach(el => {
    if (!vis(el) || el.disabled) return;
    const t = label(el);
    if (ng.test(t)) return;
    let s = 0;
    if (phase === 'send' && send.test(t)) s = 3;
    else if (send.test(t) || confirm.test(t)) s = 2;
    else if (el.type === 'submit') s = 1;
    if (s > bestScore) { best = el; bestScore = s; }
  });
  if (!best || bestScore < (phase === 'send' ? 3 : 1)) return null;
  best.setAttribute('data-axion-submit', '1');
  return label(best);
}
"""


def _click_submit(fr: Frame, root, phase: str) -> str | None:
    fr.evaluate("() => document.querySelectorAll('[data-axion-submit]').forEach(e => e.removeAttribute('data-axion-submit'))")
    label = fr.evaluate(SUBMIT_JS, [root, phase])
    if not label:
        return None
    fr.locator("[data-axion-submit='1']").first.click(timeout=8000)
    return label


def judge_completion(page: Page, before_url: str, before_text: str) -> tuple[bool | None, str]:
    """(True=完了 / False=エラー表示 / None=不明, 根拠)。送信前から出ていた文言は根拠にしない。"""
    text = page_text(page)
    for fr in page.frames:
        try:
            status = fr.evaluate("() => { const f = document.querySelector('form.wpcf7-form'); return f ? (f.getAttribute('data-status') || '') : ''; }")
        except Exception:
            status = ""
        if status == "sent":
            return True, "Contact Form 7 送信完了"
        if status in ("invalid", "failed", "spam", "aborted"):
            return False, f"Contact Form 7 エラー（{status}）"
    for pat in config.SUCCESS_PATTERNS:
        m = re.search(pat, text, re.I)
        if m and len(re.findall(pat, text, re.I)) > len(re.findall(pat, before_text, re.I)):
            return True, f"完了表示「{m.group(0)}」"
    if page.url != before_url:
        for pat in config.SUCCESS_URL_PATTERNS:
            if re.search(pat, urlparse(page.url).path, re.I):
                return True, f"完了ページへ遷移（{page.url}）"
    for pat in config.ERROR_PATTERNS:
        m = re.search(pat, text, re.I)
        if m and len(re.findall(pat, text, re.I)) > len(re.findall(pat, before_text, re.I)):
            return False, f"エラー表示「{m.group(0)}」"
    return None, "完了画面を確認できない"


def _input_form_visible(page: Page) -> bool:
    """入力した本文欄がまだ編集可能な状態で見えているか（確認画面かどうかの判定用）。"""
    for fr in page.frames:
        try:
            if fr.locator("textarea[data-axion-idx]:visible").count() > 0:
                return True
        except Exception:
            continue
    return False


def _wait_settle(page: Page):
    try:
        page.wait_for_load_state("networkidle", timeout=10000)
    except PWTimeout:
        pass
    page.wait_for_timeout(1500)


def process_company(page: Page, name: str, url: str, message: str, live: bool, shot_path: str) -> Outcome:
    """1社分の処理。live=False（テスト）では入力後にスクリーンショットを撮り送信しない。"""
    if not _goto(page, url):
        return Outcome("失敗", "サイトにアクセスできない")
    top_refusal = find_refusal(page_text(page))
    if top_refusal:
        return Outcome("スキップ", f"営業お断りの記載あり「{top_refusal}」")
    if not find_contact_page(page, url):
        return Outcome("スキップ", "問い合わせフォームが見つからない")

    refusal = find_refusal(page_text(page))
    if refusal:
        return Outcome("スキップ", f"営業お断りの記載あり「{refusal}」")
    cap = has_captcha(page)
    if cap:
        return Outcome("スキップ", cap)

    fr = _form_frames(page)[0]
    root = _form_root(fr)
    fields = fr.evaluate(EXTRACT_JS, root)
    if not fields:
        return Outcome("スキップ", "問い合わせフォームが見つからない")
    sender = Sender(message=message)
    plan = build_plan(fields, sender)
    if plan.problems:
        return Outcome("スキップ", " / ".join(dict.fromkeys(plan.problems))[:200])
    if not plan.has_message:
        return Outcome("スキップ", "本文を入力する欄がない")
    if not any(v == sender.email for _, v in plan.fills):
        return Outcome("スキップ", "メールアドレス欄がない")

    try:
        apply_plan(fr, plan)
    except Exception as e:
        return Outcome("失敗", f"入力中にエラー: {str(e).splitlines()[0][:120]}")

    if not live:
        fr.evaluate("() => document.querySelectorAll('textarea[data-axion-idx]').forEach(t => t.scrollTop = 0)")
        page.screenshot(path=shot_path, full_page=True)
        return Outcome("成功", "テストモード：入力完了（未送信）", shot_path)

    # ---- 本番送信（確認画面がある場合は2段階）
    before_url, before_text = page.url, page_text(page)
    try:
        clicked = _click_submit(fr, root, "first")
    except Exception as e:
        return Outcome("失敗", f"送信ボタンを押せない: {str(e).splitlines()[0][:100]}")
    if not clicked:
        return Outcome("失敗", "送信ボタンが見つからない")
    _wait_settle(page)
    ok, why = judge_completion(page, before_url, before_text)
    if ok is not True and not _input_form_visible(page):
        # 入力欄が消えた＝確認画面とみなし、「送信」ボタンを押す（確認画面の「入力内容に誤りが…」等は無視）
        confirm_url, confirm_text = page.url, page_text(page)
        clicked2 = None
        for f2 in page.frames:
            try:
                clicked2 = _click_submit(f2, None, "send")
            except Exception:
                clicked2 = None
            if clicked2:
                break
        if clicked2:
            _wait_settle(page)
            ok, why = judge_completion(page, confirm_url, confirm_text)
            if ok is None and page.url != confirm_url:
                ok, why = judge_completion(page, before_url, before_text)
    try:
        page.screenshot(path=shot_path, full_page=True)
    except Exception:
        shot_path = ""
    if ok:
        return Outcome("成功", why, shot_path)
    if ok is False and _input_form_visible(page):
        return Outcome("失敗", f"入力エラーで送信されず: {why}", shot_path)
    return Outcome("失敗", f"{SUBMITTED_PREFIX}: {why}（送信された可能性あり・再送しない）", shot_path)
