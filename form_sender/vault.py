"""送り先リスト・調査メモ・送信結果を暗号化してリポジトリに置く（リポジトリは公開のため）。

  python vault.py open    state.enc を復号して作業用ファイルに戻す（無ければ何もしない）
  python vault.py close   作業用ファイルをまとめて暗号化し state.enc に書く
  python vault.py pack 出力先 フォルダ   フォルダ（スクリーンショットなど）を暗号化して1ファイルにする

鍵は環境変数 FORM_STATE_KEY（GitHub の Secrets）。
"""
import io
import os
import sys
import zipfile
from pathlib import Path

from cryptography.fernet import Fernet

import config

STATE_ENC = config.BASE_DIR / "state.enc"
FILES = [config.COMPANIES_CSV, config.NG_LIST_CSV, config.RESULT_CSV, config.RESEARCH_JSONL, config.DISCOVER_STATE]


def _fernet() -> Fernet:
    key = os.environ.get("FORM_STATE_KEY")
    if not key:
        sys.exit("FORM_STATE_KEY が未設定です")
    return Fernet(key.encode())


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
        return
    data = _fernet().decrypt(STATE_ENC.read_bytes())
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        z.extractall(config.BASE_DIR)
    print("state.enc を復号しました")


def close_state() -> None:
    STATE_ENC.write_bytes(_fernet().encrypt(_zip(FILES, config.BASE_DIR)))
    print("state.enc に暗号化して保存しました")


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
    elif cmd == "pack" and len(sys.argv) == 4:
        pack(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
