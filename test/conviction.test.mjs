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
// 必ず上がる」ことを機械的に確認する。
//
// 以前はこのテスト自身がAMBUSH_BONUS_FIELDS/SMART_ENTRY_BONUS_FIELDSを
// 独自にハードコードしており、ambushConviction/smartEntryConviction側で
// 加点対象を追加してもこのテストの更新を忘れると「テストは通るが
// 実際には配線されていない新シグナル」を検知できなかった（実測: この
// テストが存在するにもかかわらずpbrHistoricalLow/hiddenGemの配線忘れが
// 一度発生した）。screener.mjs/smart_entry.mjsが実際に使っている配列を
// そのままimportすることで、単一の情報源にして構造的にこの抜けを防ぐ。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambushConviction, AMBUSH_BONUS_FIELDS, AMBUSH_PENALTY_FIELDS } from '../screener.mjs';
import { smartEntryConviction, SMART_ENTRY_BONUS_FIELDS, SMART_ENTRY_PENALTY_FIELDS } from '../smart_entry.mjs';

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

test('smartEntryConviction: 各警告シグナルがbadならconvictionが下がる', () => {
  const base = { matched: 1 };
  for (const key of SMART_ENTRY_PENALTY_FIELDS) {
    const withWarn = { ...base, [key]: { level: 'bad', note: 'test' } };
    assert.ok(
      smartEntryConviction(withWarn) < smartEntryConviction(base),
      `${key}がbadでもsmartEntryConvictionが下がりません（減点への配線忘れの疑い）`
    );
  }
});

// ambushConvictionには元々「加点」しか無く、retailExpectationSignal
// （個人投資家の期待織り込み。ユーザー要望で「重要な減点要素」として
// 追加）で初めて減点の仕組みが入った。AMBUSH_BONUS_FIELDSと同じ単一の
// 情報源パターンで、この配列に何を足しても自動的にテストされる。
test('ambushConviction: 各警告シグナルがbadならconvictionが素点より下がる', () => {
  const base = { score: 50 };
  for (const key of AMBUSH_PENALTY_FIELDS) {
    const withWarn = { ...base, [key]: { level: 'bad', note: 'test' } };
    assert.ok(
      ambushConviction(withWarn) < ambushConviction(base),
      `${key}がbadでもambushConvictionが下がりません（減点への配線忘れの疑い）`
    );
  }
});

test('ambushConviction: 各警告シグナルがwarnでもconvictionが素点より下がる（bad未満の軽い減点）', () => {
  const base = { score: 50 };
  for (const key of AMBUSH_PENALTY_FIELDS) {
    const withCaution = { ...base, [key]: { level: 'warn', note: 'test' } };
    assert.ok(
      ambushConviction(withCaution) < ambushConviction(base),
      `${key}がwarnでもambushConvictionが下がりません`
    );
    assert.ok(
      ambushConviction(withCaution) > ambushConviction({ ...base, [key]: { level: 'bad', note: 'test' } }),
      `${key}のwarnはbadより減点が軽いはずです`
    );
  }
});

// v7.4改修（ユーザーの実銘柄分析）: smartEntryConvictionが該当パターン数×
// 100＋チップ加点の粗い整数バケット構成だけだったため、実データで検証
// したところ松屋(PER224・PBR4.3)を含む7銘柄が全く同じconviction=145で
// 並んでいた。タイブレークが乖離率だけなので、割安度がまるで違う銘柄が
// 同格になり、PER224倍の銘柄がPER17.2倍の銘柄より上位に来る逆転が
// 起きていた。業種平均PER/PBRとの比較（valuationQualityScore）を加点に
// 追加したので、この2銘柄は同点にならないはずである。
test('smartEntryConviction: 業種平均PER/PBRとの比較が加点に反映されている（実測: 松屋PER224/PBR4.3と4℃HD PER17.2/PBR1.14が同点145点で並んでいた問題の再発防止）', () => {
  const matsuya = { matched: 1, sig3: { level: 'good' }, squeeze: { level: 'good' }, institutionalShort: { level: 'good' }, climax: { level: 'good' }, per: 224, sectorPer: 32.2, pbr: 4.3, sectorPbr: 2.35 };
  const yondoshi = { matched: 1, sig3: { level: 'good' }, squeeze: { level: 'good' }, lowPbr: { level: 'good' }, divFloor: { level: 'good' }, per: 17.2, sectorPer: 32.2, pbr: 1.14, sectorPbr: 2.35 };
  assert.ok(
    smartEntryConviction(yondoshi) > smartEntryConviction(matsuya),
    `割安な4℃HD相当(${smartEntryConviction(yondoshi)})が割高な松屋相当(${smartEntryConviction(matsuya)})を上回っていません`
  );
});
