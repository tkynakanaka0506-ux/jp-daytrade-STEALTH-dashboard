// indicators.mjsの評価ロジックの回帰テスト。
//
// これらは全て「実測で見つかった具体的な矛盾」を再発防止のために固定した
// もの。新しい赤旗シグナルを追加するときは、同じ「worsen-only」パターン・
// 「checked」パターンに従っているかをここで確認できるようにしている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ambushVerdict, smartEntryVerdict, receivablesAnomalySignal, dividendYieldPeakSignal,
  overheatSignal, growthSurgeSignal, marginOverhangSignal, netNetSignal, lowPbrSignal,
  reboundPatternSignal, trendReversalPatternSignal, laggingPatternSignal, shortSqueezeSignal,
  pbrHistoricalLowSignal, hiddenGemSignal, hasConsensusProfit,
} from '../indicators.mjs';

test('ambushVerdict: 赤旗は悪化方向にしか動かさない（rank DはmarginOverhangがあっても見送りのまま）', () => {
  // 実測バグ: 3038/3415がrank Dで本来「見送り」のところ、marginOverhangの
  // 早期returnにより「様子見」に格上げされてしまっていた。
  const r = { rank: 'D', evidence: false, marginOverhang: { level: 'bad', note: 'x' } };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'avoid');
});

test('ambushVerdict: 急騰グロース(growthSurge)が立っていれば買い推奨にはならない', () => {
  // 実測バグ: AMBUSH側だけgrowthSurgeSignalを見ておらず、赤チップと
  // 「買い推奨」が同居する矛盾が起きていた。
  const r = { rank: 'S', evidence: true, market: '東証Ｇ', closes: [100, ...Array(20).fill(160)] };
  const v = ambushVerdict(r);
  assert.notEqual(v.level, 'buy');
});

test('ambushVerdict: スクイーズアウトによる上場廃止決定はランクに関係なく必ず見送り', () => {
  // 実測バグ: 3480ジェイ・エス・ビーがランクC・様子見のまま表示され、
  // 2026-08-10開示のスクイーズアウト決定が一切反映されていなかった。
  const r = {
    rank: 'S', evidence: true,
    warnings: [{ label: '上場廃止（スクイーズアウト）', title: '株式等売渡請求...', date: '2026-08-10' }],
  };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'avoid');
});

test('smartEntryVerdict: overheatはAMBUSHと同じく見送りまで落とす（様子見止まりではない）', () => {
  // 実測バグ: 同じ閾値(kairi>+15%)なのにAMBUSHは見送り、SMART ENTRYは
  // 様子見止まりという不整合があった。
  const r = { sig1: { level: 'good', note: 'x' } };
  const overheat = overheatSignal(20); // kairi=20% > OVERHEAT_KAIRI(15)
  const v = smartEntryVerdict(r, overheat, growthSurgeSignal(null, null));
  assert.equal(v.level, 'avoid');
});

test('receivablesAnomalySignal: bad/warn判定は必ずchecked:trueを持つ（「未確認」と混同しない）', () => {
  // 実測バグ: bad/warnの返り値だけchecked:trueが抜けており、UIが
  // 「確認済みで異常あり」と「未確認」を区別できていなかった。
  const bad = receivablesAnomalySignal({ revenueGrowthPct: 1.6, receivablesGrowthPct: 74.2 });
  assert.equal(bad.level, 'bad');
  assert.equal(bad.checked, true);

  const warn = receivablesAnomalySignal({ revenueGrowthPct: 10, receivablesGrowthPct: 16 });
  assert.equal(warn.level, 'warn');
  assert.equal(warn.checked, true);

  const clean = receivablesAnomalySignal({ revenueGrowthPct: 10, receivablesGrowthPct: 5 });
  assert.equal(clean.level, null);
  assert.equal(clean.checked, true);

  const unchecked = receivablesAnomalySignal({ revenueGrowthPct: null, receivablesGrowthPct: null });
  assert.equal(unchecked.level, null);
  assert.equal(unchecked.checked, false);
});

test('dividendYieldPeakSignal: 無配銘柄(maxYield=0)でNaNにならない', () => {
  // 実測バグ: 456Aのような無配銘柄でapproachPctがNaNになっていた。
  const r = dividendYieldPeakSignal({ currentYield: 0, maxYield: 0, maxPeriod: '2024年3月' });
  assert.equal(r.level, null);
  assert.equal(r.note, null);
});

test('marginOverhangSignal: 閾値未満はlevel:null（誤検出しない）', () => {
  assert.equal(marginOverhangSignal(9.9).level, null);
  assert.equal(marginOverhangSignal(10).level, 'bad');
});

