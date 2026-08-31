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
  pbrHistoricalLowSignal, hiddenGemSignal, hasConsensusProfit, retailExpectationSignal, priceLevelVsRange,
  progressStreakSignal, dividendPotentialSignal, hiddenAssetSignal, creditFloatSignal, consensusTrapSignal,
  usEarningsTrendSignal, tenbaggerSignal, midCapGrowthSignal, repricingLagScore,
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

test('netNetSignal: cash/totalAssets/equity(円)とmarketCap(百万円)の単位を揃えて計算する（実測の重大バグの再発防止）', () => {
  // 実測バグ: cash等はEDINET由来で単位が「円」、marketCapはkabutan由来で
  // 単位が「百万円」。単位を揃えずに割ると比率が約100万倍に水増しされ、
  // 実際にはネットネットでない銘柄まで「解散価値割れ」と誤判定していた
  // （実測: 6336等でnoteが「時価総額の7804104.5%」のような明らかに
  // 異常な値になっていた）。
  //
  // 現預金3,000,000,000円・総資産10,000,000,000円・自己資本8,000,000,000円
  // → 負債2,000,000,000円 → 純資産(簡易)1,000,000,000円。
  // marketCap=5,000（百万円）＝時価総額50億円。
  // 正しい比率 = 10億円 / 50億円 = 20%（単位を揃えなければ 10億/5,000
  // ＝200,000倍という明らかに異常な比率になっていたはずの銘柄）。
  const r = netNetSignal({ cash: 3_000_000_000, totalAssets: 10_000_000_000, equity: 8_000_000_000, marketCap: 5000, receivables: null });
  assert.equal(r.level, null); // 20% < 70%（warn閾値）なので該当なし
  assert.equal(r.checked, true);

  // 逆に、正しい単位換算をした上で本当にネットネットな銘柄はgoodになる
  // ことも確認する（現預金6,000,000,000円・負債2,000,000,000円
  // → 純資産4,000,000,000円 ＝ 時価総額30億円(marketCap=3000)の133%）。
  const genuine = netNetSignal({ cash: 6_000_000_000, totalAssets: 10_000_000_000, equity: 8_000_000_000, marketCap: 3000, receivables: null });
  assert.equal(genuine.level, 'good');
  assert.match(genuine.note, /133(\.\d+)?%/);
  assert.doesNotMatch(genuine.note, /\d{5,}%/); // 明らかに桁が異常な比率（5桁%以上）になっていないこと
});

test('composePattern: 既知の条件に1つでも不一致があれば、他が未取得でも「非該当」と確定できる（「N/A」と混同しない）', () => {
  // 実測バグ: 9052山陽電鉄のパターン③は信用残水準100%で明確に条件を
  // 満たさない(c1=false)のに、コンセンサス差が未取得(c2=null)という
  // だけで一律「N/A」表示になっていた。AND条件である以上、1つでも
  // 確定的に満たさない条件があれば、残りが未知でも「該当しない」と
  // 言い切ってよいはず。
  const r = laggingPatternSignal({ creditLevelPct: 100, estimateProfit: null, consensusProfit: null, kairi: 2 });
  assert.equal(r.label, '非該当');
  // 「非該当」（確定的な不一致）と「N/A」（総不明）は、以前どちらも
  // level:nullで同じ⚪灰色表示になり、scraper.mjsのsignalRowの🔴（red）
  // が定義はあっても一切到達できないデッドコードになっていた（実測:
  // ユーザーから「信号の赤色が機能していない」との指摘）。level:'none'
  // で区別し、🔴に対応させる。
  assert.equal(r.level, 'none');
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
  assert.equal(r.level, 'none');
});

