"""設定値。媒体ごとの上限・API のバージョン・LP の URL はここだけを編集すればよい。"""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

POSTS_CSV = BASE_DIR / "posts.csv"
RESULT_CSV = BASE_DIR / "result.csv"
ENV_FILE = BASE_DIR / ".env"

# このリポジトリの main ブランチを Vercel が公開している URL
SITE_URL = "https://golfsensei-landing.vercel.app"
# 投稿文中の {LP} はこの URL に置換される（?src=媒体 を付けて流入元を判別）
LP_URL = f"{SITE_URL}/axion-sales.html"

# Instagram 用画像（python main.py images で cards.csv から生成）
CARDS_CSV = BASE_DIR / "cards.csv"
IMAGE_DIR = BASE_DIR / "images"
IMAGE_URL_BASE = f"{SITE_URL}/sns/images"

# ---------------------------------------------------------------- 媒体
PLATFORMS = ["x", "instagram", "linkedin"]
PLATFORM_LABELS = {"x": "X", "instagram": "Instagram", "linkedin": "LinkedIn"}

# 本文の上限（X は全角を 2 として数える重み付き文字数）
MAX_LENGTH = {"x": 280, "instagram": 2200, "linkedin": 3000}
MAX_HASHTAGS = {"instagram": 30}

# 1日の最大投稿数（媒体ごと）。スパム判定を避けるため控えめに
DAILY_POST_LIMIT = {"x": 5, "instagram": 2, "linkedin": 2}

# 予定日時からこれ以上過ぎた投稿は自動では出さない（PC を長く止めていた時の一斉投稿を防ぐ）
LATE_LIMIT_HOURS = 24

HTTP_TIMEOUT_SEC = 30

# ---------------------------------------------------------------- API
X_POST_URL = "https://api.x.com/2/tweets"
X_ME_URL = "https://api.x.com/2/users/me"

LINKEDIN_POST_URL = "https://api.linkedin.com/rest/posts"
LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo"
# LinkedIn は YYYYMM 形式のバージョン指定が必須。古いものは約1年で使えなくなるので適宜更新する
LINKEDIN_VERSION = "202609"

INSTAGRAM_GRAPH_URL = "https://graph.facebook.com/v24.0"
INSTAGRAM_STATUS_POLL = 10       # メディア処理完了を待つ回数
INSTAGRAM_STATUS_WAIT_SEC = 3    # その間隔
