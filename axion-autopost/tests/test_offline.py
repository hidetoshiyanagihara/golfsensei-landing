"""オフラインの通しテスト:  python tests/test_offline.py
AIとSNSのAPIは差し替えるので、実際には何も生成・投稿しない。"""
import json
import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from autopost import generate, main, platforms  # noqa: E402

failures = []


def check(cond, msg):
    print(("OK  " if cond else "NG  ") + msg)
    if not cond:
        failures.append(msg)


tmp = Path(tempfile.mkdtemp())
main.ROOT, main.POSTS, main.IMAGES, main.HISTORY = tmp, tmp / "posts", tmp / "images", tmp / "history.json"

# ---------------------------------------------------------------- 生成（AIは差し替え）
(tmp / "prompt.md").write_text((ROOT / "prompt.md").read_text(encoding="utf-8"), encoding="utf-8")
main.PROMPT, main.MEMO = tmp / "prompt.md", tmp / "memo.md"
main.MEMO.write_text("今週、清掃現場で管理会社の担当者と話した", encoding="utf-8")
GOOD = {
    "theme": "繁忙期の仕込み", "target": "名古屋のリフォーム会社の社長",
    "x_post": "「今月は断るほど忙しい」\nその3ヶ月後に暇な月が来るリフォーム会社は多いです。\n原因は営業力じゃなく、忙しい時に仕込みが止まること。",
    "x_char_count": 70, "instagram_image_title": "忙しい月の次が怖い",
    "instagram_image_sub": "繁忙期こそ3ヶ月後のアポを仕込む",
    "instagram_caption": "本文\n\nDMで『リスト』と送ってください\n#名古屋リフォーム #愛知工務店 #営業代行",
    "self_check": {"hook": 5, "target": 5, "concrete": 4, "insight": 4, "reason_to_contact": 4},
    "short_dialogue": [{"speaker": "tsunagari", "line": "うちは紹介でしか仕事来んよ"},
                       {"speaker": "apo", "line": "来る月って、選べます？"},
                       {"speaker": "apo", "line": "繁忙期こそ3ヶ月後を仕込みましょう"}],
}
replies = [
    '前置き {"theme": "x"}',
    json.dumps({**GOOD, "x_post": "あ" * 141}),
    json.dumps({**GOOD, "self_check": {**GOOD["self_check"], "insight": 3}}),
]
calls_ai = []


class FakeMessages:
    def create(self, **kw):
        calls_ai.append(kw)
        return SimpleNamespace(content=[SimpleNamespace(type="thinking", thinking=""),
                                        SimpleNamespace(type="text", text=replies.pop(0))],
                               stop_reason="end_turn", stop_details=None)


generate.anthropic.Anthropic = lambda: SimpleNamespace(messages=FakeMessages())
os.environ.pop("ANTHROPIC_API_KEY", None)
main.cmd_generate()
check(len(calls_ai) == 0 and not (tmp / "posts").exists(), "AIのキー未設定なら何もしない（失敗にしない）")
main.cmd_publish()
check(True, "AIのキー未設定で投稿がなくても失敗にしない")
os.environ["ANTHROPIC_API_KEY"] = "dummy"

# 直近の投稿（被り防止用）を用意
d0 = main.today()
(tmp / "posts").mkdir()
main.save_json(main.paths(d0 - timedelta(days=2))[0], {"theme": "元請け依存", "x": "元請け1社に頼る怖さ"})
main.save_json(main.paths(d0 - timedelta(days=20))[0], {"theme": "古い投稿", "x": "20日前"})

try:
    main.cmd_generate()
    gen_error = None
except RuntimeError as e:
    gen_error = str(e)
check(gen_error and "3回失敗" in gen_error and "自己チェック" in gen_error, "JSONなし・141字・自己チェック3点は作り直し、3回でエラー")
check("140字以内" in calls_ai[2]["messages"][0]["content"] or "141字" in calls_ai[2]["messages"][0]["content"],
      "作り直し時は前回の問題をAIに伝える")
