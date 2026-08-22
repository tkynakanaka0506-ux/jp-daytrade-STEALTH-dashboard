// irbank.mjsの配当データパーサーの回帰テスト。
//
// 対象バグ（再発防止）:
//  1. 実績/予想/修正の区分行が同じ年度に同居する壊れたHTML構造で、
//     予想行を実績として拾ってしまう（増配/減配判定を狂わせる）。
//  2. 数値列の構成が銘柄によって異なる（中間/期末/合計の3列、株式分割
//     経験銘柄は+分割調整で4列、期末/合計のみの2列）のに列数を固定して
//     いたため、8227しまむら・6387サムコ等で0件になっていた。
//  3. 株式分割があった年は「合計」（生の円/株）だけを見ると見かけ上
//     「減配」したように見える（6966三井ハイテック・8227しまむらで実測）。
//     「分割調整」列がある銘柄はそちらを基準にしないと増配/減配の方向を
//     取り違える。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDividendYenHistory, computeDividendStreak } from '../irbank.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8');

test('3列（中間/期末/合計、分割調整なし）: 予想行を除外し実績のみ拾う', () => {
  const rows = parseDividendYenHistory(fixture('dividend_3col.html'));
  assert.deepEqual(rows.map((r) => r.amount), [80, 120, 120]);
  assert.deepEqual(rows.map((r) => r.period), ['2024年5月', '2025年5月', '2026年5月']);
});

test('4列（+分割調整）: 分割調整列を基準にする。生の合計だけでは減配に見える年でも増配と正しく判定できる', () => {
  const rows = parseDividendYenHistory(fixture('dividend_4col_split.html'));
  // 生の「合計」列は 280→200→215（見かけ上は減配）だが、分割調整後は
  // 46.67→66.67→71.67 と一貫して増配している。分割調整列の値を採用すること。
  assert.deepEqual(rows.map((r) => r.amount), [46.67, 66.67, 71.67]);
  const { streakYears, direction } = computeDividendStreak(rows);
  assert.equal(direction, 'up');
  assert.equal(streakYears, 2);
});

test('2列（中間列なし・期末/合計のみ）: 列数が少ない表でも合計列を正しく検出する', () => {
  const rows = parseDividendYenHistory(fixture('dividend_2col.html'));
  assert.deepEqual(rows.map((r) => r.amount), [45, 60]);
});

test('computeDividendStreak: 据え置き（同額）が挟まるとそこでstreakを打ち切る', () => {
  const history = [
    { period: '2022', amount: 100 },
    { period: '2023', amount: 110 },
    { period: '2024', amount: 110 }, // 据え置き
    { period: '2025', amount: 120 },
    { period: '2026', amount: 130 },
  ];
  const { streakYears, direction } = computeDividendStreak(history);
  assert.equal(direction, 'up');
  assert.equal(streakYears, 2); // 2024→2025→2026 の2回の変化ぶんだけ数える
});

test('computeDividendStreak: 1件以下なら判定不能', () => {
  assert.deepEqual(computeDividendStreak([{ period: '2026', amount: 100 }]), { streakYears: 0, direction: null });
  assert.deepEqual(computeDividendStreak([]), { streakYears: 0, direction: null });
});
