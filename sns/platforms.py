"""各 SNS の公式 API で投稿する。認証情報は環境変数（または sns/.env）から読む。

X:         X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
LinkedIn:  LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN（urn:li:person:… または urn:li:organization:…）
Instagram: IG_USER_ID, IG_ACCESS_TOKEN（プロアカウント + Facebook ページ連携が必要）

verify_*() は認証情報を読み取り系 API で確かめ、分かる ID（LinkedIn の URN・IG ユーザー ID）や
長期トークンを sns/.env に書き込む。
"""
import os
import re
import time

import requests

import config
from common import HASHTAG_RE, save_env

REQUIRED_ENV = {
    "x": ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"],
    "linkedin": ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AUTHOR_URN"],
    "instagram": ["IG_USER_ID", "IG_ACCESS_TOKEN"],
}


class PostError(Exception):
    pass


def missing_env(platform: str) -> list[str]:
    return [k for k in REQUIRED_ENV.get(platform, []) if not os.environ.get(k)]


def _check(res: requests.Response, what: str) -> dict:
    if res.status_code >= 400:
        raise PostError(f"{what}: HTTP {res.status_code} {res.text[:300]}")
    try:
        return res.json()
    except ValueError:
        return {}


# ---------------------------------------------------------------- X
def post_x(text: str, image_url: str = "") -> str:
    from requests_oauthlib import OAuth1
    auth = OAuth1(os.environ["X_API_KEY"], os.environ["X_API_SECRET"],
                  os.environ["X_ACCESS_TOKEN"], os.environ["X_ACCESS_SECRET"])
    res = requests.post(config.X_POST_URL, json={"text": text}, auth=auth,
                        timeout=config.HTTP_TIMEOUT_SEC)
    return _check(res, "X 投稿")["data"]["id"]


# ---------------------------------------------------------------- LinkedIn
_LITTLE_RESERVED = re.compile(r"([\\|{}@\[\]()<>#*_~])")


def linkedin_commentary(text: str) -> str:
    """LinkedIn の commentary（little text 形式）に変換。予約文字をエスケープし #タグ はハッシュタグにする。"""
    out, pos = [], 0
    for m in HASHTAG_RE.finditer(text):
        out.append(_LITTLE_RESERVED.sub(r"\\\1", text[pos:m.start()]))
        out.append("{hashtag|\\#|" + _LITTLE_RESERVED.sub(r"\\\1", m.group(1)) + "}")
        pos = m.end()
    out.append(_LITTLE_RESERVED.sub(r"\\\1", text[pos:]))
    return "".join(out)


def post_linkedin(text: str, image_url: str = "") -> str:
    headers = {
        "Authorization": f"Bearer {os.environ['LINKEDIN_ACCESS_TOKEN']}",
        "LinkedIn-Version": config.LINKEDIN_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
    }
    body = {
        "author": os.environ["LINKEDIN_AUTHOR_URN"],
        "commentary": linkedin_commentary(text),
        "visibility": "PUBLIC",
        "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [],
                         "thirdPartyDistributionChannels": []},
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    res = requests.post(config.LINKEDIN_POST_URL, json=body, headers=headers,
                        timeout=config.HTTP_TIMEOUT_SEC)
    _check(res, "LinkedIn 投稿")
    return res.headers.get("x-restli-id", "")


# ---------------------------------------------------------------- Instagram
def post_instagram(text: str, image_url: str = "") -> str:
    base = f"{config.INSTAGRAM_GRAPH_URL}/{os.environ['IG_USER_ID']}"
    token = os.environ["IG_ACCESS_TOKEN"]
    res = requests.post(f"{base}/media", data={"image_url": image_url, "caption": text,
                                               "access_token": token},
                        timeout=config.HTTP_TIMEOUT_SEC)
    container = _check(res, "Instagram メディア作成")["id"]
    for _ in range(config.INSTAGRAM_STATUS_POLL):
        res = requests.get(f"{config.INSTAGRAM_GRAPH_URL}/{container}",
                           params={"fields": "status_code", "access_token": token},
                           timeout=config.HTTP_TIMEOUT_SEC)
        status = _check(res, "Instagram 処理状況").get("status_code")
        if status == "FINISHED":
            break
        if status in ("ERROR", "EXPIRED"):
            raise PostError(f"Instagram メディア処理: {status}")
        time.sleep(config.INSTAGRAM_STATUS_WAIT_SEC)
    else:
        raise PostError("Instagram メディア処理が完了しない")
    res = requests.post(f"{base}/media_publish", data={"creation_id": container, "access_token": token},
                        timeout=config.HTTP_TIMEOUT_SEC)
    return _check(res, "Instagram 公開")["id"]


