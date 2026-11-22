#!/usr/bin/env bash
# 本番（https://ai-ceo-command.netlify.app）へ公開する。
# サイトは GitHub と連携していない（ボットの毎日のコミットで Netlify の無料枠を使わないため）。
# 管理画面を変更したときだけ、このスクリプトで公開する。
#
# 必要なもの：Netlify の合鍵（NETLIFY_AUTH_TOKEN。Claude の環境では Network secrets から自動で付く）
# 使い方：bash scripts/deploy-netlify.sh
set -euo pipefail
SITE_ID="${NETLIFY_SITE_ID:-023b4fde-fadd-4ad7-94b1-88a082b62c88}"
ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Git に入っているファイルだけのきれいなコピーから公開する（.env.local や data/ を絶対に含めない）
git -C "$ROOT" archive HEAD ai-ceo-project | tar -x -C "$WORK"
cd "$WORK/ai-ceo-project"
npm ci --no-audit --no-fund
export NODE_USE_ENV_PROXY=1 NETLIFY_AUTH_TOKEN="${NETLIFY_AUTH_TOKEN:-proxy-injected}"
NETLIFY="npx -y netlify-cli@27.17.0"
$NETLIFY link --id "$SITE_ID"
# extensions の確認（別ホスト）を飛ばすため offline でビルドし、
# Next.js のアダプターが作る .netlify/static を公開フォルダにする（.next ではない）
$NETLIFY build --offline --context production
$NETLIFY deploy --prod --no-build --dir .netlify/static