system = calls_ai[0]["system"]
check("{{today}}" not in system and "{{weekday}}" not in system and f"{d0:%Y年%m月%d日}" in system, "日付・曜日を差し込む")
check("元請け依存" in system and "古い投稿" not in system, "直近14日分の投稿だけを渡す")
check("清掃現場で管理会社" in system, "memo.md を追加メモとして渡す")
check("{{未確定。" in system, "指示文の {{ }} はそのまま残す")
check("清掃・管理の会社を経営" not in system, "プロンプトに代表の他事業の経歴は書かない")
req = calls_ai[0]
check(req["max_tokens"] >= 16000 and req["output_config"]["format"]["type"] == "json_schema",
      "考える分も含めた十分な上限と、JSON形式の指定（structured outputs）")
schema_keys = set(req["output_config"]["format"]["schema"]["properties"])
check(schema_keys == set(generate.REQUIRED_KEYS) | {"x_char_count", "self_check", "short_dialogue"},
      "出力形式は prompt.md の12章と同じ")

calls_ai.clear()
for bad, why in ((GOOD["short_dialogue"][:2], "回"), ([{"speaker": "tsunagari", "line": "あ" * 37}] * 4, "長すぎる"),
                 ([{"speaker": "tsunagari", "line": "僕も清掃の仕事を"}] * 4, "禁止表現"),
                 ([{"speaker": "apo", "line": "DMで「リスト」と送ってね"}] * 4, "DM")):
    try:
        generate.check_post({**GOOD, "short_dialogue": bad})
        check(False, f"会話の検査（{why}）")
    except ValueError as e:
        check(why in str(e), f"会話の検査：{why}なら作り直す")
replies[:] = [json.dumps({**GOOD, "instagram_caption": "絶対に反響が出ます"}),
              json.dumps({**GOOD, "x_post": "僕も清掃の現場側の人間なので"}), json.dumps(GOOD)]
main.cmd_generate()
day = d0.strftime("%Y-%m-%d")
saved = json.loads((tmp / "posts" / f"{day}.json").read_text(encoding="utf-8"))
check(len(calls_ai) == 3, "禁止表現（絶対・代表の他事業の「清掃」）を含む出力は作り直す")
check(saved["x"] == GOOD["x_post"] and saved["instagram"] == GOOD["instagram_caption"]
      and saved["image_title"] == GOOD["instagram_image_title"] and saved["target"] == GOOD["target"],
      "新しい出力形式を投稿用に保存")
check(saved["x_char_count"] == len(GOOD["x_post"]), "X文字数は実際に数え直す")
img = tmp / "images" / f"{day}.jpg"
check(img.exists() and img.read_bytes()[:3] == b"\xff\xd8\xff", "画像はJPEGで保存（InstagramはPNG不可）")
from PIL import Image  # noqa: E402
check(Image.open(img).size == (1080, 1350), "画像サイズ 1080x1350")

# ---------------------------------------------------------------- 投稿（APIは差し替え）
calls = []
platforms.post_x = lambda text: calls.append(("x", text)) or "111"


def ig_fail(url, caption):
    calls.append(("instagram", url))
    raise platforms.PostError("Instagram画像登録 失敗 (400)")


platforms.post_instagram = ig_fail
for k in platforms.X_KEYS + platforms.IG_KEYS:
    os.environ[k] = "dummy"
os.environ.pop("LI_ACCESS_TOKEN", None)
os.environ["GITHUB_REPOSITORY"] = "owner/golfsensei-landing"
os.environ["GITHUB_WORKSPACE"] = str(tmp.parent)  # このフォルダがリポジトリのサブフォルダにある状態
try:
    main.cmd_publish()
    exited = None
except SystemExit as e:
    exited = str(e)
res = json.loads((tmp / "posts" / f"{day}.json").read_text(encoding="utf-8"))["results"]
check(res["x"] == "ok:111" and res["instagram"].startswith("error:") and "linkedin" not in res,
      "成功・失敗を記録（LinkedIn用の本文はないので対象外）")
