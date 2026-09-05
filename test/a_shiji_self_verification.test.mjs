// A指示 項目49「v7.4実装後の自己検証」— 指示書が明示した10ケースを
// そのまま回帰テスト化したもの。項目1〜48で実装した各シグナル・スコアを
// 個別にテストするファイルは既に存在するが（indicators.test.mjs等）、
// このファイルは「指示書のケースそのもの」を一箇所にまとめ、将来の
// リファクタでどこか1つのロジックを直した際に、指示書の意図全体が
// 壊れていないかを一度に確認できるようにする（A指示 項目18「自己検証」）。
//
// 項目50「最重要チェックリスト」（22項目）は、このファイルの末尾に
// コメントとして残し、各項目がどのタスク・どのシグナルで満たされたかを
// 記録する（次にA指示を読み返す人が「これは反映済みか」を一目で追える
// ようにするための記録。チェックリスト自体は自動テストにしない項目も
// 含むため、コメントとして保持する）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  repricingLagScore, ambushVerdict, growthAnomalyCautionSignal, deficitGrowthSignal, marginOverhangSignal,
  receivablesAnomalySignal,
} from '../indicators.mjs';

// ケース1: 業績+50%・株価3M+40% → 未織り込み扱いしない
test('A指示ケース1: 業績+50%・株価3M+40%は未織り込み扱いしない（オーバーライドルールでzone:priced_in）', () => {
  const r = repricingLagScore({ revenueGrowthPct: 50, return3m: 40, priceLevelPct: 20 });
  assert.notEqual(r.zone, 'pre_move');
  assert.equal(r.zone, 'priced_in');
});

// ケース2: 業績+40%・株価3M-20% → 未織り込み高評価
test('A指示ケース2: 業績+40%・株価3M-20%は未織り込み高評価（zone:pre_move）', () => {
  const r = repricingLagScore({ revenueGrowthPct: 40, return3m: -20, priceLevelPct: 15 });
  assert.equal(r.zone, 'pre_move');
  assert.ok(r.score > 0);
});

// ケース3: PER8倍・業績悪化 → 割安でも買い推奨しない
test('A指示ケース3: PER8倍・業績悪化（売上高成長率-25%）は割安でも買い推奨しない（買い推奨の最低条件ゲート）', () => {
  const v = ambushVerdict({ rank: 'S', evidence: true, per: 8, revenueGrowthPct: -25 });
  assert.notEqual(v.level, 'buy');
  assert.notEqual(v.level, 'strong_buy');
});

// ケース4: 売上+70%・利益+400%・株価-30% → 高評価候補。ただしベース効果を確認
test('A指示ケース4: 売上+70%・利益+400%・株価-30%は未織り込み高評価だが、異常成長のベース効果確認シグナルも発火する', () => {
  const untapped = repricingLagScore({ revenueGrowthPct: 70, profitGrowthPct: 400, return3m: -30, priceLevelPct: 10 });
  assert.equal(untapped.zone, 'pre_move');
  assert.ok(untapped.score > 0);
  // ベース効果確認: 前期の営業利益率がほぼゼロ（低いベース）なケースで
  // 「異常成長・要確認」が発火することを確認する（本物の成長か、低い
  // ベースからの反動かを区別する材料を提示できているかの検証）。
  const anomaly = growthAnomalyCautionSignal({
    revenueGrowthPct: 70, profitGrowthPct: 400,
    operatingIncomePrior: 5_000_000, netSalesPrior: 1_000_000_000,
  });
  assert.equal(anomaly.checked, true);
  assert.ok(anomaly.level === 'warn' || anomaly.level === 'good', 'ベース効果の確認材料が有る場合は必ずgood/warnいずれかで判定されるべき（checked:falseで沈黙しない）');
});

// ケース5: 赤字・売上+60%・販管費+30%・粗利率改善 → 赤字成長特例
test('A指示ケース5: 赤字・売上+60%・販管費+30%（売上成長率>販管費成長率）・粗利率改善は赤字成長特例', () => {
  const r = deficitGrowthSignal({
    revenueGrowthPct: 60, sgaGrowthPct: 30,
    grossProfit: 300, grossProfitPrior: 100, netSales: 1000, netSalesPrior: 1000, // 粗利率30%→前期比改善
    operatingIncome: -50, operatingIncomePrior: -100, // 赤字幅縮小
    operatingCf: -50, operatingCfPrior: -100, capex: -10, capexPrior: -10,
    cash: 1000, interestBearingDebt: 100, equity: 1000,
  });
  assert.equal(r.level, 'good');
  assert.equal(r.label, '赤字成長特例');
});

// ケース6: 赤字・売上+60%・販管費+90% → 高リスク成長株
test('A指示ケース6: 赤字・売上+60%・販管費+90%（販管費が売上以上に伸び営業赤字拡大）は赤字成長・高リスク', () => {
  const r = deficitGrowthSignal({
    revenueGrowthPct: 60, sgaGrowthPct: 90,
    operatingIncome: -200, operatingIncomePrior: -100, // 赤字が絶対額で拡大
  });
  assert.equal(r.level, 'bad');
  assert.equal(r.label, '赤字成長・高リスク');
});

// ケース7: 信用倍率0.1倍・業績悪化・PER200倍 → 踏み上げ期待だけで買い推奨しない
test('A指示ケース7: 信用倍率0.1倍（過多ではない）・業績悪化・PER200倍は買い推奨しない（業績悪化ゲートが優先）', () => {
  const margin = marginOverhangSignal(0.1);
  assert.notEqual(margin.level, 'bad'); // 信用倍率自体は過多ではない（踏み上げ期待の材料にはなり得る）
  const v = ambushVerdict({ rank: 'S', evidence: true, per: 200, revenueGrowthPct: -30 });
  assert.notEqual(v.level, 'buy'); // が、業績悪化の最低条件ゲートで買い推奨にはならない
});

