#!/bin/bash
# scraper.mjsを実行し、成功時のみ差分をGitHubへpushする。
# launchd の両ジョブ(stealth-daily / stealth-dashboard)から呼ばれる。
set -uo pipefail

cd "$(dirname "$0")"

# 評価ロジック・パーサーの回帰テストを毎回の実行前に走らせる。ここで
# 落ちるということはコード自体が壊れているということなので、壊れた
# ロジックで生成したページを誤って公開しないよう、scraper実行・push
# ごと止める（このセッション中に見つかった評価バグの再発防止策）。
/usr/local/bin/node --test test/*.test.mjs >/tmp/stealth_test.log 2>&1
TEST_EXIT=$?
if [ "$TEST_EXIT" -ne 0 ]; then
  echo "⚠️ 単体テスト失敗 (exit $TEST_EXIT) — scraper実行・pushをスキップ"
  tail -40 /tmp/stealth_test.log
  exit "$TEST_EXIT"
fi

/usr/local/bin/node scraper.mjs "$@"
SCRAPER_EXIT=$?

if [ "$SCRAPER_EXIT" -ne 0 ]; then
  echo "⚠️ scraper.mjs が異常終了 (exit $SCRAPER_EXIT) — pushはスキップ"
  exit "$SCRAPER_EXIT"
fi

git add index.html ambush_cache.json sbi_earnings_cache.json tdnet_cache.json smart_entry_cache.json holiday_cache.json

if git diff --staged --quiet; then
  exit 0
fi

git commit -m "auto-update dashboard $(date '+%Y-%m-%d %H:%M:%S %Z')" >/dev/null
git pull --ff-only >/dev/null 2>&1
if ! git push 2>&1; then
  echo "⚠️ git push 失敗"
  exit 1
fi
