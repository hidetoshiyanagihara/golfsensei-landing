"""送り先リスト・調査メモ・送信結果を暗号化してリポジトリに置く（リポジトリは公開のため）。

  python vault.py open    state.enc を復号して作業用ファイルに戻す（無ければ何もしない）
  python vault.py close   作業用ファイルをまとめて暗号化し state.enc に書く
  python vault.py pack 出力先 フォルダ   フォルダ（スクリーンショットなど）を暗号化して1ファイルにする
  python vault.py merge 古いstate.enc   open のあとに、古い記録を今の記録に足す（消えた記録を戻すとき）

鍵は環境変数 FORM_STATE_KEY（GitHub の Secrets）。好きな長い合言葉でよい（そこから暗号の鍵を作る）。
"""
import base64
import hashlib
import io
import os
import sys
import zipfile
from pathlib import Path

from cryptography.fernet import Fernet

import config

STATE_ENC = config.BASE_DIR / "state.enc"
OPENED = config.BASE_DIR / ".vault_opened"   # open した印。これがないと close しない（空の記録で上書きしないため）
FILES = [config.COMPANIES_CSV, config.NG_LIST_CSV, config.RESULT_CSV, config.RESEARCH_JSONL, config.DISCOVER_STATE]
# 株式会社スターストラックのフォーム営業（starstruck.py）の送り先・送らない会社・結果
FILES += [config.BASE_DIR / n for n in ("ss_companies.csv", "ss_ng.csv", "ss_result.csv")]
# 処理の途中で止まった会社の印（次の回にその会社を飛ばすため。2026-11-12）
FILES += [config.INFLIGHT_JSON, config.BASE_DIR / ".ss_inflight.json"]


def _fernet() -> Fernet:
    key = os.environ.get("FORM_STATE_KEY")
    if not key:
        sys.exit("FORM_STATE_KEY が未設定です")
    # 合言葉から暗号の鍵を作る（同じ合言葉なら、いつでも同じ鍵になる）
    raw = hashlib.pbkdf2_hmac("sha256", key.strip().encode(), b"axion-form-sales", 200_000)
    return Fernet(base64.urlsafe_b64encode(raw))


def _zip(paths: list[Path], base: Path) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for p in paths:
            if p.exists():
                z.write(p, p.relative_to(base).as_posix())
    return buf.getvalue()


def open_state() -> None:
    if not STATE_ENC.exists():
        print("state.enc がないので、空の状態から始めます")
        OPENED.touch()
        return
    data = _fernet().decrypt(STATE_ENC.read_bytes())
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(config.BASE_DIR)
    OPENED.touch()
    print("state.enc を復号しました")


def close_state() -> None:
    if not OPENED.exists():
        # 2026-11-12：復号の前に打ち切られた実行が、空の記録で state.enc を上書きした。二度と起きないようにする
        print("記録を復号していないので、保存しません（空の記録で上書きしないため）")
        return
    STATE_ENC.write_bytes(_fernet().encrypt(_zip(FILES, config.BASE_DIR)))
    print("state.enc に暗号化して保存しました")


def _csv_union(old: bytes, cur: Path) -> None:
    import csv
    old_rows = list(csv.DictReader(io.StringIO(old.decode("utf-8-sig"))))
    old_fields = list(csv.DictReader(io.StringIO(old.decode("utf-8-sig"))).fieldnames or [])
    cur_rows, cur_fields = [], []
    if cur.exists():
        with cur.open(encoding="utf-8-sig", newline="") as f:
            r = csv.DictReader(f)
            cur_fields, cur_rows = list(r.fieldnames or []), list(r)
    fields = old_fields + [f for f in cur_fields if f not in old_fields]
    seen, rows = set(), []
    for row in old_rows + cur_rows:
        key = tuple(row.get(f, "") or "" for f in fields)
        if key not in seen:
            seen.add(key)
            rows.append(row)
    with cur.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def merge_state(old_path: str) -> None:
    """古い state.enc の中身を、いま open している記録に足す。CSV・JSONL は行を合わせ（重複は1つに）、
    それ以外のファイルは今のものがなければ古いものを使う"""
    if not OPENED.exists():
        sys.exit("先に python vault.py open を実行してください")
    data = _fernet().decrypt(Path(old_path).read_bytes())
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            cur = config.BASE_DIR / name
            old = z.read(name)
            if name.endswith(".csv"):
                _csv_union(old, cur)
            elif name.endswith(".jsonl"):
                cur_lines = cur.read_text(encoding="utf-8").splitlines() if cur.exists() else []
                lines = list(dict.fromkeys(old.decode("utf-8").splitlines() + cur_lines))
                cur.write_text("\n".join(l for l in lines if l) + "\n", encoding="utf-8")
            elif not cur.exists():
                cur.write_bytes(old)
            print(f"足した：{name}")


def pack(out: str, folder: str) -> None:
    root = Path(folder)
    paths = sorted(p for p in root.rglob("*") if p.is_file()) if root.exists() else []
    Path(out).write_bytes(_fernet().encrypt(_zip(paths, root)))
    print(f"{len(paths)} ファイルを {out} に暗号化しました")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "open":
        open_state()
    elif cmd == "close":
        close_state()
    elif cmd == "merge" and len(sys.argv) == 3:
        merge_state(sys.argv[2])
    elif cmd == "pack" and len(sys.argv) == 4:
        pack(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
