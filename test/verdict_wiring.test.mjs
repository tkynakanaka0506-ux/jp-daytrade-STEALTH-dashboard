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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ambushVerdict, smartEntryVerdict, CHIP_SIGNAL_FIELDS, badChipSignals } from '../indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

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

test('indicators.mjsのexport function ...Signal は全てscreener.mjs/smart_entry.mjs/scraper.mjs/us_screener.mjs/us_tenbagger.mjsのいずれかから呼び出されている（デッドコード化の再発防止）', () => {
  // 実測バグ: consensusTrapSignal（期待値のワナ）がWATCHLIST時代の
  // エントリー健康診断カードで使われていたが、SMART ENTRY化（旧コミット
  // dec2509）で呼び出し側だけ削除され、関数定義だけが長期間デッドコード
  // 化していた（テストも0件で誰も気付けなかった）。valueSignal・
  // creditSignalも同じ経緯で同時に取り残されていた（削除済み）。
  // 「シグナルを定義したのに呼び出す側の配線を忘れる／消してしまう」を
  // 機械的に検出できるよう、indicators.mjsのソースから
  // `export function ...Signal(` を全て抽出し、screener.mjs・
  // smart_entry.mjs・scraper.mjs（overheat/growthSurgeはカード描画時に
  // scraper.mjs側で直接呼ばれるためこれも含める）のいずれかで
  // `関数名(`の形で呼ばれているか確認する。
  const indicatorsSrc = fs.readFileSync(path.join(root, 'indicators.mjs'), 'utf-8');
  const callSites = fs.readFileSync(path.join(root, 'screener.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'smart_entry.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'scraper.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'us_screener.mjs'), 'utf-8')
    + fs.readFileSync(path.join(root, 'us_tenbagger.mjs'), 'utf-8');

  const names = [...indicatorsSrc.matchAll(/^export function ([a-zA-Z0-9]+Signal)\(/gm)].map((m) => m[1]);
  assert.ok(names.length > 20, `抽出できたSignal関数が${names.length}件しかありません（正規表現が壊れている疑い）`);

  const orphaned = names.filter((name) => !callSites.includes(`${name}(`));
  assert.deepEqual(
    orphaned, [],
    `screener.mjs/smart_entry.mjs/scraper.mjs/us_screener.mjs/us_tenbagger.mjsのどれからも呼ばれていないSignal関数があります（デッドコード化の疑い）: ${orphaned.join(', ')}`
  );
});