check(("instagram", f"https://raw.githubusercontent.com/owner/golfsensei-landing/main/{tmp.name}/images/{day}.jpg")
      in calls, "Instagramにはサブフォルダ込みの公開URLのJPEGを渡す")
check(exited and "instagram" in exited, "失敗があれば終了コードで知らせる")
check(json.loads(main.HISTORY.read_text(encoding="utf-8"))[-1]["theme"] == GOOD["theme"], "テーマを履歴に残す")

calls.clear()
platforms.post_instagram = lambda url, caption: calls.append(("instagram", url)) or "222"
main.cmd_publish()
res = json.loads((tmp / "posts" / f"{day}.json").read_text(encoding="utf-8"))["results"]
check([c[0] for c in calls] == ["instagram"] and res["instagram"] == "ok:222", "再実行では失敗分だけ投稿")
check(len(json.loads(main.HISTORY.read_text(encoding="utf-8"))) == 1, "履歴は1日1件")

# ---------------------------------------------------------------- LinkedIn の本文変換
check(platforms.linkedin_text("費用(税別) #営業代行") == "費用\\(税別\\) {hashtag|\\#|営業代行}", "LinkedIn: 記号エスケープとハッシュタグ")

# ---------------------------------------------------------------- YouTube ショート（2人の会話）
from autopost import video  # noqa: E402

check(saved["short_dialogue"] == GOOD["short_dialogue"], "ショートの会話を保存")
short_post = {"theme": "誤解に答える：紹介しか無理は本当？", "image_title": "紹介しか無理は本当？", "image_sub": "社長へ",
              "x": "Q.紹介しか無理？\n\n紹介は来る月を選べない。\n\nDMで「リスト」と送ってください。",
              "instagram": "キャプション", "short_dialogue": GOOD["short_dialogue"]}
scenes = video._scenes(short_post)
check([s["who"] for s in scenes] == ["tsunagari", "apo", "apo", "apo"] and scenes[-1].get("cta"),
      "ショート：会話の順に話し、最後はアポくんが無料リストを案内")
old = video.dialogue_from_post({k: v for k, v in short_post.items() if k != "short_dialogue"})
check(old[0] == {"speaker": "tsunagari", "line": "紹介しか無理は本当？"} and all("DM" not in d["line"] for d in old),
      "ショート：会話のない古い投稿は見出しとX本文から作る")
from autopost.image_card import _font  # noqa: E402
check(all("20" in ln or "2" not in ln for ln in video._wrap("見込み客リストを20件無料で作ります", _font("Bold", 100), 400)),
      "ショート：数字（20）を行の途中で分けない")
mp4 = tmp / "short.mp4"
sec, credits = video.make_short(short_post, str(mp4), bgm=tmp / "no-bgm.mp3", speak=None)
check(mp4.exists() and mp4.stat().st_size > 10_000 and 5 < sec < 60 and credits == [], "ショート：声なしの縦長MP4を書き出す")

# 声（VOICEVOX は差し替え）：セリフの長さに場面を合わせ、音声トラックを入れる
import numpy as np  # noqa: E402
from autopost import voice  # noqa: E402

said = []


def fake_speak(text, who):
    said.append((who, text))
    return (np.sin(np.arange(int(voice.RATE * 3.0)) / 8) * 6000).astype(np.int16)   # どのセリフも3秒


scenes = video._scenes(short_post, fake_speak)
check(all(abs(sc["talk"] - 3.0) < 0.01 and sc["sec"] >= 3.0 for sc in scenes), "声：場面の長さを読み上げの長さに合わせる")
check(said[-1][0] == "apo" and "チャンネルのリンク" in said[-1][1] and "DM" not in said[-1][1],
      "声：最後はアポくんが無料リストとチャンネルのリンクを案内（YouTubeにDMはない）")
