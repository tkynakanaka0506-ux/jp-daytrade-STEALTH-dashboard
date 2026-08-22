// karauri.mjs（空売りネット・機関投資家の空売り残高）の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseInstitutionalShortInterest } from '../karauri.mjs';
import { institutionalShortSignal } from '../indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sampleHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'karauri_sample.html'), 'utf-8');

test('parseInstitutionalShortInterest: 報告義務消失した機関は現在の合計から除外する', () => {
  const r = parseInstitutionalShortInterest(sampleHtml);
  // 機関A(0.79%)+機関B(0.80%)=1.59%。機関C(0.02%)は報告義務消失なので含めない。
  assert.equal(r.totalPct, 1.59);
  assert.equal(r.checked, true);
});

test('parseInstitutionalShortInterest: 計算日セルが<a>タグで囲まれていても日付を正しく抽出する', () => {
  // 実測: 7921は計算日が素のテキスト、3038はリンク付き。どちらの銘柄
  // でもパースが失敗しないことを固定する（実際に3038でパース時に
  // "Invalid time value"エラーが発生したバグの再発防止）。
  const r = parseInstitutionalShortInterest(sampleHtml);
  assert.equal(r.asOfDate, '2026-08-14');
});

test('parseInstitutionalShortInterest: 90日前との差分(changePct)を正しく計算する', () => {
  const r = parseInstitutionalShortInterest(sampleHtml, 90);
  // 機関Aは90日前時点では1.20%（2026-05-01時点の開示）。機関Bは90日前
  // にはまだ開示が無かった（2026-07-03が最初の開示）ので含めない。
  // pastPct=1.20、totalPct=1.59 → changePct=+0.39
  assert.equal(r.changePct, 0.39);
});

test('parseInstitutionalShortInterest: テーブル自体が無ければchecked:false', () => {
  const r = parseInstitutionalShortInterest('<html><body>no data</body></html>');
  assert.equal(r.checked, false);
  assert.equal(r.totalPct, null);
});

test('institutionalShortSignal: 残高が意味のある水準かつ縮小中ならgood', () => {
  const r = institutionalShortSignal({ totalPct: 1.59, changePct: -0.39, checked: true });
  assert.equal(r.level, 'good');
});

test('institutionalShortSignal: 残高が増加中ならgoodにしない', () => {
  const r = institutionalShortSignal({ totalPct: 1.59, changePct: 0.39, checked: true });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('institutionalShortSignal: 未確認（checked:false）はlevel:nullかつchecked:false', () => {
  const r = institutionalShortSignal({ totalPct: null, changePct: null, checked: false });
  assert.equal(r.level, null);
  assert.equal(r.checked, false);
});
