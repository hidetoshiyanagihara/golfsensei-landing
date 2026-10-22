"""各 SNS の公式 API で投稿する。認証情報は環境変数（または sns/.env）から読む。

X:         X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET
LinkedIn:  LINKEDIN_ACCESS_TOKEN, LINKEDIN_AUTHOR_URN（urn:li:person:… または urn:li:organization:…）
Instagram: IG_USER_ID, IG_ACCESS_TOKEN（プロアカウント + Facebook ページ連携が必要）
"""
import os
import re
import time

import requests

import config
from common import HASHTAG_RE

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


POSTERS = {"x": post_x, "linkedin": post_linkedin, "instagram": post_instagram}


def publish(platform: str, text: str, image_url: str = "") -> str:
    """投稿して投稿 ID を返す。失敗時は PostError。"""
    try:
        return POSTERS[platform](text, image_url)
    except requests.RequestException as e:
        raise PostError(f"通信エラー: {e}") from e