desc = main.youtube_description({"instagram": "本文1\n\nDMで「リスト」と送ってください。\n\n#名古屋"}, ["VOICEVOX:白上虎太郎"])
check("DMで「リスト」と送ってください" not in desc and "axionsales.vercel.app/youtube" in desc and "#名古屋" in desc
      and desc.endswith("音声：VOICEVOX:白上虎太郎"), "YouTube説明欄：DMの案内を外し、LPとクレジットを入れる")
mp4v = tmp / "short_voice.mp4"
sec_v, _ = video.make_short(short_post, str(mp4v), bgm=tmp / "no-bgm.mp3", speak=fake_speak)
import imageio_ffmpeg  # noqa: E402
import subprocess  # noqa: E402
probe = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-i", str(mp4v), "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
check("Audio" in probe and "mean_volume: -91" not in probe and sec_v >= 3.0 * len(scenes), "声：音声トラックに声が入る")


class FakeVoiceRes:
    def __init__(self, data=None, content=b""):
        self._data, self.content, self.ok = data, content, True

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


import io  # noqa: E402
import wave  # noqa: E402

buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(voice.RATE)
    w.writeframes(np.zeros(2400, dtype=np.int16).tobytes())
vcalls = []


def fake_voice_post(url, **kw):
    vcalls.append((url, kw))
    return FakeVoiceRes({"speedScale": 1.0}) if url.endswith("/audio_query") else FakeVoiceRes(content=buf.getvalue())


real_vpost, real_vget = voice.requests.post, voice.requests.get
voice.requests.post = fake_voice_post
voice.requests.get = lambda url, **kw: FakeVoiceRes([{"name": "白上虎太郎", "styles": [{"id": 12}, {"id": 32}]},
                                                     {"name": "春日部つむぎ", "styles": [{"id": 8}]}])
audio = voice.synth("DMで送ってね", "apo")
check(len(audio) == 2400 and vcalls[0][1]["params"]["text"] == "ディーエムで送ってね"
      and vcalls[1][1]["json"]["speedScale"] == voice.SPEED["apo"], "声：VOICEVOXで読み上げ（DMはディーエムと読む）")
check(voice.credits() == ["VOICEVOX:白上虎太郎", "VOICEVOX:春日部つむぎ"], "声：説明欄に入れるクレジット")
voice.requests.post, voice.requests.get = real_vpost, real_vget

yt_calls = []


def fake_post(url, **kw):
    yt_calls.append(("POST", url, kw))
    if "oauth2" in url:
        return FakeRes({"access_token": "AT"})
    res = FakeRes({})
    res.headers = {"Location": "https://upload.example/session"}
    return res


def fake_put(url, **kw):
    yt_calls.append(("PUT", url, kw))
    return FakeRes({"id": "VIDEO123"})


class FakeRes:
    def __init__(self, data, status=200):
        self.status_code, self._data, self.text, self.headers = status, data, str(data), {}

    def json(self):
        return self._data


real_post, real_put = platforms.requests.post, platforms.requests.put
platforms.requests.post, platforms.requests.put = fake_post, fake_put
os.environ.update({"YT_CLIENT_ID": "c", "YT_CLIENT_SECRET": "s", "YT_REFRESH_TOKEN": "r", "YT_PRIVACY": ""})
vid = platforms.post_youtube(str(mp4), "タイトル #Shorts", "説明")
meta = yt_calls[1][2]["json"]
check(vid == "VIDEO123" and yt_calls[0][2]["data"]["grant_type"] == "refresh_token", "YouTube：リフレッシュトークンで認証して投稿")
check(meta["status"]["privacyStatus"] == "public" and meta["snippet"]["title"] == "タイトル #Shorts",
      "YouTube：公開範囲は未設定（空文字）なら public")
platforms.requests.post, platforms.requests.put = real_post, real_put

print(f"\n{'全テスト成功' if not failures else f'{len(failures)} 件失敗'}")
sys.exit(1 if failures else 0)