test('lowPbrSignal: データが揃っていて割安でない場合もchecked:trueを持つ（「未確認」と混同しない）', () => {
  // 実測バグ: 350A等11銘柄でPBR・業種平均PBRのデータが完全に揃っている
  // のに checked flag が無く、buyRuleChecklistが「？（確認できず）」と
  // 表示していた。
  const notCheap = lowPbrSignal({ pbr: 3.2, sectorPbr: 0.85 });
  assert.equal(notCheap.level, null);
  assert.equal(notCheap.checked, true);

  const cheap = lowPbrSignal({ pbr: 0.5, sectorPbr: 1.0 });
  assert.equal(cheap.level, 'good');
  assert.equal(cheap.checked, true);

  const noData = lowPbrSignal({ pbr: null, sectorPbr: 1.0 });
  assert.equal(noData.checked, false);
});

test('netNetSignal: データが揃っていて解散価値割れでない場合もchecked:trueを持つ', () => {
  const notNetNet = netNetSignal({ cash: 100, totalAssets: 1000, equity: 300, marketCap: 5000, receivables: null });
  assert.equal(notNetNet.level, null);
  assert.equal(notNetNet.checked, true);

  const noData = netNetSignal({ cash: null, totalAssets: 1000, equity: 300, marketCap: 5000 });
  assert.equal(noData.checked, false);
});

test('composePattern: 既知の条件に1つでも不一致があれば、他が未取得でも「非該当」と確定できる（「N/A」と混同しない）', () => {
  // 実測バグ: 9052山陽電鉄のパターン③は信用残水準100%で明確に条件を
  // 満たさない(c1=false)のに、コンセンサス差が未取得(c2=null)という
  // だけで一律「N/A」表示になっていた。AND条件である以上、1つでも
  // 確定的に満たさない条件があれば、残りが未知でも「該当しない」と
  // 言い切ってよいはず。
  const r = laggingPatternSignal({ creditLevelPct: 100, estimateProfit: null, consensusProfit: null, kairi: 2 });
  assert.equal(r.label, '非該当');
  assert.equal(r.level, null);
});

test('composePattern: 既知の条件が全てtrueで一部未取得なら「一部該当（データ不足）」', () => {
  const r = laggingPatternSignal({ creditLevelPct: 10, estimateProfit: null, consensusProfit: null, kairi: 2 });
  assert.equal(r.label, '一部該当（データ不足）');
  assert.equal(r.level, 'partial');
});

test('composePattern: 条件が1つも判定できなければ「N/A」', () => {
  const r = laggingPatternSignal({ creditLevelPct: null, estimateProfit: null, consensusProfit: null, kairi: null });
  assert.equal(r.label, 'N/A');
});

