// watchlist.mjs（手動ウォッチリスト）の配線テスト。
//
// 実測ギャップ（ユーザー指摘、2026-09-10）: シマダヤ(250A)は1Q決算が
// 既に開示済みだが直近14営業日のTDnet枠から外れ、次回(2Q)決算もまだ
// SBI決算カレンダーに載っていなかったため、SMART ENTRY（buildUniverse）
// ・AMBUSH（sbi.mjsのextraCodes、以前は誰も渡していなかった未使用
// パラメータ）どちらの発見経路にも一度も乗らず、システムから完全に
// 見えなくなっていた。このテストは、手動ウォッチリストが両方の経路に
// 正しく配線されていることを機械的に確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANUAL_WATCHLIST, MANUAL_WATCHLIST_CODES } from '../watchlist.mjs';
import { buildUniverse } from '../smart_entry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

test('MANUAL_WATCHLIST: シマダヤ(250A)が登録されている', () => {
  assert.ok(MANUAL_WATCHLIST.some((w) => w.code === '250A'), 'シマダヤ(250A)がMANUAL_WATCHLISTに見つかりません');
  assert.deepEqual(MANUAL_WATCHLIST_CODES, MANUAL_WATCHLIST.map((w) => w.code));
});

test('buildUniverse: tdNames/sbiStocksが両方空でも、手動ウォッチリストの銘柄はユニバースに入る', () => {
  const universe = buildUniverse({ tdNames: {}, sbiStocks: {} });
  assert.equal(universe['250A'], 'シマダヤ');
});

test('buildUniverse: tdNames/sbiStocksに既に同じcodeがあれば、そちらの名前を優先する（手動リストで上書きしない）', () => {
  const universe = buildUniverse({ tdNames: { '250A': 'TDnet表記の名前' }, sbiStocks: {} });
  assert.equal(universe['250A'], 'TDnet表記の名前');
});

test('buildUniverse: manualWatchlistを明示的に空配列で渡せば手動ウォッチリストは効かない（呼び出し側で無効化できる）', () => {
  const universe = buildUniverse({ tdNames: {}, sbiStocks: {}, manualWatchlist: [] });
  assert.equal(universe['250A'], undefined);
});

test('配線: scraper.mjsがloadEarningsCalendarにMANUAL_WATCHLIST_CODESをextraCodesとして渡している（sbi.mjsのextraCodesが未配線のまま放置される再発防止）', () => {
  const src = fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8');
  assert.match(src, /import \{ MANUAL_WATCHLIST_CODES \} from '\.\/watchlist\.mjs'/);
  assert.match(src, /loadEarningsCalendar\(\{[^}]*extraCodes:\s*MANUAL_WATCHLIST_CODES/s);
});

test('配線: smart_entry.mjsのrunSmartEntryScreenがbuildUniverseを呼ぶ際、手動ウォッチリストがデフォルトで効く（明示的にmanualWatchlist:[]を渡していない）', () => {
  const src = fs.readFileSync(path.join(root, 'smart_entry.mjs'), 'utf-8');
  const call = src.match(/const universe = buildUniverse\(\{[^}]*\}\);/)?.[0] ?? '';
  assert.ok(call, 'runSmartEntryScreen内のbuildUniverse呼び出しが見つかりません');
  assert.doesNotMatch(call, /manualWatchlist/, 'manualWatchlistを明示的に上書きしていると、既定のMANUAL_WATCHLISTが効かなくなります');
});
