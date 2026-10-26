"""X / Instagram / LinkedIn への投稿処理。"""
import os
import re
import time

import requests
from requests_oauthlib import OAuth1

TIMEOUT = 60


class PostError(Exception):
    pass


def _check(r: requests.Response, where: str):
    if r.status_code >= 400:
        raise PostError(f"{where} 失敗 ({r.status_code}): {r.text[:500]}")


# ---------------------------------------------------------------- X
X_KEYS = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"]


def x_weight(s: str) -> int:
    """Xの文字数カウント（日本語・絵文字は2、英数字は1。上限280）"""
    w = 0
    for ch in s:
        c = ord(ch)
        if c <= 0x10FF or 0x2000 <= c <= 0x200D or 0x2010 <= c <= 0x201F or 0x2032 <= c <= 0x2037:
            w += 1
        else:
            w += 2
    return w


def fit_x(text: str, limit: int = 280) -> str:
    if x_weight(text) <= limit:
        return text
    while x_weight(text + "…") > limit:
        text = text[:-1]
    return text + "…"


def post_x(text: str) -> str:
    auth = OAuth1(*(os.environ[k] for k in X_KEYS))
    r = requests.post("https://api.x.com/2/tweets", json={"text": fit_x(text)}, auth=auth, timeout=TIMEOUT)
    _check(r, "X投稿")
    return r.json()["data"]["id"]


# ---------------------------------------------------------------- Instagram
IG_KEYS = ["IG_ACCESS_TOKEN"]


def _ig_base() -> str:
    return "https://graph.instagram.com/" + os.environ.get("IG_API_VERSION", "v23.0")


def wait_until_public(url: str, seconds: int = 120):
    """GitHubに置いた画像がネット上で見えるようになるまで待つ"""
    for _ in range(seconds // 5):
        try:
            if requests.head(url, timeout=15).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(5)
    raise PostError(f"画像URLにアクセスできません（リポジトリがPublicか確認）: {url}")


def post_instagram(image_url: str, caption: str) -> str:
    token = os.environ["IG_ACCESS_TOKEN"]
    base = _ig_base()

    r = requests.get(f"{base}/me", params={"fields": "user_id,username", "access_token": token}, timeout=TIMEOUT)
    _check(r, "Instagramアカウント取得")
    uid = r.json()["user_id"]

    wait_until_public(image_url)
    r = requests.post(
        f"{base}/{uid}/media",
        data={"image_url": image_url, "caption": caption[:2200], "access_token": token},
        timeout=TIMEOUT,
    )
    _check(r, "Instagram画像登録")
    creation_id = r.json()["id"]

    for _ in range(24):  # 最大2分、Instagram側の画像処理を待つ
        r = requests.get(f"{base}/{creation_id}", params={"fields": "status_code", "access_token": token}, timeout=TIMEOUT)
        _check(r, "Instagram処理状況")
        status = r.json().get("status_code")
        if status == "FINISHED":
            break
        if status in ("ERROR", "EXPIRED"):
            raise PostError(f"Instagram画像処理エラー: {r.text[:300]}")
        time.sleep(5)

    r = requests.post(f"{base}/{uid}/media_publish", data={"creation_id": creation_id, "access_token": token}, timeout=TIMEOUT)
    _check(r, "Instagram公開")
    return r.json()["id"]


# ---------------------------------------------------------------- LinkedIn
LI_KEYS = ["LI_ACCESS_TOKEN"]
_LI_RESERVED = set("\\|{}@[]()<>#*_~")


def linkedin_text(text: str) -> str:
    """LinkedInの本文は記号をエスケープしないと途中で切れるため変換。#タグはハッシュタグとして残す。"""
    escaped = "".join("\\" + ch if ch in _LI_RESERVED else ch for ch in text)
    return re.sub(r"\\#([^\s\\#]+)", r"{hashtag|\\#|\1}", escaped)


def post_linkedin(text: str, image_path: str, image_title: str) -> str:
    token = os.environ["LI_ACCESS_TOKEN"]
    auth = {"Authorization": f"Bearer {token}"}
    rest = {
        **auth,
        "LinkedIn-Version": os.environ.get("LI_API_VERSION", "202606"),
        "X-Restli-Protocol-Version": "2.0.0",
    }

    r = requests.get("https://api.linkedin.com/v2/userinfo", headers=auth, timeout=TIMEOUT)
    _check(r, "LinkedInアカウント取得（トークン切れの可能性）")
    author = f"urn:li:person:{r.json()['sub']}"

    r = requests.post(
        "https://api.linkedin.com/rest/images?action=initializeUpload",
        headers=rest,
        json={"initializeUploadRequest": {"owner": author}},
        timeout=TIMEOUT,
    )
    _check(r, "LinkedIn画像アップロード準備")
    upload = r.json()["value"]
    with open(image_path, "rb") as f:
        r = requests.put(upload["uploadUrl"], headers=auth, data=f.read(), timeout=TIMEOUT)
    _check(r, "LinkedIn画像アップロード")

    body = {
        "author": author,
        "commentary": linkedin_text(text)[:3000],
        "visibility": "PUBLIC",
        "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": []},
        "content": {"media": {"title": image_title, "id": upload["image"]}},
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    r = requests.post("https://api.linkedin.com/rest/posts", headers=rest, json=body, timeout=TIMEOUT)
    _check(r, "LinkedIn投稿")
    return r.headers.get("x-restli-id", "ok")


# ---------------------------------------------------------------- YouTube（ショート）
YT_KEYS = ["YT_CLIENT_ID", "YT_CLIENT_SECRET", "YT_REFRESH_TOKEN"]


def _yt_access_token() -> str:
    r = requests.post("https://oauth2.googleapis.com/token", data={
        "client_id": os.environ["YT_CLIENT_ID"],
        "client_secret": os.environ["YT_CLIENT_SECRET"],
        "refresh_token": os.environ["YT_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }, timeout=TIMEOUT)
    _check(r, "YouTube認証（リフレッシュトークン切れの可能性）")
    return r.json()["access_token"]


def post_youtube(video_path: str, title: str, description: str) -> str:
    """縦長・3分以内の動画はショートとして扱われる。公開範囲は YT_PRIVACY（既定 public）"""
    token = _yt_access_token()
    size = os.path.getsize(video_path)
    meta = {
        "snippet": {
            "title": title[:100],
            "description": description[:4900],
            "categoryId": "22",  # ブログ
            "defaultLanguage": "ja",
        },
        "status": {
            "privacyStatus": os.environ.get("YT_PRIVACY") or "public",  # Actions では未設定でも空文字が来る
            "selfDeclaredMadeForKids": False,
        },
    }
    r = requests.post(
        "https://www.googleapis.com/upload/youtube/v3/videos",
        params={"uploadType": "resumable", "part": "snippet,status"},
        headers={"Authorization": f"Bearer {token}", "X-Upload-Content-Type": "video/mp4",
                 "X-Upload-Content-Length": str(size)},
        json=meta, timeout=TIMEOUT,
    )
    _check(r, "YouTubeアップロード準備")
    with open(video_path, "rb") as f:
        r = requests.put(r.headers["Location"], headers={"Content-Type": "video/mp4"}, data=f, timeout=300)
    _check(r, "YouTubeアップロード")
    return r.json()["id"]