test('composePattern: 全条件既知かつ全てtrueなら「該当」', () => {
  const r = reboundPatternSignal({ kairi: -12, rsi: 25, creditTrendPct: -5 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '該当');
});

test('composePattern: 全条件既知で一部false（未知は無し）なら「非該当」', () => {
  const r = trendReversalPatternSignal({ cross: { crossed: false }, volRatio: 2, loanRatio: 1 });
  assert.equal(r.label, '非該当');
});

test('shortSqueezeSignal: 該当しない場合もchecked:trueを持つ（「未確認」と混同しない）', () => {
  // 実測バグ: shortSqueezeSignalにchecked flagが無く、buyRuleChecklist
  // の需給行のOR条件が「marginOverhangが確定的にbadなら、squeezeの
  // 状態を見ずに一律false確定」という誤った3値OR論理になっていた
  // （squeezeが単に未取得なだけの場合でも需給✗と誤表示）。
  const weekly = [
    { buy: 100, sell: 50 }, { buy: 100, sell: 50 }, { buy: 100, sell: 50 },
    { buy: 100, sell: 50 }, { buy: 100, sell: 50 },
  ]; // 変化なし＝踏み上げ条件（買い残減少・売り残増加）を満たさない
  const notSqueeze = shortSqueezeSignal(weekly);
  assert.equal(notSqueeze.level, null);
  assert.equal(notSqueeze.checked, true);

  const noData = shortSqueezeSignal(null);
  assert.equal(noData.checked, false);

  const squeeze = shortSqueezeSignal([
    { buy: 80, sell: 80 }, { buy: 90, sell: 70 }, { buy: 95, sell: 65 },
    { buy: 98, sell: 60 }, { buy: 100, sell: 50 },
  ]);
  assert.equal(squeeze.level, 'good');
  assert.equal(squeeze.checked, true);
});

test('pbrHistoricalLowSignal: 過去最低PBRちょうどならgood（歴史的最低水準）', () => {
  const r = pbrHistoricalLowSignal({ currentPbr: 0.62, minPbr: 0.62, minPeriod: '2014年10月' });
  assert.equal(r.level, 'good');
  assert.equal(r.label, 'PBR歴史的最低水準');
  assert.equal(r.checked, true);
});

test('pbrHistoricalLowSignal: 過去最低の90%以上まで接近していればgood（歴史的低水準）', () => {
  const r = pbrHistoricalLowSignal({ currentPbr: 0.65, minPbr: 0.62, minPeriod: '2014年10月' });
  assert.equal(r.level, 'good');
  assert.equal(r.label, 'PBR歴史的低水準');
  assert.equal(r.checked, true);
});

test('pbrHistoricalLowSignal: 過去最低からまだ遠ければlevel:nullだがchecked:true（未確認と混同しない）', () => {
  // netNetSignal/lowPbrSignalと同じchecked flagパターン。buyRuleChecklistの
  // 「下値」行がnetNet/lowPbrと同じOR条件にこの信号も組み込むため、
  // 「データ不足で未確認」と「確認済みで下値の裏付けにならない」を区別する。
  const r = pbrHistoricalLowSignal({ currentPbr: 1.05, minPbr: 0.62, minPeriod: '2014年10月' });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('pbrHistoricalLowSignal: データ不足ならlevel:null・checked:false（0除算でNaNにしない）', () => {
  assert.equal(pbrHistoricalLowSignal({ currentPbr: null, minPbr: 0.62 }).level, null);
  assert.equal(pbrHistoricalLowSignal({ currentPbr: null, minPbr: 0.62 }).checked, false);
  assert.equal(pbrHistoricalLowSignal({ currentPbr: 0, minPbr: 0.62 }).checked, false);
});

test('hiddenGemSignal: コンセンサス無し＋解散価値割れ＋増配中ならgood（お宝候補）', () => {
  const r = hiddenGemSignal({
    consensusProfit: null,
    netNet: { level: 'good' },
    lowPbr: { level: null },
    dividendStreakYears: 2,
    dividendStreakDirection: 'up',
  });
  assert.equal(r.level, 'good');
  assert.equal(r.label, 'お宝候補');
});

test('hiddenGemSignal: コンセンサスがある銘柄では発火しない（この信号の前提そのものが崩れるため）', () => {
  const r = hiddenGemSignal({
    consensusProfit: 500,
    netNet: { level: 'good' },
    lowPbr: { level: null },
    dividendStreakYears: 3,
    dividendStreakDirection: 'up',
  });
  assert.equal(r.level, null);
});

test('hiddenGemSignal: 財務健全性（解散価値割れ or 割安PBR）が無ければ増配だけでは発火しない', () => {
  const r = hiddenGemSignal({
    consensusProfit: null,
    netNet: { level: null },
    lowPbr: { level: 'warn' }, // '業種平均並み'であって'割安'ではない
    dividendStreakYears: 3,
    dividendStreakDirection: 'up',
  });
  assert.equal(r.level, null);
});

test('hiddenGemSignal: 増配トレンドが無ければ財務健全でも発火しない', () => {
  const down = hiddenGemSignal({
    consensusProfit: null, netNet: { level: 'good' }, lowPbr: { level: null },
    dividendStreakYears: 3, dividendStreakDirection: 'down',
  });
  assert.equal(down.level, null);
  const none = hiddenGemSignal({
    consensusProfit: null, netNet: { level: 'good' }, lowPbr: { level: null },
    dividendStreakYears: 0, dividendStreakDirection: null,
  });
  assert.equal(none.level, null);
});

test('hasConsensusProfit: consensusProfit===0は「未算出」であって「予想利益0円」ではないためfalse扱い', () => {
  // 再発防止: この非自明なルール（0は有効値ではない）が、かつて
  // indicators.mjs/scraper.mjsの計5箇所に独立にコピーされていた。
  // 単一の情報源(hasConsensusProfit)に統一したので、ここでルール自体を
  // 固定しておく。
  assert.equal(hasConsensusProfit(0), false);
  assert.equal(hasConsensusProfit(null), false);
  assert.equal(hasConsensusProfit(undefined), false);
  assert.equal(hasConsensusProfit(NaN), false);
  assert.equal(hasConsensusProfit(500), true);
  assert.equal(hasConsensusProfit(-500), true); // 赤字予想も「有効なコンセンサス」として扱う
});