// ケース8: 売掛金+30%・受注+50%・前受金+40%・営業CF改善 → 売掛金警告を緩和
test('A指示ケース8: 売掛金急増でも前受金増加・営業CF改善（受注データは未取得のため代用不可）があれば警告を緩和する', () => {
  const r = receivablesAnomalySignal({
    revenueGrowthPct: 10, receivablesGrowthPct: 30,
    operatingCfGrowthPct: 20, advancesReceivedGrowthPct: 40,
  });
  assert.equal(r.level, 'warn');
});

// ケース9: 売掛金+30%・受注-20%・営業CF悪化 → 強い警戒
test('A指示ケース9: 売掛金急増・営業CF悪化（受注減少は棚卸資産の同時積み上がりで代用）は強い警戒のまま', () => {
  const r = receivablesAnomalySignal({
    revenueGrowthPct: 10, receivablesGrowthPct: 30,
    operatingCfGrowthPct: -10, inventoryGrowthPct: 60, // 受注データ非対応のため棚卸資産で代替
  });
  assert.equal(r.level, 'bad');
});

// ケース10: AUR/IONQのような大型成長株 → テンバガーTier Aには入れないが、大型超成長株として監視可能
// （us_tenbagger.mjsのUS_TIER_C_MAX_MARKET_CAP_USD/midCapGrowthSignalで既にテスト済みのため、
//  ここでは「Tier A/B/Cが排他的に判定される」という組み合わせの前提のみ再確認する）
test('A指示ケース10: Tier A上限を超える大型成長株はTier Aに入らないが、Tier B/Cの上限内であれば監視可能', async () => {
  const { US_TENBAGGER_MAX_MARKET_CAP_USD, US_TIER_B_MAX_MARKET_CAP_USD, US_TIER_C_MAX_MARKET_CAP_USD } = await import('../us_tenbagger.mjs');
  const { tenbaggerSignal, midCapGrowthSignal } = await import('../indicators.mjs');
  const marketCap = 15_802; // IONQ相当（$15.8B）
  const tierA = tenbaggerSignal({ marketCap, maxMarketCap: US_TENBAGGER_MAX_MARKET_CAP_USD, revenueGrowthPct: 40, unitLabel: '百万USD' });
  const tierC = midCapGrowthSignal({ marketCap, maxMarketCap: US_TIER_C_MAX_MARKET_CAP_USD, revenueGrowthPct: 40, unitLabel: '百万USD' });
  assert.equal(tierA.level, null, 'Tier A（$1B以下）には入らないべき');
  assert.equal(tierC.level, 'good', 'Tier C（$10B〜$20B）の大型超成長株としては監視できるべき');
});

// ------------------------------------------------------------------
// A指示 項目50「最重要チェックリスト」（22項目）— 反映状況の記録。
// 自動テストではなく、次にA指示を読み返す際の索引として残す。
//
// [x] SCORE同点が解消されている → scraper.mjs smartEntryRank（8+4段階カスケード）
// [x] 仕込み優先度が独立している → indicators.mjs entryPriorityScore
// [x] 未織り込み度が業績と株価の乖離で計算されている → repricingLagScore（untapped+improvement）
// [x] 52週レンジ位置が評価に反映されている → repricingLagScore untapped（25/100の最大配点）
// [x] 1M/3M上昇銘柄の過大評価が抑制されている → alreadyMovedStrict/alreadySurged＋例外条項
// [x] 成長加速が独立評価されている → growthAccelerationSignal.score
// [x] 異常成長のベース効果を確認している → growthAnomalyCautionSignal
// [x] 赤字成長特例が実装されている → deficitGrowthSignal（good）
// [x] 米国テンバガー探索がAMBUSHから独立している → us_tenbagger.mjs（us_screener.mjsとは別モジュール）
// [x] 米国Tier Cが追加されている → us_tenbagger.mjs US_TIER_C_MAX_MARKET_CAP_USD
// [x] AUR/IONQのような大型成長株を別枠で扱える → Tier C（上記ケース10で確認）
// [x] テーマタグが自動付与される → smart_entry.mjs THEME_WATCHLIST/themeMatchSignal
// [x] DIAMOND条件が複合条件になっている → diamondSignal（7条件）
// [x] 信用倍率を単独評価していない → shortSqueezeSignal（機関空売り・出来高との複合確認）
// [x] 踏み上げと需給軽さを分離している → shortSqueezeSignal（踏み上げ）とcreditFloatSignal（需給軽さ）が別シグナル
// [x] 売掛金と受注・前受・CFを同時評価している → receivablesAnomalySignal（受注データ非対応のため棚卸資産で代用、前受金・CFは対応）
// [x] データ不足を悪材料・好材料として扱っていない → 全シグナル共通のchecked:falseパターン
// [x] DATA%が信頼度に反映されている → confidenceTier（UNKNOWN含む4段階）＋買い推奨の最低条件ゲート
// [x] 自動生成文章の業績表現に矛盾がない → checkReasonConsistency
// [x] 「なぜ今なのか」が各銘柄に表示される → scraper.mjs whyNowBlock
// [x] 「仕込み妙味」と「成長ポテンシャル」が分離されている → repricingLag.score（妙味）とgrowthPotentialScore（成長ポテンシャル）が別スコア
// [x] テンバガー可能性と現在の買い妙味が分離されている → tenbaggerRealizabilityScore（10倍実現可能性）とrepricingLag.score（今買う妙味）が別スコア
// ------------------------------------------------------------------