test('composePattern: 「非該当」(none)と「N/A」(null)はlevelが異なる（signalRowの🔴と⚪を区別するため）', () => {
  const none = laggingPatternSignal({ creditLevelPct: 100, estimateProfit: null, consensusProfit: null, kairi: 2 });
  const na = laggingPatternSignal({ creditLevelPct: null, estimateProfit: null, consensusProfit: null, kairi: null });
  assert.equal(none.level, 'none');
  assert.equal(na.level, null);
  assert.notEqual(none.level, na.level);
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

test('priceLevelVsRange: 直近期間の終値レンジの中で現在値が最高値なら100%', () => {
  // closesは古い→新しい順（weeklyの新しい→古い順とは逆）。
  const closes = Array.from({ length: 60 }, (_, i) => 1900 + i); // 単調増加、最新が最大
  assert.equal(priceLevelVsRange(closes, 60), 100);
});

test('priceLevelVsRange: データ不足（period未満）ならnull', () => {
  assert.equal(priceLevelVsRange(Array.from({ length: 59 }, (_, i) => 1900 + i), 60), null);
});

test('retailExpectationSignal: 株価急騰＋信用買い残急増＋高値圏 → 期待先行・織り込み大', () => {
  // ユーザー指定ケース1: 株価↑＋信用買い↑↑ → 織り込み大
  const r = retailExpectationSignal({
    return1w: 5, return1m: 20, priceLevelPct: 90, volRatio: 1.2,
    creditTrendPct: 30, creditWeek1Pct: 10, daysToEarnings: null,
  });
  assert.equal(r.level, 'bad');
  assert.equal(r.label, '期待先行・織り込み大');
  assert.match(r.note, /材料出尽くし/);
  assert.match(r.note, /高値圏での急騰/);
});

test('retailExpectationSignal: 決算直前＋急騰＋信用買い残急増 → 強い警戒（決算直前が理由と分かる）', () => {
  // ユーザー指定ケース4
  const r = retailExpectationSignal({
    return1w: 8, return1m: 18, priceLevelPct: null, volRatio: null,
    creditTrendPct: 25, creditWeek1Pct: 12, daysToEarnings: 5,
  });
  assert.equal(r.level, 'bad');
  assert.match(r.note, /決算直前の急騰/);
});

test('retailExpectationSignal: 株価上昇だが信用買い残は横ばい → 織り込みの兆し止まり（織り込み大にはしない）', () => {
  // ユーザー指定ケース2: 株価↑＋信用買い横ばい → 織り込み小〜中
  const r = retailExpectationSignal({
    return1w: 3, return1m: 10, priceLevelPct: 50, volRatio: 1.1,
    creditTrendPct: 2, creditWeek1Pct: 0, daysToEarnings: 30,
  });
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '期待織り込みの兆し');
});

test('retailExpectationSignal: 株価低迷＋信用買い残も動きなし → 未織り込み（level:nullだがchecked:true）', () => {
  // ユーザー指定ケース3: 株価低迷＋先行材料強い → 未織り込み
  // （先行材料の有無はこのシグナルの入力ではなく、AMBUSH側の別軸(evidence)で
  // 別途評価される。ここでは株価・信用買い残ともに動きが無いことだけを見る）。
  const r = retailExpectationSignal({
    return1w: 0, return1m: 1, priceLevelPct: 30, volRatio: 0.9,
    creditTrendPct: 0, creditWeek1Pct: 0, daysToEarnings: 40,
  });
  assert.equal(r.level, null);
  assert.equal(r.label, '未織り込み');
  assert.equal(r.checked, true);
});

test('retailExpectationSignal: 株価急騰でも信用買い残が伴わない（大口・機関投資家主導の疑い）は「織り込み大」にしない', () => {
  // ユーザー指定ケース5: 大口買い推定＋信用買い残横ばい → 個人投資家の
  // 織り込みとは別扱い（＝最も重いbad/期待先行の判定にはしない）。
  const r = retailExpectationSignal({
    return1w: 12, return1m: 25, priceLevelPct: 95, volRatio: 3,
    creditTrendPct: 1, creditWeek1Pct: 0, daysToEarnings: 5,
  });
  assert.notEqual(r.level, 'bad');
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '期待織り込みの兆し');
  assert.match(r.note, /機関投資家主導/);
});

test('retailExpectationSignal: 株価・信用買い残とも判定材料が無ければchecked:false', () => {
  const r = retailExpectationSignal({});
  assert.equal(r.level, null);
  assert.equal(r.checked, false);
});

test('retailExpectationSignal: 「期待織り込みあり」(warn)は組み合わせが揃うが強い織り込みの条件までは満たさない場合', () => {
  const r = retailExpectationSignal({
    return1w: 4, return1m: 8, priceLevelPct: 50, volRatio: 1.2,
    creditTrendPct: 10, creditWeek1Pct: 3, daysToEarnings: 30,
  });
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '期待織り込みあり');
});

test('ambushVerdict: retailExpectationがwarnなら「買い推奨」を維持しつつ理由に織り込みの兆しを補足する', () => {
  // ユーザー要望: 「買い推奨や様子見のところに個人投資家の期待が
  // 織り込まれつつある、といった結論の説明が欲しい」。warn段階は
  // 単独では買い推奨を覆さない（bad段階のみbadChipSignals経由で
  // 見送り/様子見に格下げされる）が、理由文には必ず反映する。
  const r = {
    rank: 'S', evidence: true, catalysts: [{ label: '上方修正' }],
    retailExpectation: { level: 'warn', label: '期待織り込みの兆し', note: 'x' },
  };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'buy');
  assert.match(v.reason, /期待織り込みの兆し/);
  assert.match(v.reason, /織り込まれつつある/);
});

test('ambushVerdict: retailExpectationが他の赤旗で様子見に格下げされた後も、warnの補足が消えずに残る', () => {
  // worsen()はreasonを丸ごと上書きするため、途中で他の赤旗
  // （marginOverhang等）がworsen()を呼んだ後に追記しないと消えて
  // しまう再発防止。
  const r = {
    rank: 'S', evidence: true, catalysts: [{ label: '上方修正' }],
    marginOverhang: { level: 'bad', note: '信用過多です' },
    retailExpectation: { level: 'warn', label: '期待織り込みの兆し', note: 'x' },
  };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'hold');
  assert.match(v.reason, /信用過多です/);
  assert.match(v.reason, /期待織り込みの兆し/);
});

test('ambushVerdict: retailExpectationが無い/nullなら理由文は変わらない', () => {
  const r = { rank: 'S', evidence: true, catalysts: [{ label: '上方修正' }] };
  const v = ambushVerdict(r);
  assert.doesNotMatch(v.reason, /織り込まれつつある/);
});

