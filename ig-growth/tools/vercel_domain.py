#!/usr/bin/env python3
"""プロフィールのリンク用の短いアドレス（brand.json の link_url、例 copipe-ai.vercel.app）を
Vercel のプロジェクトに追加する。GitHub Actions の「IG growth short link」から 1 回だけ動けばよい。

- トークンは環境変数 VERCEL_TOKEN（GitHub Secrets）から読む。ファイルやコードには書かない
- すでに追加済みなら何もしない
- 個人アカウントでもチーム（Team）でも動くように、プロジェクトが見つかるまでチームを順に探す
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.vercel.com"
PROJECT = os.environ.get("VERCEL_PROJECT", "golfsensei-landing")


def call(method: str, path: str, body: dict | None = None, team: str | None = None) -> tuple[int, dict]:
    q = f"?{urllib.parse.urlencode({'teamId': team})}" if team else ""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path + q, data=data, method=method, headers={
        "Authorization": f"Bearer {os.environ['VERCEL_TOKEN']}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}


def main() -> int:
    if not os.environ.get("VERCEL_TOKEN", "").strip():
        print("VERCEL_TOKEN が未設定のためスキップします")
        return 0
    link = json.loads((ROOT / "brand.json").read_text(encoding="utf-8")).get("link_url", "")
    domain = urllib.parse.urlparse(link).netloc or link
    if not domain.endswith(".vercel.app"):
        print(f"{domain} は vercel.app のアドレスではないため、手動で設定してください")
        return 1
    teams = [None]
    st, res = call("GET", "/v2/teams")
    if st == 200:
        teams += [t["id"] for t in res.get("teams", [])]
    for team in teams:
        st, proj = call("GET", f"/v9/projects/{PROJECT}", team=team)
        if st != 200:
            continue
        st, doms = call("GET", f"/v9/projects/{PROJECT}/domains", team=team)
        if st == 200 and any(d.get("name") == domain for d in doms.get("domains", [])):
            print(f"{domain} はすでに追加済みです")
            return 0
        st, res = call("POST", f"/v10/projects/{PROJECT}/domains", {"name": domain}, team=team)
        if st in (200, 201):
            print(f"{domain} をプロジェクト {PROJECT} に追加しました。数分後に https://{domain} で開けます")
            return 0
        err = res.get("error", {})
        print(f"追加に失敗しました（{st}）：{err.get('code')} {err.get('message')}")
        if err.get("code") in ("domain_taken", "domain_already_in_use", "not_available"):
            print("このアドレスは他で使われています。brand.json の link_url を別の名前（例 copipeai.vercel.app）にしてください")
        return 1
    print(f"プロジェクト {PROJECT} が見つかりません（トークンの範囲＝Scope に、このプロジェクトのあるアカウント／チームを選んでください）")
    return 1


if __name__ == "__main__":
    sys.exit(main())
