"""設定値。送信者情報・上限値・判定キーワードはここだけを編集すればよい。"""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

COMPANIES_CSV = BASE_DIR / "companies.csv"
NG_LIST_CSV = BASE_DIR / "ng_list.csv"
RESULT_CSV = BASE_DIR / "result.csv"
MESSAGE_TXT = BASE_DIR / "message.txt"
SCREENSHOT_DIR = BASE_DIR / "screenshots"
COLLECT_STATE = BASE_DIR / ".collect_state.json"

# ---------------------------------------------------------------- 送信者情報
SENDER = {
    "company": "AXION SALES（アクシオンセールス）",
    "company_short": "AXION SALES",  # 文字数制限がある欄用
    "last_name": "柳原",
    "first_name": "秀俊",
    "last_kana": "やなぎはら",
    "first_kana": "ひでとし",
    "email": "yanagihara.axionsales@outlook.jp",
    "tel": "090-6616-4210",
    "zip": "450-0002",
    "pref": "愛知県",
    "city": "名古屋市中村区",
    "street": "名駅3-4-10",
    "building": "アルティメイト名駅1st 2階",
    # 件名・本文（message.txt）では {社名} {業種名} {地域} が送信先ごとに置き換わる
    "subject": "【{業種名}の会社様へ】新規のお客様との商談を初月3件保証します",
}

# 本文の {紹介ページ} に入れる会社紹介ページのURL。空のあいだはその行ごと本文から外す
COMPANY_PAGE_URL = ""

# ---------------------------------------------------------------- 上限・待機
COLLECT_MAX_PER_RUN = 100      # リスト作成 1回の最大追加数
DAILY_SEND_LIMIT = 50          # 本番送信 1日の最大件数
SEND_HOURS = (9, 18)           # 本番送信は日本時間のこの時間帯だけ（9:00〜18:00）
SEND_WEEKDAYS_ONLY = True      # 本番送信は平日のみ（土日・祝日は送らない）
TEST_DEFAULT_COUNT = 10        # テストモードの既定件数
WAIT_MIN_SEC = 30              # 1件ごとの待機（秒）
WAIT_MAX_SEC = 120

PAGE_TIMEOUT_MS = 30000
HTTP_TIMEOUT_SEC = 15
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------- リスト作成
MAX_EMPLOYEES = 100            # これを超える従業員数の会社は除外
MAX_CAPITAL_YEN = 300_000_000  # これ以上の資本金の会社は除外（大手判定）

NAGOYA_WARDS = [
    "千種区", "東区", "北区", "西区", "中村区", "中区", "昭和区", "瑞穂区",
    "熱田区", "中川区", "港区", "南区", "守山区", "緑区", "名東区", "天白区",
]
# 名古屋市の周辺の市（リスト作成の検索対象・所在地の判定に使う）。検索はこちらを先に回る
SURROUNDING_CITIES = [
    # 愛知県全域に拡大（10/26）。まだ検索していない市町村を先に回る
    "豊橋市", "豊川市", "津島市", "西尾市", "蒲郡市", "常滑市", "新城市", "知多市", "高浜市", "岩倉市",
    "田原市", "愛西市", "弥富市", "みよし市",
    "東郷町", "豊山町", "大口町", "扶桑町", "大治町", "蟹江町", "飛島村", "阿久比町", "東浦町",
    "南知多町", "美浜町", "武豊町", "幸田町", "設楽町", "東栄町", "豊根村",
    # 名古屋市の周辺（検索済み）
    "春日井市", "一宮市", "豊田市", "岡崎市", "小牧市", "瀬戸市", "尾張旭市", "長久手市", "日進市",
    "豊明市", "大府市", "東海市", "北名古屋市", "清須市", "あま市", "稲沢市", "刈谷市", "安城市",
    "半田市", "知立市", "碧南市", "江南市", "犬山市",
]

# 件名・本文の {業種名} に入れる言葉（companies.csv の業種 -> 文中の表現）
INDUSTRY_LABELS = {
    "塗装": "外壁・屋根塗装", "解体": "解体工事", "内装": "内装工事",
    "防水": "防水工事", "左官": "左官工事", "外構": "外構・エクステリア工事", "屋根": "屋根工事", "建設": "建設工事", "工務店": "住宅建築",
    "設備工事（空調）": "空調設備工事", "設備工事（給排水）": "給排水設備工事", "設備工事（電気）": "電気工事",
    "リフォーム": "リフォーム", "不動産": "不動産",
}

# 業種 -> 検索キーワード
INDUSTRY_QUERIES = {
    "塗装": ["塗装会社"],
    "解体": ["解体工事 会社"],
    "内装": ["内装工事 会社"],
    "防水": ["防水工事 会社"],
    "左官": ["左官工事 会社"],
    "外構": ["外構工事 会社"],
    "屋根": ["屋根工事 会社"],
}
# これまでに集めた業種（収集は終わったが、送信の --industry や {業種名} では引き続き使う）:
# 塗装・解体・内装、建設・工務店・設備工事・リフォーム・不動産