test('ambushVerdict: retailExpectationがbadなら（warn補足ではなく）badChipSignals経由の詳細な理由がそのまま出る', () => {
  const r = {
    rank: 'S', evidence: true, catalysts: [{ label: '上方修正' }],
    retailExpectation: { level: 'bad', note: '株価急騰と信用買い残急増が重なった高値圏での急騰で、材料出尽くしのリスクが高い状態です' },
  };
  const v = ambushVerdict(r);
  assert.equal(v.level, 'hold');
  assert.match(v.reason, /材料出尽くし/);
});

test('smartEntryVerdict: retailExpectationがwarnなら「買い推奨」を維持しつつ理由に織り込みの兆しを補足する', () => {
  const r = {
    sig2: { level: 'good', note: 'トレンド転換の初動です' },
    retailExpectation: { level: 'warn', label: '期待織り込みの兆し', note: 'x' },
  };
  const v = smartEntryVerdict(r, { level: null }, { level: null });
  assert.equal(v.level, 'buy');
  assert.match(v.reason, /トレンド転換の初動です/);
  assert.match(v.reason, /期待織り込みの兆し/);
});

test('ambushVerdict/smartEntryVerdict: retailExpectationのwarn補足文言は共通の1箇所から来ており、2つのverdict関数間で食い違わない', () => {
  // 再発防止: 以前はこの文言をambushVerdict/smartEntryVerdictの2箇所に
  // 個別に書いており、将来どちらか一方だけ文言を直すと食い違う抜けが
  // 起きうる状態だった。appendRetailExpectationCautionに一本化した後も
  // この一致が保たれることを固定する。
  const retailExpectation = { level: 'warn', label: '期待織り込みの兆し', note: 'x' };
  const ambush = ambushVerdict({ rank: 'S', evidence: true, catalysts: [{ label: 'テスト' }], retailExpectation });
  const smart = smartEntryVerdict({ sig1: { level: 'good', note: 'テスト該当' }, retailExpectation }, { level: null }, { level: null });
  const clause = '期待織り込みの兆し：株価や信用買い残の動きから、好材料への期待の一部が既に株価に織り込まれつつある可能性があります';
  assert.match(ambush.reason, new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(smart.reason, new RegExp(clause.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('progressStreakSignal: 同時期の進捗率が2年連続で上昇していればgood（実測: 6336石井表記のパターン）', () => {
  const history = [
    { period: '24.02-04', progress: 19.8, label: '対上期進捗率' },
    { period: '25.02-04', progress: 37.2, label: '対上期進捗率' },
    { period: '26.02-04', progress: 91.7, label: '対上期進捗率' },
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, 'good');
  assert.equal(r.label, '進捗率が加速中');
  assert.match(r.note, /2年連続/);
  assert.match(r.note, /91.7%/);
});

test('progressStreakSignal: 経常益(profit)が同時に取得できていれば前年同期比の利益成長率をnoteに添える（実測: 6336石井表記の経常益100→194→376）', () => {
  const history = [
    { period: '24.02-04', progress: 19.8, label: '対上期進捗率', profit: 100 },
    { period: '25.02-04', progress: 37.2, label: '対上期進捗率', profit: 194 },
    { period: '26.02-04', progress: 91.7, label: '対上期進捗率', profit: 376 },
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, 'good');
  assert.equal(r.profitYoyPct, 93.8);
  assert.match(r.note, /経常利益は前年同期比\+93\.8%/);
});

test('progressStreakSignal: profitが取得できていなければYoY成長率は添えない（従来通りのnoteのまま）', () => {
  const history = [
    { period: '24.02-04', progress: 19.8, label: '対上期進捗率' },
    { period: '25.02-04', progress: 37.2, label: '対上期進捗率' },
    { period: '26.02-04', progress: 91.7, label: '対上期進捗率' },
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.profitYoyPct, null);
  assert.doesNotMatch(r.note, /前年同期比/);
});

test('progressStreakSignal: 前年(prev)の経常益が赤字(0以下)なら%が定義できないためprofitYoyPctはnull', () => {
  const history = [
    { period: '24.02-04', progress: 10, label: '対上期進捗率', profit: -80 },
    { period: '25.02-04', progress: 19.8, label: '対上期進捗率', profit: -50 }, // prev=赤字
    { period: '26.02-04', progress: 37.2, label: '対上期進捗率', profit: 100 }, // latest=黒字転換
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, 'good');
  assert.equal(r.profitYoyPct, null);
});

test('progressStreakSignal: 進捗率は加速していても経常利益が前年同期比マイナスならgoodではなくwarnに格下げする（実測: あさひ3333は進捗率75.3%→86.7%→92.6%と加速も経常益は前年同期比-7.8%）', () => {
  const history = [
    { period: '24.03-05', progress: 75.3, label: '対上期進捗率', profit: 200 },
    { period: '25.03-05', progress: 86.7, label: '対上期進捗率', profit: 150 },
    { period: '26.03-05', progress: 92.6, label: '対上期進捗率', profit: 138.3 }, // (138.3-150)/150 = -7.8%
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '進捗率は加速も利益は前年割れ');
  assert.equal(r.profitYoyPct, -7.8);
  assert.match(r.note, /前年同期比-7\.8%と減益/);
  assert.doesNotMatch(r.note, /好材料が出る可能性があります/); // goodの時の前向きな結論文言を引きずらない
});

test('progressStreakSignal: 直近で下落していれば連続にカウントしない', () => {
  const history = [
    { period: '24.02-04', progress: 40, label: '対上期進捗率' },
    { period: '25.02-04', progress: 60, label: '対上期進捗率' },
    { period: '26.02-04', progress: 30, label: '対上期進捗率' }, // 直近が下落
  ];
  const r = progressStreakSignal(history);
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('progressStreakSignal: データが1件以下・皆無ならchecked/level差を区別する', () => {
  assert.deepEqual(progressStreakSignal([]), { level: null, label: null, note: null, checked: false });
  const single = progressStreakSignal([{ period: '25.02-04', progress: 30 }]);
  assert.equal(single.level, null);
  assert.equal(single.checked, true); // データはあるが1件では連続と言えない
});

// retainedEarnings/investmentSecuritiesは円、marketCapは百万円（kabutan
// の単位に合わせる。marketCapYen参照）。marketCap:10_000＝時価総額100億円。
test('dividendPotentialSignal: 無配＋利益剰余金が時価総額の20%以上ならgood', () => {
  const r = dividendPotentialSignal({ retainedEarnings: 3_000_000_000, marketCap: 10_000, dividendYield: 0 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '初配・株主還元期待');
  assert.match(r.note, /30%/);
});

test('dividendPotentialSignal: 既に配当を出している銘柄ではgoodにしない（無配が条件）', () => {
  const r = dividendPotentialSignal({ retainedEarnings: 3_000_000_000, marketCap: 10_000, dividendYield: 1.5 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('dividendPotentialSignal: 配当利回りが未取得（null）なら無配と誤認せずchecked:false', () => {
  const r = dividendPotentialSignal({ retainedEarnings: 3_000_000_000, marketCap: 10_000, dividendYield: null });
  assert.equal(r.level, null);
  assert.equal(r.checked, false);
});

test('hiddenAssetSignal: 投資有価証券が時価総額の30%以上ならgood', () => {
  const r = hiddenAssetSignal({ investmentSecurities: 4_000_000_000, marketCap: 10_000 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '含み資産あり');
  assert.match(r.note, /40%/);
});

test('hiddenAssetSignal: 比率が閾値未満ならlevel:nullだがchecked:true', () => {
  const r = hiddenAssetSignal({ investmentSecurities: 1_000_000_000, marketCap: 10_000 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('hiddenAssetSignal: データ不足ならchecked:false', () => {
  assert.equal(hiddenAssetSignal({ investmentSecurities: null, marketCap: 10_000 }).checked, false);
});

test('creditFloatSignal: 占有率が20%以上ならbad（上値が重い）', () => {
  // 発行済株式数1,000万株・上位3株主30%保有→推定浮動株700万株。
  // 信用買い残150万株 ÷ 700万株 ≈ 21.4%
  const r = creditFloatSignal({ creditBuyBalance: 1_500_000, sharesOutstanding: 10_000_000, top3PctNow: 30 });
  assert.equal(r.level, 'bad');
  assert.equal(r.label, '信用買い占有率が高い');
  assert.match(r.note, /21\.4%/);
  assert.equal(r.checked, true);
  assert.equal(r.occupancy, 21.4); // precursorCardの需給バッジが直接参照する生値
});

test('creditFloatSignal: 占有率が5%以下ならgood（需給が軽い）', () => {
  const r = creditFloatSignal({ creditBuyBalance: 200_000, sharesOutstanding: 10_000_000, top3PctNow: 30 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '需給が軽い');
  assert.match(r.note, /2\.9%/);
  assert.equal(r.occupancy, 2.9);
});

test('creditFloatSignal: 5%超20%未満ならlevel:nullだがchecked:true。occupancyはこの中間域でも需給バッジ用に返す', () => {
  const r = creditFloatSignal({ creditBuyBalance: 700_000, sharesOutstanding: 10_000_000, top3PctNow: 30 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
  assert.equal(r.occupancy, 10);
});

test('creditFloatSignal: occupancyは軽くてもloanRatio(信用倍率)がMARGIN_OVERHANG.heavy以上ならgoodと言い切らずwarnに格下げする（実測: サムコ83.09倍・神戸物産16.26倍・Japan Eyewear 1872倍で「需給が軽い」と「信用過多」が同時に出ていた矛盾の再発防止）', () => {
  const r = creditFloatSignal({ creditBuyBalance: 200_000, sharesOutstanding: 10_000_000, top3PctNow: 30, loanRatio: 83.09 });
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '需給判断に注意');
  assert.equal(r.checked, true);
  assert.equal(r.occupancy, 2.9);
  assert.match(r.note, /83\.09倍/);
});

test('creditFloatSignal: loanRatioがMARGIN_OVERHANG.heavy未満ならoccupancyが軽い場合は従来通りgood', () => {
  const r = creditFloatSignal({ creditBuyBalance: 200_000, sharesOutstanding: 10_000_000, top3PctNow: 30, loanRatio: 3 });
  assert.equal(r.level, 'good');
});

test('creditFloatSignal: loanRatioが未取得(null)でも従来通りoccupancyだけでgood判定する（loanRatioは任意パラメータ）', () => {
  const r = creditFloatSignal({ creditBuyBalance: 200_000, sharesOutstanding: 10_000_000, top3PctNow: 30 });
  assert.equal(r.level, 'good');
});

test('creditFloatSignal: データ不足ならchecked:false', () => {
  assert.equal(creditFloatSignal({ creditBuyBalance: null, sharesOutstanding: 10_000_000, top3PctNow: 30 }).checked, false);
  assert.equal(creditFloatSignal({}).checked, false);
});

test('creditFloatSignal: 上位3株主保有比率が100%以上（発行済株式数を超過する異常データ）ならchecked:false', () => {
  const r = creditFloatSignal({ creditBuyBalance: 100_000, sharesOutstanding: 10_000_000, top3PctNow: 100 });
  assert.equal(r.checked, false);
});

test('creditFloatSignal: creditBuyBalance/sharesOutstandingは同じ単位（株）のため単位換算しない（実データ確認済み: 6336）', () => {
  // marketCapYenのような換算は不要。実データで両者とも「株」単位であることを確認済み
  // （6336: 信用買い残475,100株・発行済株式数8,176,452株）。上位3株主保有比率を
  // 意図的に高めにして閾値を超えさせ、単位を誤って縮小していれば発生するはずの
  // 桁あふれ（数千〜数百万%）が起きず、常識的な範囲の%になることを確認する。
  const r = creditFloatSignal({ creditBuyBalance: 475_100, sharesOutstanding: 8_176_452, top3PctNow: 75 });
  assert.equal(r.checked, true);
  assert.equal(r.level, 'bad');
  assert.match(r.note, /475,100株/);
  // 推定浮動株数=8,176,452×0.25≈2,044,113株。桁が発行済株式数と近い水準に
  // なっている（100万分の1等に誤って縮小していない）ことを確認する。
  assert.match(r.note, /2,044,11\d株/);
  assert.match(r.note, /23\.\d%/);
});

test('consensusTrapSignal: 会社予想がコンセンサス比-5%以下なら期待過剰(bad)（WATCHLIST時代に使われていたが呼び出し側だけ削除されデッドコード化していたのを発掘・復活）', () => {
  const r = consensusTrapSignal(950, 1000); // (950-1000)/1000 = -5%
  assert.equal(r.level, 'bad');
  assert.equal(r.label, '期待過剰');
  assert.equal(r.checked, true);
  assert.match(r.note, /暴落する危険地帯/);
});

test('consensusTrapSignal: 会社予想がコンセンサス比+5%以上なら期待薄(good)', () => {
  const r = consensusTrapSignal(1050, 1000); // +5%
  assert.equal(r.level, 'good');
  assert.equal(r.label, '期待薄');
  assert.equal(r.checked, true);
  assert.match(r.note, /跳ねる可能性/);
});

test('consensusTrapSignal: 差が-5%超+5%未満なら中立(warn)', () => {
  const r = consensusTrapSignal(1020, 1000); // +2%
  assert.equal(r.level, 'warn');
  assert.equal(r.label, '中立');
  assert.equal(r.checked, true);
});

test('consensusTrapSignal: 会社予想・コンセンサスのどちらかが無ければchecked:falseで、欠けている方を区別する', () => {
  const noEstimate = consensusTrapSignal(null, 1000);
  assert.equal(noEstimate.checked, false);
  assert.match(noEstimate.note, /会社予想N\/A/);

  const noConsensus = consensusTrapSignal(1000, null);
  assert.equal(noConsensus.checked, false);
  assert.match(noConsensus.note, /^コンセンサスN\/A$/);

  const noConsensusZero = consensusTrapSignal(1000, 0); // 0は「未算出」であって予想利益0円ではない
  assert.equal(noConsensusZero.checked, false);

  const both = consensusTrapSignal(null, null);
  assert.equal(both.checked, false);
  assert.match(both.note, /共にN\/A/);
});

test('usEarningsTrendSignal: 直近四半期の売上高・純利益とも前年同期比+15%以上ならgood（実測: AAPLの2026-06-27四半期で+16.4%/+27.1%）', () => {
  const trend = [
    { end: '2024-12-28', revenue: 124300000000, netIncome: 36330000000 },
    { end: '2025-03-29', revenue: 95359000000, netIncome: 24780000000 },
    { end: '2025-06-28', revenue: 94036000000, netIncome: 23434000000 },
    { end: '2025-12-27', revenue: 143756000000, netIncome: 42097000000 },
    { end: '2026-03-28', revenue: 111184000000, netIncome: 29578000000 },
    { end: '2026-06-27', revenue: 109417000000, netIncome: 29789000000 },
  ];
  const r = usEarningsTrendSignal(trend);
  assert.equal(r.level, 'good');
  assert.equal(r.checked, true);
  assert.equal(r.revenueGrowthPct, 16.4);
  assert.equal(r.netIncomeGrowthPct, 27.1);
});

test('usEarningsTrendSignal: 米国会計特有の「Q4単独値が欠けている」ギャップがあっても日付ベースで正しく前年同期を見つける（実測: Appleは2025-06-28の次が2025-12-27であり2025-09-27週のQ3単独値が存在しない）', () => {
  // 2026-06-27 の前年同期は暦日ベースで2025-06-28（約364日前）であるべきで、
  // インデックスで4つ前（2024-12-28）を誤って前年同期にしないことを確認する。
  const trend = [
    { end: '2024-12-28', revenue: 100, netIncome: 10 },
    { end: '2025-03-29', revenue: 100, netIncome: 10 },
    { end: '2025-06-28', revenue: 200, netIncome: 20 },
    { end: '2025-12-27', revenue: 100, netIncome: 10 },
    { end: '2026-03-28', revenue: 100, netIncome: 10 },
    { end: '2026-06-27', revenue: 230, netIncome: 23 }, // 2025-06-28(200)比+15%
  ];
  const r = usEarningsTrendSignal(trend);
  assert.equal(r.revenueGrowthPct, 15);
});

test('usEarningsTrendSignal: 売上高が前年同期比-10%以下、または純利益が-20%以下ならbad（減収減益）', () => {
  const trendRevenueDown = [
    { end: '2025-06-28', revenue: 200, netIncome: 20 },
    { end: '2026-06-27', revenue: 170, netIncome: 20 }, // -15%
  ];
  assert.equal(usEarningsTrendSignal(trendRevenueDown).level, 'bad');

  const trendProfitDown = [
    { end: '2025-06-28', revenue: 200, netIncome: 20 },
    { end: '2026-06-27', revenue: 200, netIncome: 14 }, // netIncome -30%
  ];
  assert.equal(usEarningsTrendSignal(trendProfitDown).level, 'bad');
});

test('usEarningsTrendSignal: 1年前に相当する四半期が無い・データ不足ならchecked:false', () => {
  assert.equal(usEarningsTrendSignal([]).checked, false);
  assert.equal(usEarningsTrendSignal([{ end: '2026-06-27', revenue: 100, netIncome: 10 }]).checked, false);
  // 直近四半期しかなく1年以上遡れる過去データが無い場合
  const tooShort = [
    { end: '2026-03-28', revenue: 100, netIncome: 10 },
    { end: '2026-06-27', revenue: 110, netIncome: 11 },
  ];
  assert.equal(usEarningsTrendSignal(tooShort).checked, false);
});

test('usEarningsTrendSignal: 最新データが古すぎる(200日超)ならchecked:falseにする（実測: BXMTのようなREITが業種特有の理由で汎用売上高タグのquarterly開示を10年以上前にやめており、配列の最後が2014年のデータだったのに「直近四半期」として+117%成長と表示していた重大バグの再発防止）', () => {
  const staleTrend = [
    { end: '2013-12-31', revenue: 50, netIncome: 10 },
    { end: '2014-12-31', revenue: 58, netIncome: 12 }, // 有効なYoYペア（+16%）だが2026年から見れば10年以上前
  ];
  const r = usEarningsTrendSignal(staleTrend, '2026-08-28');
  assert.equal(r.checked, false);
  assert.equal(r.level, null);
});

test('usEarningsTrendSignal: asOfを渡さなければ従来通り古さをチェックしない（単体テストの後方互換）', () => {
  const staleTrend = [
    { end: '2013-12-31', revenue: 50, netIncome: 10 },
    { end: '2014-12-31', revenue: 58, netIncome: 12 }, // 前年同期比+16%（有効なYoYペア）
  ];
  const r = usEarningsTrendSignal(staleTrend); // asOf省略
  assert.equal(r.checked, true);
});

test('usEarningsTrendSignal: 最新データが200日以内なら通常通り判定する', () => {
  const trend = [
    { end: '2025-06-28', revenue: 200, netIncome: 20 },
    { end: '2026-06-27', revenue: 240, netIncome: 24 },
  ];
  const r = usEarningsTrendSignal(trend, '2026-08-28'); // 2026-06-27から62日後
  assert.equal(r.checked, true);
  assert.equal(r.level, 'good');
});

test('usEarningsTrendSignal: netIncomeが無い/前年が赤字の場合は売上高だけで判定する', () => {
  const trend = [
    { end: '2025-06-28', revenue: 200, netIncome: -5 }, // 前年赤字
    { end: '2026-06-27', revenue: 240, netIncome: 3 }, // +20%
  ];
  const r = usEarningsTrendSignal(trend);
  assert.equal(r.netIncomeGrowthPct, null);
  assert.equal(r.revenueGrowthPct, 20);
  assert.equal(r.level, 'good'); // netIncomeGrowthPctがnullならrevenueだけで判定
});

test('tenbaggerSignal: 時価総額が上限以下・売上高成長率が閾値以上ならgood', () => {
  const r = tenbaggerSignal({ marketCap: 20_000, maxMarketCap: 30_000, revenueGrowthPct: 30 });
  assert.equal(r.level, 'good');
  assert.equal(r.label, 'テンバガー候補');
  assert.equal(r.checked, true);
});

test('tenbaggerSignal: 時価総額がちょうど上限ならgood（<=）', () => {
  const r = tenbaggerSignal({ marketCap: 30_000, maxMarketCap: 30_000, revenueGrowthPct: 25 });
  assert.equal(r.level, 'good');
});

test('tenbaggerSignal: 時価総額が上限超過ならlevel:null（大型株はテンバガー候補にしない）', () => {
  const r = tenbaggerSignal({ marketCap: 30_001, maxMarketCap: 30_000, revenueGrowthPct: 50 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('tenbaggerSignal: 成長率が閾値未満ならlevel:null（小型でも成長していなければ対象外）', () => {
  const r = tenbaggerSignal({ marketCap: 10_000, maxMarketCap: 30_000, revenueGrowthPct: 24.9 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('tenbaggerSignal: 日本株(百万円)・米国株(百万USD)どちらも同じ「100万単位」の値として単位変換無しで正しく判定する', () => {
  // 日本株: 時価総額200億円(=20,000百万円) <= 上限300億円(=30,000百万円)
  const jp = tenbaggerSignal({ marketCap: 20_000, maxMarketCap: 30_000, revenueGrowthPct: 40 });
  assert.equal(jp.level, 'good');
  // 米国株: 時価総額$1.5B(=1,500百万USD) <= 上限$2B(=2,000百万USD)
  const us = tenbaggerSignal({ marketCap: 1_500, maxMarketCap: 2_000, revenueGrowthPct: 40 });
  assert.equal(us.level, 'good');
});

test('tenbaggerSignal: unitLabelを渡すと時価総額の数値に単位が付く（実測バグ: 単位無しで「時価総額が20,300」と表示され、円なのか百万円なのか読者に分からなかった再発防止）', () => {
  const withUnit = tenbaggerSignal({ marketCap: 20_000, maxMarketCap: 30_000, revenueGrowthPct: 30, unitLabel: '百万円' });
  assert.ok(withUnit.note.includes('20,000百万円'), `noteに単位付きの数値が含まれていません: ${withUnit.note}`);
  const withoutUnit = tenbaggerSignal({ marketCap: 20_000, maxMarketCap: 30_000, revenueGrowthPct: 30 });
  assert.ok(withoutUnit.note.includes('20,000'), '単位無し呼び出しは後方互換のため空文字がデフォルトであるべき');
});

test('tenbaggerSignal: データ不足ならchecked:false', () => {
  assert.equal(tenbaggerSignal({ marketCap: null, maxMarketCap: 30_000, revenueGrowthPct: 40 }).checked, false);
  assert.equal(tenbaggerSignal({ marketCap: 10_000, maxMarketCap: 30_000, revenueGrowthPct: null }).checked, false);
  assert.equal(tenbaggerSignal({}).checked, false);
});

test('midCapGrowthSignal: 時価総額が上限以下・売上高成長率が閾値以上ならgood', () => {
  const r = midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: 40 });
  assert.equal(r.level, 'good');
  assert.equal(r.checked, true);
});

test('midCapGrowthSignal: 時価総額が上限を超えるとlevel:null（実測バグの再発防止: 旧nextGenTenbaggerSignalは上限が無く、AUR時価総額$118億が「10倍に$1180億必要」という非現実的な候補として出続けていた。IONQ想定=$15,802M＝新しい米国Tier B上限$10,000Mを超えるためgoodにならない）', () => {
  const r = midCapGrowthSignal({ marketCap: 15_802, maxMarketCap: 10_000, revenueGrowthPct: 40 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('midCapGrowthSignal: 成長率が閾値未満ならlevel:null（時価総額が範囲内なだけでは該当しない）', () => {
  const r = midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: 10 });
  assert.equal(r.level, null);
  assert.equal(r.checked, true);
});

test('midCapGrowthSignal: unitLabelを渡すと時価総額の数値に単位が付く（tenbaggerSignalと同じ再発防止）', () => {
  const withUnit = midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: 40, unitLabel: '百万USD' });
  assert.ok(withUnit.note.includes('5,000百万USD'), `noteに単位付きの数値が含まれていません: ${withUnit.note}`);
});

test('midCapGrowthSignal: データ不足ならchecked:false', () => {
  assert.equal(midCapGrowthSignal({ marketCap: null, maxMarketCap: 10_000, revenueGrowthPct: 40 }).checked, false);
  assert.equal(midCapGrowthSignal({ marketCap: 5_000, maxMarketCap: 10_000, revenueGrowthPct: null }).checked, false);
  assert.equal(midCapGrowthSignal({}).checked, false);
});

test('repricingLagScore: 直近1ヶ月+20%以上騰落していれば、スコアの内訳に関係なく強制的にzone:priced_in（オーバーライドルール）', () => {
  const r = repricingLagScore({
    return1m: 25, return3m: 5, priceLevelPct: 10, // 未織り込み度は高そうに見えるスコア構成
    revenueGrowthPct: 40, profitGrowthPct: 40, per: 5, sectorPer: 20, hasCatalyst: true, daysToEarnings: 5,
  });
  assert.equal(r.zone, 'priced_in');
});

test('repricingLagScore: 直近3ヶ月+40%以上でもオーバーライドが発火する', () => {
  const r = repricingLagScore({ return1m: 2, return3m: 45, priceLevelPct: 20, revenueGrowthPct: 30 });
  assert.equal(r.zone, 'priced_in');
});

test('repricingLagScore: 業績改善あり・株価が60日レンジ下位30%以内・直近1ヶ月の上昇も小さければzone:pre_move（🟢初動前）', () => {
  const r = repricingLagScore({
    return1m: 3, return3m: -5, priceLevelPct: 15,
    revenueGrowthPct: 30, profitGrowthPct: 30, per: 8, sectorPer: 20,
    hasCatalyst: true, daysToEarnings: 10,
  });
  assert.equal(r.zone, 'pre_move');
  assert.equal(r.checked, true);
  assert.ok(r.score > 50, `score should be reasonably high, got ${r.score}`);
});

test('repricingLagScore: 業績改善あり・株価が既に上昇し始めている(1ヶ月+10%以上・オーバーライド未満)ならzone:re_rating', () => {
  const r = repricingLagScore({
    return1m: 15, return3m: 18, priceLevelPct: 70,
    revenueGrowthPct: 30, profitGrowthPct: 30,
  });
  assert.equal(r.zone, 're_rating');
});

test('repricingLagScore: 業績改善あり・株価反応もまだ小さくない中間状態ならzone:early_move（🟡初動）', () => {
  const r = repricingLagScore({
    return1m: 5, return3m: 8, priceLevelPct: 50,
    revenueGrowthPct: 20, profitGrowthPct: 20,
  });
  assert.equal(r.zone, 'early_move');
});

test('repricingLagScore: 業績改善が無い（revenueGrowthPct/profitGrowthPctとも低い）のに株価だけ高い位置にあればzone:re_rating（積極評価しない）', () => {
  const r = repricingLagScore({
    return1m: 2, return3m: 3, priceLevelPct: 80,
    revenueGrowthPct: -5, profitGrowthPct: null,
  });
  assert.equal(r.zone, 're_rating');
});

test('repricingLagScore: 判定に最低限必要なデータ（株価位置・業績成長率）が無ければzone:nullかつchecked:false', () => {
  const r = repricingLagScore({});
  assert.equal(r.zone, null);
  assert.equal(r.checked, false);
});

test('repricingLagScore: priceLevelPct/成長率が無くても、直近1ヶ月/3ヶ月の騰落率だけでオーバーライドが発火すればchecked:true（実測バグ: 584A・581Aでzone:priced_inなのにchecked:falseとなり警告バッジが握りつぶされていた再発防止）', () => {
  const viaReturn1m = repricingLagScore({ return1m: 25 });
  assert.equal(viaReturn1m.zone, 'priced_in');
  assert.equal(viaReturn1m.checked, true, 'return1mだけでオーバーライドが発火した場合もcheckedはtrueであるべき');

  const viaReturn3m = repricingLagScore({ return3m: 45 });
  assert.equal(viaReturn3m.zone, 'priced_in');
  assert.equal(viaReturn3m.checked, true, 'return3mだけでオーバーライドが発火した場合もcheckedはtrueであるべき');
});

test('repricingLagScore: 業種平均PERが無くてもPSRで株価割安度を代替評価する（米国株向け）', () => {
  const withSectorPer = repricingLagScore({
    priceLevelPct: 50, revenueGrowthPct: 10, per: 10, sectorPer: 20, // ratio=0.5 <= 0.7 → 15点
  });
  const withPsrOnly = repricingLagScore({
    priceLevelPct: 50, revenueGrowthPct: 10, psr: 0.8, // <=1 → 15点
  });
  assert.equal(withSectorPer.breakdown.valuation, 15);
  assert.equal(withPsrOnly.breakdown.valuation, 15);
});

test('repricingLagScore: 先行材料(hasCatalyst)と決算までの日数(daysToEarnings)がスコアに反映される', () => {
  const withCatalystSoon = repricingLagScore({ priceLevelPct: 50, revenueGrowthPct: 10, hasCatalyst: true, daysToEarnings: 7 });
  const withoutEither = repricingLagScore({ priceLevelPct: 50, revenueGrowthPct: 10, hasCatalyst: false, daysToEarnings: null });
  assert.equal(withCatalystSoon.breakdown.catalyst, 10);
  assert.equal(withCatalystSoon.breakdown.event, 10);
  assert.equal(withoutEither.breakdown.catalyst, 0);
  assert.equal(withoutEither.breakdown.event, 0);
  assert.ok(withCatalystSoon.score > withoutEither.score);
});

test('repricingLagScore: スコアは0〜100の範囲に収まる', () => {
  const maxCase = repricingLagScore({
    return1m: 0, return3m: 0, priceLevelPct: 0,
    revenueGrowthPct: 100, profitGrowthPct: 100, per: 1, sectorPer: 100,
    hasCatalyst: true, daysToEarnings: 1,
  });
  assert.ok(maxCase.score <= 100);
  const minCase = repricingLagScore({ priceLevelPct: 100, revenueGrowthPct: -50, profitGrowthPct: -50 });
  assert.ok(minCase.score >= 0);
});