# ---------------------------------------------------------------- 認証情報の確認
def verify_x() -> str:
    from requests_oauthlib import OAuth1
    auth = OAuth1(os.environ["X_API_KEY"], os.environ["X_API_SECRET"],
                  os.environ["X_ACCESS_TOKEN"], os.environ["X_ACCESS_SECRET"])
    res = requests.get(config.X_ME_URL, auth=auth, timeout=config.HTTP_TIMEOUT_SEC)
    return "@" + _check(res, "X アカウント確認")["data"]["username"]


def verify_linkedin() -> str:
    res = requests.get(config.LINKEDIN_USERINFO_URL,
                       headers={"Authorization": f"Bearer {os.environ['LINKEDIN_ACCESS_TOKEN']}"},
                       timeout=config.HTTP_TIMEOUT_SEC)
    info = _check(res, "LinkedIn アカウント確認")
    urn = os.environ.get("LINKEDIN_AUTHOR_URN", "")
    if not urn.startswith("urn:li:") or urn.endswith("xxxxxxxx"):
        save_env("LINKEDIN_AUTHOR_URN", f"urn:li:person:{info['sub']}")
    return f"{info.get('name', '')}（{os.environ['LINKEDIN_AUTHOR_URN']}）"


def verify_instagram() -> str:
    token = os.environ["IG_ACCESS_TOKEN"]
    app_id, app_secret = os.environ.get("FB_APP_ID"), os.environ.get("FB_APP_SECRET")
    if app_id and app_secret and not os.environ.get("IG_TOKEN_LONG_LIVED"):
        res = requests.get(f"{config.INSTAGRAM_GRAPH_URL}/oauth/access_token", params={
            "grant_type": "fb_exchange_token", "client_id": app_id, "client_secret": app_secret,
            "fb_exchange_token": token}, timeout=config.HTTP_TIMEOUT_SEC)
        token = _check(res, "Instagram 長期トークン")["access_token"]
        save_env("IG_ACCESS_TOKEN", token)
        save_env("IG_TOKEN_LONG_LIVED", "1")
    if not os.environ.get("IG_USER_ID"):
        res = requests.get(f"{config.INSTAGRAM_GRAPH_URL}/me/accounts", params={
            "fields": "name,instagram_business_account", "access_token": token},
            timeout=config.HTTP_TIMEOUT_SEC)
        pages = [p for p in _check(res, "Facebook ページ一覧").get("data", []) if p.get("instagram_business_account")]
        if not pages:
            raise PostError("Instagram ビジネスアカウントと連携した Facebook ページが見つからない")
        save_env("IG_USER_ID", pages[0]["instagram_business_account"]["id"])
    res = requests.get(f"{config.INSTAGRAM_GRAPH_URL}/{os.environ['IG_USER_ID']}",
                       params={"fields": "username", "access_token": token}, timeout=config.HTTP_TIMEOUT_SEC)
    return "@" + _check(res, "Instagram アカウント確認")["username"]


VERIFIERS = {"x": verify_x, "linkedin": verify_linkedin, "instagram": verify_instagram}

POSTERS = {"x": post_x, "linkedin": post_linkedin, "instagram": post_instagram}


def publish(platform: str, text: str, image_url: str = "") -> str:
    """投稿して投稿 ID を返す。失敗時は PostError。"""
    try:
        return POSTERS[platform](text, image_url)
    except requests.RequestException as e:
        raise PostError(f"通信エラー: {e}") from e
