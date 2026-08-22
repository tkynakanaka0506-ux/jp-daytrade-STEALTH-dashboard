// 「新しい裏付けシグナルを追加したのに、表示だけでランキング(conviction)
// に反映し忘れる」バグの再発防止テスト。
//
// 実測バグ: netNet/lowPbr/divFloor/squeeze/sectorRotation/dividendPeakの
// 6シグナルをAMBUSHカードに追加した際、全て表示だけの飾りチップになって
// おり、ambushConvictionが存在しなかったため実際の並び順に一切影響して
// いなかった（ユーザー要求「最終的な銘柄分析・ランキング・買い判断に
// 利用できるようにする」に反していた）。増配streakも同様に表示のみで
// ランキング未反映だった時期がある。
//
// このテストは「各裏付けシグナルがgoodのとき、素点と比べてconvictionが
// 必ず上がる」ことを機械的に確認する。新しいシグナルをボーナス対象に
// 追加したら、ここにも1行足すことで同じ抜けを防げる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambushConviction } from '../screener.mjs';
import { smartEntryConviction } from '../smart_entry.mjs';

const AMBUSH_BONUS_FIELDS = ['netNet', 'lowPbr', 'divFloor', 'squeeze', 'sectorRotation', 'dividendPeak'];

test('ambushConviction: 各裏付けシグナルがgoodならconvictionが素点より上がる', () => {
  const base = { score: 50 };
  for (const key of AMBUSH_BONUS_FIELDS) {
    const withSignal = { ...base, [key]: { level: 'good', note: 'test' } };
    assert.ok(
      ambushConviction(withSignal) > ambushConviction(base),
      `${key}がgoodでもambushConvictionが上がりません（ランキングへの配線忘れの疑い）`
    );
  }
});

test('ambushConviction: 3期以上の連続増配(up)はconvictionを押し上げる', () => {
  const base = { score: 50 };
  const withStreak = { score: 50, dividendStreakYears: 3, dividendStreakDirection: 'up' };
  assert.ok(ambushConviction(withStreak) > ambushConviction(base));
});

test('ambushConviction: 2期以下の増配streakはボーナス対象にしない（閾値未満）', () => {
  const base = { score: 50 };
  const short = { score: 50, dividendStreakYears: 2, dividendStreakDirection: 'up' };
  assert.equal(ambushConviction(short), ambushConviction(base));
});

const SMART_ENTRY_BONUS_FIELDS = ['climax', 'netNet', 'lowPbr', 'divFloor', 'squeeze', 'sectorRotation', 'sectorLag'];

test('smartEntryConviction: 各裏付けシグナルがgoodならconvictionが上がる', () => {
  const base = { matched: 1 };
  for (const key of SMART_ENTRY_BONUS_FIELDS) {
    const withSignal = { ...base, [key]: { level: 'good', note: 'test' } };
    assert.ok(
      smartEntryConviction(withSignal) > smartEntryConviction(base),
      `${key}がgoodでもsmartEntryConvictionが上がりません（ランキングへの配線忘れの疑い）`
    );
  }
});

test('smartEntryConviction: 警告(bad)は減点する', () => {
  const base = { matched: 1 };
  const withWarn = { matched: 1, marginOverhang: { level: 'bad', note: 'test' } };
  assert.ok(smartEntryConviction(withWarn) < smartEntryConviction(base));
});
