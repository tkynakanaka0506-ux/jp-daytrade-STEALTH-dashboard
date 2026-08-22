// verdict配線の構造的な網羅性テスト。
//
// このセッションで実際に起きたバグは「カードに赤チップとして表示している
// のに、verdict（買い推奨/様子見/見送り）側にその判定を追加し忘れる」
// パターンだった（growthSurgeSignal・上場廃止のスクイーズアウト）。
// 個別のバグを1つずつ回帰テストにするだけでは、次に別の新しいシグナルで
// 同じ配線忘れが起きても検出できない。
//
// このテストはCHIP_SIGNAL_FIELDS（bottomChipsが表示する全シグナルの
// 一覧）を列挙し、その1つ1つを機械的に「bad」状態にした入力を作って、
// ambushVerdict/smartEntryVerdictが必ず「買い推奨」から離脱することを
// 確認する。CHIP_SIGNAL_FIELDSに新しいシグナルを追加すれば、この
// テストが自動的にそのシグナルの配線も検証してくれる（何もしなくて
// いい＝これが「構造的な再発防止」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ambushVerdict, smartEntryVerdict, CHIP_SIGNAL_FIELDS, badChipSignals } from '../indicators.mjs';

test('CHIP_SIGNAL_FIELDSの各シグナルは badChipSignals() で拾える', () => {
  for (const key of CHIP_SIGNAL_FIELDS) {
    const r = { [key]: { level: 'bad', note: `${key} bad` } };
    const found = badChipSignals(r);
    assert.equal(found.length, 1, `${key} が badChipSignals() で拾えていません`);
  }
});

test('CHIP_SIGNAL_FIELDSの各シグナルは、単独でbadになるとambushVerdictを買い推奨から離脱させる', () => {
  for (const key of CHIP_SIGNAL_FIELDS) {
    const r = { rank: 'S', evidence: true, catalysts: [{ label: 'テスト好材料' }], [key]: { level: 'bad', note: `${key} bad` } };
    const v = ambushVerdict(r);
    assert.notEqual(v.level, 'buy', `${key}がbadなのにambushVerdictが買い推奨のままです（チップ表示とverdict計算の配線忘れの疑い）`);
  }
});

test('CHIP_SIGNAL_FIELDSの各シグナルは、単独でbadになるとsmartEntryVerdictを買い推奨から離脱させる', () => {
  for (const key of CHIP_SIGNAL_FIELDS) {
    const r = { sig1: { level: 'good', note: 'テスト該当' }, [key]: { level: 'bad', note: `${key} bad` } };
    const v = smartEntryVerdict(r, { level: null }, { level: null });
    assert.notEqual(v.level, 'buy', `${key}がbadなのにsmartEntryVerdictが買い推奨のままです（チップ表示とverdict計算の配線忘れの疑い）`);
  }
});

test('overheat・growthSurge・上場廃止（CHIP_SIGNAL_FIELDS外の特殊ケース）も個別に配線されている', () => {
  // これらはr.kairi/r.market/r.closes/r.warningsから計算するためリストに
  // 含めていない。リストに乗らない分、書き忘れのリスクが高いので個別に
  // 固定しておく。
  assert.equal(
    ambushVerdict({ rank: 'S', evidence: true, catalysts: [], kairi: 20 }).level, 'avoid',
    'overheat(kairi>+15%)がambushVerdictで見送りに落ちていません'
  );
  assert.notEqual(
    ambushVerdict({ rank: 'S', evidence: true, catalysts: [], market: '東証Ｇ', closes: [100, ...Array(20).fill(160)] }).level, 'buy',
    'growthSurgeがambushVerdictで買い推奨のままです'
  );
  assert.equal(
    ambushVerdict({ rank: 'S', evidence: true, catalysts: [], warnings: [{ label: '上場廃止（スクイーズアウト）' }] }).level, 'avoid',
    '上場廃止がambushVerdictで見送りに落ちていません'
  );
});