# 公式サイトではない（ポータル・求人・SNS 等）ドメイン
EXCLUDED_DOMAINS = [
    "google.", "youtube.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
    "tiktok.com", "linkedin.com", "line.me", "wikipedia.org", "amazon.co.jp", "rakuten.co.jp",
    "yahoo.co.jp", "yahoo.com", "bing.com", "duckduckgo.com", "note.com", "ameblo.jp",
    "suumo.jp", "homes.co.jp", "athome.co.jp", "chintai.net", "ielove.co.jp", "smocca.jp",
    "itp.ne.jp", "ekiten.jp", "mapion.co.jp", "navitime.co.jp", "jpnumber.com", "houjin.info",
    "houjin-bangou.nta.go.jp", "baseconnect.in", "salesnow.jp", "musubu.in", "nikkei.com",
    "prtimes.jp", "minkabu.jp", "kabutan.jp", "indeed.com", "townwork.net", "en-japan.com",
    "mynavi.jp", "rikunabi.com", "doda.jp", "baitoru.com", "hellowork", "engage.jp", "airwork.net",
    "jmty.jp", "zehitomo.com", "meetsmore.com", "kurashinomarket.com", "minnano-reform.jp",
    "homepro.jp", "rehome-navi.com", "reform-guide.jp", "nuri-kae.jp", "gaiheki-madoguchi.com",
    "lixil-reform.net", "tabelog.com", "hotpepper.jp", "goo.ne.jp", "biz.ne.jp", "gbiz.go.jp",
    "kensetumap.com", "kensetsu-navi", "houzz.jp", "suumocounter", "lifull.com", "e-tsuhan",
    "kenchikukenken.co.jp", "gaihekiguide.co.jp", "nagoya-gaiheki-tosou.com", "xn--3kqvs447ab16b.com",
    "nagoya-cci.or.jp", "city.nagoya.jp", "pref.aichi.jp", "go.jp", "lg.jp", "ac.jp", "ed.jp",
]

# 大手・上場企業（社名に含まれていたら除外）
LARGE_COMPANY_NAMES = [
    "大林組", "鹿島建設", "清水建設", "大成建設", "竹中工務店", "長谷工", "戸田建設", "前田建設",
    "熊谷組", "西松建設", "安藤ハザマ", "五洋建設", "東急建設", "フジタ", "奥村組", "鉄建建設",
    "矢作建設", "徳倉建設", "名工建設", "大日本土木", "積水ハウス", "大和ハウス", "住友林業",
    "ミサワホーム", "パナソニックホームズ", "旭化成ホームズ", "トヨタホーム", "一条工務店",
    "タマホーム", "飯田グループ", "アイダ設計", "アキュラホーム", "ヤマダホームズ", "三井不動産",
    "三菱地所", "住友不動産", "野村不動産", "東急リバブル", "東急不動産", "大京", "オープンハウス",
    "エイブル", "アパマン", "ミニミニ", "大東建託", "レオパレス", "スターツ", "センチュリー21",
    "LIXIL", "TOTO", "関電工", "きんでん", "トーエネック", "九電工", "中電工", "高砂熱学",
    "ダイダン", "三機工業", "新日本空調", "朝日工業社", "大気社", "日比谷総合設備", "中部電力",
    "東邦ガス", "ニッカホーム", "朝日住宅", "名鉄", "トヨタ", "デンソー", "アイシン",
]

# 上場・大手を示すページ内の記載
LISTED_PATTERNS = [
    r"東証", r"証券取引所", r"証券コード", r"(プライム|スタンダード|グロース)市場",
    r"株主・投資家", r"投資家情報", r"IR情報",
]

# ---------------------------------------------------------------- 送信前チェック
# 営業お断りの記載（正規表現。全角・半角/空白は正規化してから照合）
REFUSAL_PATTERNS = [
    r"(営業(?!時間|日|所|部|担当|拠点|エリア|地域|品目|種目|内容|案内|カレンダー|中)|セールス|勧誘|売り込み|売込み|販売促進)"
    r"[^。\n]{0,25}?"
    r"(お断り|お断わり|ご遠慮|遠慮願|禁止|お控え|控えて|受け付けて(おりません|いません|おりませ)|"
    r"受付(いた)?して(おりません|いません)|お受け(いた)?(しかね|できません)|対応(いた)?しかね|"
    r"ご返信(いた)?しかね|返信(いた)?(しません|いたしません|致しません)|ご利用(いただけません|になれません))",
    r"(営業|セールス)\s*(お断り|NG|不可)",
]

# 送信完了の判定
SUCCESS_PATTERNS = [
    r"ありがとうございま", r"送信(いた)?しました", r"送信が完了", r"送信完了", r"送信されました",
    r"受け?付け?(いた)?しました", r"受付(いた)?しました", r"受付完了", r"お問い?合わ?せを受け?付け",
    r"(お問い?合わ?せ|メール|ご連絡|ご依頼)(が|は)?.{0,10}完了", r"完了(いた)?しました",
    r"thank\s*you", r"thanks", r"successfully\s*(sent|submitted)", r"has been sent",
]
SUCCESS_URL_PATTERNS = [r"thank", r"complete", r"finish", r"done", r"success", r"kanryo", r"sent"]
# サイト側の迷惑送信判定（reCAPTCHA v3 等）で拒否された表示。送信されていないが、再試行しても通らない
REJECTED_PATTERNS = [r"スパム", r"spam", r"迷惑(メール|送信)", r"不正な(送信|アクセス)", r"ロボット(による|と判定)"]

ERROR_PATTERNS = [
    r"入力(して|され)て?(ください|いません)", r"必須(項目|です)", r"正しく入力", r"入力内容に(誤り|エラー|問題)",
    r"エラーが(あり|発生)", r"入力ミス", r"チェックを入れて", r"(?m)^\s*error\s*$", r"送信(に|が)?失敗", r"送信できません", r"invalid", r"required field",
]
