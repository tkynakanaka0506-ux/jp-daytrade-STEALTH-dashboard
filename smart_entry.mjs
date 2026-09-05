// ==================================================================
// smart_entry.mjs — 「スマート・エントリー」全銘柄スキャン
//
//  決算スケジュールを無視し、需給と乖離だけで機械的にスクリーニングする。
//  AMBUSHのユニバース（SBI決算カレンダーのT+14〜45日以内）とは独立。
//
//  ■ 対象ユニバース
//  東証の全銘柄マスタは保有していないため、TDnet直近14営業日の開示銘柄
//  （実測: 約3,400銘柄）∪ SBI決算カレンダー銘柄（約270銘柄）の和集合を
//  ユニバースとする。開示が全く無い超小型株は漏れうるが、東証上場の
//  大半をカバーできる（仕様書の「全3,800銘柄」に近似）。
//
//  ■ 2段スクリーニング（AMBUSHと同じ考え方）
//  Stage 1 … 全ユニバースを kabuka ページ1枚(1リクエスト)で取得し、
//            低位株・薄商い銘柄を除外した上でパターン①②の技術条件
//            （乖離・RSI・GC・出来高倍率）だけで仮判定する。
//            週次信用残・決算はまだ取らない。
//  Stage 2 … Stage1候補 ∪ コンセンサスを持つSBI銘柄だけに絞って、
//            週次信用残ページ・決算ページ(2リクエスト)を追加取得し、
//            赤字・債務超過を除外した上で3パターンを確定判定する。
//            ここで全銘柄に手を広げるとリクエストが膨れるため、
//            候補を絞ってから叩く。
//
//  ■ 除外フィルター（「一切表示しない」対象）
//  株価300円未満・直近5日平均売買代金1億円未満・直近営業損益が赤字・
//  自己資本比率0%以下（債務超過）のいずれかに該当する銘柄は候補から
//  除く（indicators.mjsのcheapExclusion/fundamentalExclusion）。
//  25日線乖離率+15%超（過熱）やグロース市場の急騰は除外ではなく
//  警告バッジ（scraper.mjs側で付与）。
//
//  ■ パターン③（しこり解消・出遅れ株）の限界
//  コンセンサス予想はSBI決算カレンダーに載っている銘柄（次回決算が
//  近い銘柄）にしか無い。全銘柄分の予想コンセンサスは保有していない
//  ため、パターン③はSBIカレンダー外の銘柄では常にN/A（非該当）になる。
//  推測で埋めない（仕様書§25と同じ方針）。
// ==================================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchIntraday, fetchIntradayExtended, fetchWeeklyCredit, fetchFinance, fetchMain, fetchThemeStocks, sleep, REQ_GAP } from './kabutan.mjs';
import {
  kairi, rsi, goldenCross, volumeRatio, creditTrend, creditLevelVsRange,
  reboundPatternSignal, trendReversalPatternSignal, laggingPatternSignal,
  cheapExclusion, fundamentalExclusion,
  sellingClimaxSignal, netNetSignal, lowPbrSignal, dividendYieldFloorSignal, shortSqueezeSignal, sectorMomentumSignal,
  sectorRotationSignal, SECTOR_ROTATION, marginOverhangSignal, earningsProximitySignal, receivablesAnomalySignal,
  institutionalShortSignal, majorShareholderSignal, dividendYieldPeakSignal, pbrHistoricalLowSignal, hiddenGemSignal,
  retailExpectationSignal, returnPct, priceLevelVsRange,
  progressStreakSignal, dividendPotentialSignal, hiddenAssetSignal, hasPrecursor, GROWTH_MARKET,
  tenbaggerSignal, midCapGrowthSignal, repricingLagScore, latestProfitYoyPct, growthAccelerationSignal,
  breakoutVolumeSignal, computeFloatRatio, floatSqueezeSignal, aggressiveInvestmentSignal, themeMatchSignal,
} from './indicators.mjs';
import { sectorTrendPct } from './sector_history.mjs';
import { fetchMajorShareholderTrend, fetchDividendYieldHistory, fetchPbrHistory } from './irbank.mjs';
import { buildDocumentIndex, fetchBalanceSheetSnapshot } from './edinet.mjs';
import { fetchInstitutionalShortInterest } from './karauri.mjs';
import { daysUntil } from './screener.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'smart_entry_cache.json');

// 表示上限。仕様（新提案）は「毎日10個ほど」だが、複数該当時に何件
// 切り捨てたか分かるよう少し余裕を持たせる。
export const RESULT_LIMIT = 24;

// テーマ性マッチング（themeMatchSignal、ユーザー提案）の手動キュレー
// ションリスト。tenbagger_research_log.mdの手動リサーチで実際に
// kabutan.jpのテーマページが存在すると確認済みの表記のみを載せる
// （実測: "AI"・"自動運転"・"防衛関連"は404だったため採用していない）。
// 自動発見の仕組みは無いため、今後の追加リサーチで随時追記していく運用
// （US_TENBAGGER_WATCHLISTと同じ考え方）。
export const THEME_WATCHLIST = [
  'ドローン', '建設DX', '橋梁', '脱炭素', '半導体', 'データセンター',
  '再生医療', 'サイバーセキュリティ', '蓄電池', '水素', '防衛', '自動運転車',
];

// THEME_WATCHLISTの各テーマページを1回ずつ取得し、コード→該当テーマ名
// 配列のMapを作る（候補ごとではなくスキャン全体で1回だけ。テーマ数は
// 少数なので追加コストは小さい）。404等は黙ってスキップする
// （テーマ名の表記が変わった可能性があるだけで、スキャン全体を止めない）。
async function buildThemeCodeMap() {
  const map = new Map();
  for (const theme of THEME_WATCHLIST) {
    try {
      await sleep(REQ_GAP);
      const codes = await fetchThemeStocks(theme);
      for (const code of codes) {
        if (!map.has(code)) map.set(code, []);
        map.get(code).push(theme);
      }
    } catch (e) {
      console.error(`  ⚠️ テーマページ取得失敗（${theme}）: ${e.message}`);
    }
  }
  return map;
}

// ------------------------------------------------------------------
// ユニバース構築 — TDnetの開示銘柄 ∪ SBI決算カレンダー銘柄
// ------------------------------------------------------------------
export function buildUniverse({ tdNames = {}, sbiStocks = {} } = {}) {
  const universe = {};
  for (const [code, name] of Object.entries(tdNames)) universe[code] = name;
  for (const [code, s] of Object.entries(sbiStocks)) universe[code] ??= s.name;
  return universe;
}

// 順位付け用の総合スコア。該当パターン数(matched)が主軸だが、それだけで
// 決めると「乖離は深いが信用倍率が高い」ような銘柄が、他の警告材料を
// 一切見ずに1位に来てしまう（実測で確認済み）。底打ち確認の追加根拠や
// 警告、部分該当（データ不足で該当扱いにできないが根拠はある状態）も
// 加味する。scraper.mjs の場中再判定後の並べ直しでも同じ基準を使う。
// smartEntryConvictionが実際に加点する信号の一覧。この配列を唯一の
// 情報源にする（test/conviction.test.mjsがこれをimportして使う。
// screener.mjsのAMBUSH_BONUS_FIELDSと同じ再発防止の考え方）。
export const SMART_ENTRY_BONUS_FIELDS = [
  'climax', 'netNet', 'lowPbr', 'divFloor', 'squeeze', 'sectorRotation', 'sectorLag', 'institutionalShort',
  'majorShareholder', 'dividendPeak', 'pbrHistoricalLow', 'hiddenGem',
];

// smartEntryConvictionが実際に減点する信号の一覧（SMART_ENTRY_BONUS_FIELDS
// と同じ「単一の情報源」の考え方）。retailExpectationSignal（個人投資家
// の期待織り込み）は「まだ株価に織り込まれていないパターン」を優先する
// ための重要な減点要素（ユーザー要望。screener.mjsのAMBUSH_PENALTY_FIELDS
// と同じ考え方）。
export const SMART_ENTRY_PENALTY_FIELDS = ['sectorLag', 'marginOverhang', 'earningsWarning', 'receivablesAnomaly', 'retailExpectation'];

export function smartEntryConviction(r) {
  let score = r.matched * 100;
  score += [r.sig1, r.sig2, r.sig3].filter((s) => s?.level === 'partial').length * 20;
  // sectorLagは「連れ高(bad)」は減点対象なのに「出遅れ(good)」は加点
  // 対象に入っておらず、似た性質のsectorRotationとの扱いが非対称だった
  // （bottomChipsでは同じ緑チップとして表示されるのに、スコアには
  // 反映されていなかった）。sectorRotationと同様にgoodも加点する。
  score += SMART_ENTRY_BONUS_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'good').length * 15;
  score -= SMART_ENTRY_PENALTY_FIELDS.map((k) => r[k]).filter((s) => s?.level === 'bad').length * 25;
  return score;
}

// Stage 1 の安価な部分判定 — 週次信用残を取らずに分かる範囲だけで
// パターン①②の「技術条件が満たされているか」を仮判定する。
// （パターン③は信用残水準が要るのでここでは判定できない）
function cheapCandidate(tech) {
  const p1 = tech.kairi !== null && tech.rsi !== null && tech.kairi <= -10 && tech.rsi <= 30;
  const p2 = tech.cross?.crossed === true && tech.volRatio !== null && tech.volRatio >= 1.5;
  return p1 || p2;
}

// ------------------------------------------------------------------
// 成長株（東証グロース）カタリスト予兆スキャン（ユーザー要望）
//
//  カタリスト予兆セクションはAMBUSHユニバース（決算T+14〜45日・
//  約20〜25銘柄）に限定されていたが、「成長株にも入れて欲しい」という
//  要望に対応し、東証グロース市場銘柄全体を対象に同じ予兆
//  （進捗率加速・株主還元ポテンシャル・含み資産・売掛金急増）を探す。
//
//  ■ 全銘柄にEDINET財務データ取得をかけない理由（コスト）
//  東証グロースは500〜650銘柄あり、全銘柄にEDINET+kabutan決算ページの
//  取得をかけると現状の30〜40分のスキャンにさらに20〜40分以上（実測では
//  それ以上）かかる。ユーザーの了承を得て、Stage1で全銘柄に既に適用
//  済みのcheapExclusion（出来高・株価フィルタ、追加コスト無し）に加え、
//  時価総額の下限でも絞り込む。
//
//  techByCode（Stage1で全銘柄分取得済み）のmarketフィールドで対象を
//  絞れるため、市場区分を得るための追加リクエストは発生しない。
// ------------------------------------------------------------------
export const GROWTH_PRECURSOR = { minMarketCap: 3000 }; // 百万円（30億円）。仕手性の高い超小型株を除外する目的

// テンバガー候補（Tier A）の時価総額上限。300億円未満を「まだ10倍になる
// 余地がある小型株」の目安とする。
export const TENBAGGER_MAX_MARKET_CAP_JPY = 30_000; // 百万円

// 中型成長株候補（Tier B）の時価総額上限。実データで発覚した問題（AUR
// 時価総額$118億は10倍に$1180億必要で非現実的、402A時価総額347億円との
// 規模差が50倍近くあり同じ枠に同居していた）を受け、上限を新設して
// 「テンバガーは無理だが2〜3倍は狙えるグロース中堅株」に再定義した
// （indicators.mjsのmidCapGrowthSignal参照）。
export const MID_CAP_MAX_MARKET_CAP_JPY = 100_000; // 百万円（1000億円）

async function scanGrowthPrecursors(techByCode, universe) {
  const growthCodes = Object.entries(techByCode)
    .filter(([, tech]) => tech.market === GROWTH_MARKET)
    .map(([code]) => code);
  console.log(`🌱 成長株カタリスト予兆: 東証グロース${growthCodes.length}銘柄（出来高フィルタ済み）を走査`);

  let edinetIndex = new Map();
  try {
    edinetIndex = await buildDocumentIndex(growthCodes);
  } catch (e) {
    console.error(`  ⚠️ 成長株予兆: EDINET書類一覧の一括取得に失敗: ${e.message}`);
  }
  // テーマ性マッチング（ユーザー提案）。候補ごとではなくスキャン全体で
  // 1回だけ、THEME_WATCHLISTの各テーマページを取得する。
  const themeCodeMap = await buildThemeCodeMap();

  const out = [];
  const tenbaggersA = [];
  const tenbaggersB = [];
  let capExcluded = 0, err = 0;
  for (const [i, code] of growthCodes.entries()) {
    if ((i + 1) % 100 === 0) {
      console.log(`   … ${i + 1}/${growthCodes.length}（該当 ${out.length} / 時価総額除外 ${capExcluded} / 取得失敗 ${err}）`);
    }
    let main = {};
    try {
      main = await fetchMain(code);
    } catch {
      err++;
      await sleep(REQ_GAP);
      continue;
    }
    await sleep(REQ_GAP);
    // 時価総額での絞り込みはfetchMainの結果が無いと判定できないため、
    // ここで初めて弾く（1銘柄1リクエスト分のコストは避けられないが、
    // これ以降のfetchFinance/EDINET ZIP取得の方が重いので、ここで
    // 早期returnする意味は大きい）。
    if (!Number.isFinite(main.marketCap) || main.marketCap < GROWTH_PRECURSOR.minMarketCap) {
      capExcluded++;
      continue;
    }

    let fin = {}, bs = {};
    try {
      fin = await fetchFinance(code);
    } catch { /* フォールバック: progressStreak等はN/Aのまま */ }
    await sleep(REQ_GAP);
    try {
      bs = await fetchBalanceSheetSnapshot(edinetIndex.get(code));
    } catch { /* フォールバック: dividendPotential等はN/Aのまま */ }
    await sleep(REQ_GAP);

    const progressStreak = progressStreakSignal(fin.progressHistory);
    const dividendPotential = dividendPotentialSignal({
      retainedEarnings: bs.retainedEarnings, marketCap: main.marketCap, dividendYield: main.dividendYield,
    });
    const hiddenAsset = hiddenAssetSignal({ investmentSecurities: bs.investmentSecurities, marketCap: main.marketCap });
    const receivablesAnomaly = receivablesAnomalySignal({
      revenueGrowthPct: fin.revenueGrowth?.growthPct ?? null,
      receivablesGrowthPct: bs.receivablesGrowthPct ?? null,
      operatingCfGrowthPct: bs.operatingCfGrowthPct ?? null,
    });
    const tech = techByCode[code];

    // テンバガー候補（ユーザー提案、Tier A/B 2階建て）。progressStreak等の
    // カタリスト予兆シグナルとは判定基準が別物（予兆の有無ではなく
    // 小時価総額×高成長率、またはTier Bは大型でも高成長率が続いているか）
    // のため、下のhasPrecursorによるcontinueより前で判定する
    // （continueしてしまうとカタリスト予兆に該当しないテンバガー候補が
    // 拾えなくなる）。
    // 判定は排他的: 時価総額が上限以下ならTier A、超えていればTier Bの
    // みを判定する（同じ銘柄が両方には出ない）。
    const revenueGrowthPct = fin.revenueGrowth?.growthPct ?? null;
    const withinTierACap = Number.isFinite(main.marketCap) && main.marketCap <= TENBAGGER_MAX_MARKET_CAP_JPY;
    const tenbaggerA = withinTierACap
      ? tenbaggerSignal({ marketCap: main.marketCap, maxMarketCap: TENBAGGER_MAX_MARKET_CAP_JPY, revenueGrowthPct, unitLabel: '百万円' })
      : { level: null, label: null, note: null, checked: true };
    const tenbaggerB = withinTierACap
      ? { level: null, label: null, note: null, checked: true }
      : midCapGrowthSignal({ marketCap: main.marketCap, maxMarketCap: MID_CAP_MAX_MARKET_CAP_JPY, revenueGrowthPct, unitLabel: '百万円' });
    // 「持続的な高成長」の追加確認（手動リサーチで得た教訓の反映）。
    // revenueGrowthPctは年次決算の単一時点の値のため、前期が異常に
    // 悪かった反動での一時的な高成長率を「持続成長」と誤認するリスクが
    // ある。fin.progressHistory（同じ時期の進捗率の複数年推移）は既に
    // progressStreak計算用に取得済みのため、追加リクエスト無しで
    // 「直近の進捗率が前年同期を下回っていないか」を確認できる。
    // 悪化していれば、Tier A/Bいずれの条件を満たしていてもテンバガー
    // 候補からは除外する（Tier A/B共通の質チェック）。
    const ph = fin.progressHistory;
    const progressDeclining = Array.isArray(ph) && ph.length >= 2 && ph.at(-1).progress < ph.at(-2).progress;
    const tenbaggerHit = !progressDeclining
      ? (tenbaggerA.level === 'good' ? { tier: 'A', signal: tenbaggerA } : tenbaggerB.level === 'good' ? { tier: 'B', signal: tenbaggerB } : null)
      : null;
    if (tenbaggerHit) {
      // 仕込み妙味スコア（「今から買う妙味」軸、Tier判定=「10倍ポテン
      // シャル」軸とは別物）。候補に絞られた銘柄だけ、60日超の日足を
      // 追加取得する（Stage1のtech.closesは1ページ=約30日分しか無く、
      // priceLevelVsRange(60)/returnPct(closes,60)には不足するため。
      // 候補は少数なのでコスト増は許容できる）。
      // hasCatalyst代用: TDnetは見ないスキャンのため、同じ銘柄で既に
      // 計算済みのカタリスト予兆シグナル（progressStreak等）のいずれか
      // がgoodかどうかで代用する（追加コスト無し）。仕込み妙味スコアの
      // 入力に加え、株価帯フィルター（低位株ほど10倍化を狙いやすいと
      // いうユーザー方針）で「材料十分か」の判定にも使う。
      const hasCatalyst = [progressStreak, dividendPotential, hiddenAsset].some((s) => s?.level === 'good');
      // 成長の「加速」（ユーザー提案）。fin.revenueGrowthは既に取得済みの
      // データなので追加リクエスト無し。
      const growthAcceleration = growthAccelerationSignal({
        growthPct: revenueGrowthPct, prevGrowthPct: fin.revenueGrowth?.prevGrowthPct ?? null,
      });
      // 攻めの投資（研究開発費が売上を上回る伸び、ユーザー提案）。
      // bsは既にこのループの上流で取得済み（edinet.mjs）のため追加
      // リクエスト無し。
      const aggressiveInvestment = aggressiveInvestmentSignal({
        rndGrowthPct: bs.rndGrowthPct ?? null, revenueGrowthPct,
      });
      // テーマ性マッチング（ユーザー提案）。themeCodeMapは既にスキャン
      // 冒頭で1回だけ取得済みのため追加リクエスト無し。
      const themeMatch = themeMatchSignal({ matchedThemes: themeCodeMap.get(code) ?? [] });
      let repricingLag = null, breakoutVolume = { level: null, label: null, note: null, checked: false };
      let floatSqueeze = { level: null, label: null, note: null, checked: false };
      let majorShareholder = { level: null, label: null, note: null, checked: false };
      try {
        await sleep(REQ_GAP);
        const ivFresh = await fetchIntradayExtended(code, 3);
        const psr = Number.isFinite(fin.revenueGrowth?.latestSales) && fin.revenueGrowth.latestSales > 0 && Number.isFinite(main.marketCap)
          ? main.marketCap / fin.revenueGrowth.latestSales
          : null;
        repricingLag = repricingLagScore({
          return1m: returnPct(ivFresh?.closes, 20),
          return3m: returnPct(ivFresh?.closes, 60),
          priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60),
          revenueGrowthPct, profitGrowthPct: latestProfitYoyPct(ph),
          per: null, sectorPer: null, psr, hasCatalyst,
          daysToEarnings: null, // 決算日非依存スキャンのため取得していない
        });
        // 高値圏×出来高急増（順張りブレイクアウト、ユーザー提案）。
        // ivFreshは既にrepricingLag用に取得済みでvolumesも含むため
        // 追加リクエスト無し。repricingLagとは逆に「高値圏＋出来高」を
        // ポジティブに評価する別軸のため、scraper.mjs側で両者が矛盾なく
        // 併記されるようツールチップを付ける。
        const vol = volumeRatio(ivFresh?.volumes, 20);
        breakoutVolume = breakoutVolumeSignal({ priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60), volumeRatio: vol });
        // 浮動株比率×出来高急増（ユーザー提案）。候補は少数のため
        // fetchMajorShareholderTrendを追加で1リクエスト許容する
        // （ivFresh取得と同じ「候補限定なら追加コストを許容する」方針）。
        try {
          await sleep(REQ_GAP);
          const shareholderInfo = await fetchMajorShareholderTrend(code);
          const floatRatio = computeFloatRatio({ sharesOutstanding: main.sharesOutstanding, top3PctNow: shareholderInfo.top3PctNow });
          floatSqueeze = floatSqueezeSignal({ floatRatio, volumeRatio: vol });
          // v7.3改修 項目13（TENBAGGER SCOREの「株主構成」軸）: shareholderInfoは
          // 上のfloatSqueeze用に既に取得済みのため追加リクエスト無しで
          // 大株主の買い増し（majorShareholderSignal、AMBUSH/SMART ENTRY本体の
          // 判定と同じ関数）を併せて評価できる。
          majorShareholder = majorShareholderSignal(shareholderInfo);
        } catch { /* 失敗してもfloatSqueeze/majorShareholderはchecked:falseのまま */ }
      } catch { /* 失敗しても候補自体は表示する（repricingLag等はデフォルトのまま） */ }
      const item = {
        code, name: universe[code] ?? code,
        price: tech.price, changePct: tech.changePct, closes: tech.closes.slice(-20), market: tech.market,
        marketCap: main.marketCap, revenueGrowthPct, tier: tenbaggerHit.tier, tenbagger: tenbaggerHit.signal, repricingLag, hasCatalyst,
        growthAcceleration, breakoutVolume, floatSqueeze, aggressiveInvestment, themeMatch,
        // v7.3改修 項目13（TENBAGGER SCOREの「財務」軸）: bsは関数冒頭で
        // 既にEDINETから取得済み（progressStreak等と同じ入力元）のため
        // 追加リクエスト無し。営業CF・現金・有利子負債という「テンバガー
        // 候補が成長を維持できる体力があるか」の生の裏付け情報を、
        // 閾値による除外はせず（実データで裏付けの無い閾値を作らない
        // 方針）参考情報としてそのまま表示する。
        operatingCf: bs.operatingCf ?? null, cash: bs.cash ?? null, interestBearingDebt: bs.interestBearingDebt ?? null,
        majorShareholder,
      };
      if (tenbaggerHit.tier === 'A') tenbaggersA.push(item);
      else tenbaggersB.push(item);
    }

    const r = { progressStreak, dividendPotential, hiddenAsset, receivablesAnomaly };
    if (!hasPrecursor(r)) continue;

    out.push({
      code, name: universe[code] ?? code,
      price: tech.price, changePct: tech.changePct, closes: tech.closes.slice(-20), market: tech.market,
      marketCap: main.marketCap,
      progressStreak, dividendPotential, hiddenAsset, receivablesAnomaly,
    });
  }
  console.log(`   成長株予兆スキャン完了（時価総額${GROWTH_PRECURSOR.minMarketCap}百万円未満で除外 ${capExcluded} / 取得失敗 ${err}） / 該当 ${out.length}銘柄 / テンバガー候補 Tier A ${tenbaggersA.length}銘柄・Tier B ${tenbaggersB.length}銘柄`);
  return { precursors: out, tenbaggersA, tenbaggersB };
}

// ------------------------------------------------------------------
// 本体
// ------------------------------------------------------------------
export async function runSmartEntryScreen({ today, tdNames, sbiStocks, sectors = {}, sectorHistory = {}, force = false, limit = RESULT_LIMIT } = {}) {
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { /* 初回 */ }
  if (!force && cache.date === today && cache.results) {
    console.log(`💾 スマート・エントリーキャッシュ有効 (${today}) — 該当${cache.results.length}銘柄 / リクエスト0件`);
    return cache;
  }

  const universe = buildUniverse({ tdNames, sbiStocks });
  const codes = Object.keys(universe);
  console.log(`🌐 スマート・エントリー Stage 1: 全${codes.length}銘柄をスキャン（30〜40分程度かかります）`);

  const techByCode = {};
  const stage2Set = new Set();
  let s1err = 0, s1excluded = 0;

  for (const [i, code] of codes.entries()) {
    try {
      const iv = await fetchIntraday(code);
      // 低位株・薄商い銘柄は候補にすら上げない（「ゴミ箱排除」フィルター）。
      // ここで弾けば週次信用残ページ(Stage2)への無駄打ちも防げる。
      const excl = cheapExclusion({ price: iv.price, closes: iv.closes, volumes: iv.volumes });
      if (excl.excluded) { s1excluded++; }
      else {
        const tech = {
          price: iv.price,
          changePct: iv.changePct,
          closes: iv.closes,
          volumes: iv.volumes,
          market: iv.market,
          kairi: kairi(iv.price, iv.closes),
          rsi: rsi(iv.closes),
          cross: goldenCross(iv.closes),
          volRatio: volumeRatio(iv.volumes),
        };
        techByCode[code] = tech;
        if (cheapCandidate(tech)) stage2Set.add(code);
      }
    } catch {
      s1err++;
    }
    if ((i + 1) % 200 === 0) console.log(`   … ${i + 1}/${codes.length}（Stage2候補 ${stage2Set.size} / 除外 ${s1excluded} / 取得失敗 ${s1err}）`);
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 1 完了（取得失敗 ${s1err} / 低位株・薄商い除外 ${s1excluded}） / Stage2候補 ${stage2Set.size}`);

  // 成長株カタリスト予兆スキャン（ユーザー要望）。techByCodeはStage1で
  // 全銘柄分取得済みのため、市場区分を得るための追加リクエストは無い。
  // テンバガー候補（ユーザー提案）も同じループ内・同じ既取得データから
  // 判定するため、追加リクエストは発生しない。
  const { precursors: growthPrecursors, tenbaggersA: tenbaggerCandidatesA, tenbaggersB: tenbaggerCandidatesB } = await scanGrowthPrecursors(techByCode, universe);

  // パターン③はコンセンサスを持つSBI銘柄でしか判定できない（上記コメント参照）。
  // Stage 1 は universe = tdNames ∪ sbiStocks を全走査済みなので techByCode に
  // 既に入っているはず。取得に失敗していた場合は techByCode[code] が無く、
  // 下のループで自然に除外される。
  for (const [code, s] of Object.entries(sbiStocks)) {
    if (Number.isFinite(s.estimateProfit) && Number.isFinite(s.consensusProfit) && techByCode[code]) {
      stage2Set.add(code);
    }
  }

  console.log(`🔬 スマート・エントリー Stage 2: 週次信用残・決算を確認 (${stage2Set.size}銘柄 × 2リクエスト、該当銘柄のみ底打ち確認+2リクエスト)`);
  // 貸借対照表項目（売掛金・現金及び預金・自己資本・総資産）はEDINETから
  // 取得する（AMBUSHと同じハイブリッド方針）。EDINETは銘柄単体の検索APIが
  // 無く日付ごとの全件走査しか無いため、Stage2候補全体分をここで1回だけ
  // 走査してメタデータのインデックスを作る（実際のZIP取得・パースは
  // matched>0で実際に表示する銘柄だけに絞って下のループ内で行う）。
  let edinetIndex = new Map();
  try {
    edinetIndex = await buildDocumentIndex([...stage2Set]);
  } catch (e) {
    console.error(`  ⚠️ EDINET書類一覧の一括取得に失敗: ${e.message}`);
  }
  const results = [];
  let s2err = 0, s2excluded = 0;
  for (const code of stage2Set) {
    const tech = techByCode[code];
    if (!tech) continue;
    let weekly = [], fin = {};
    try {
      weekly = await fetchWeeklyCredit(code);
      await sleep(REQ_GAP);
      fin = await fetchFinance(code);
    } catch {
      s2err++;
    }

    // 赤字・債務超過は決算ページを見ないと分からないのでここで弾く。
    const fexcl = fundamentalExclusion({ latestOpProfit: fin.latestOpProfit, equityRatio: fin.equityRatio });
    if (fexcl.excluded) { s2excluded++; await sleep(REQ_GAP); continue; }

    const creditTrendPct = creditTrend(weekly);
    const creditLevelPct = creditLevelVsRange(weekly);
    const loanRatio = weekly[0]?.loanRatio ?? null;
    const s = sbiStocks[code] ?? {};

    const sig1 = reboundPatternSignal({ kairi: tech.kairi, rsi: tech.rsi, creditTrendPct });
    const sig2 = trendReversalPatternSignal({ cross: tech.cross, volRatio: tech.volRatio, loanRatio });
    const sig3 = laggingPatternSignal({
      creditLevelPct, estimateProfit: s.estimateProfit ?? null, consensusProfit: s.consensusProfit ?? null, kairi: tech.kairi,
    });

    const matched = [sig1.level === 'good', sig2.level === 'good', sig3.level === 'good'].filter(Boolean).length;

    if (matched > 0) {
      // 底打ち確認（＋α）は実際に表示する該当銘柄だけに絞って追加取得する
      // （Stage2候補全体ではなく matched>0 の銘柄のみ＝数件〜十数件程度）。
      let main = {}, ivFresh = null;
      try {
        await sleep(REQ_GAP);
        main = await fetchMain(code);
        await sleep(REQ_GAP);
        ivFresh = await fetchIntradayExtended(code);
      } catch { /* 底打ち確認が無くても表示は続ける（N/Aのまま） */ }

      // ネットネット判定・売掛金異常増加チェックの貸借対照表はEDINETから
      // 補う（法定開示のため失敗しても現金のみの簡易版にフォールバック
      // する）。ZIP取得・パースはmatched>0の該当銘柄だけに絞って行う
      // （日付一覧の走査自体は上でstage2Set全体分を先に済ませている）。
      let bs = {};
      try {
        await sleep(REQ_GAP);
        bs = await fetchBalanceSheetSnapshot(edinetIndex.get(code));
      } catch { /* 簡易版にフォールバック */ }

      const climax = sellingClimaxSignal(ivFresh ?? {});
      const netNet = netNetSignal({ cash: bs.cash, totalAssets: bs.totalAssets, equity: bs.equity, marketCap: main.marketCap, receivables: bs.receivables });
      const receivablesAnomaly = receivablesAnomalySignal({
        revenueGrowthPct: fin.revenueGrowth?.growthPct ?? null,
        receivablesGrowthPct: bs.receivablesGrowthPct ?? null,
        operatingCfGrowthPct: bs.operatingCfGrowthPct ?? null,
      });
      const divFloor = dividendYieldFloorSignal(main.dividendYield);

      // 過去の配当利回りレンジ・PBRレンジ（IR Bank）。コンセンサスが
      // 無い銘柄の「代用物差し」および増配トレンド（お宝候補判定）用。
      let dividendHistory = {}, pbrHistory = {};
      try {
        await sleep(REQ_GAP);
        dividendHistory = await fetchDividendYieldHistory(code);
      } catch { /* 未取得のまま（IR Bank取得失敗） */ }
      try {
        await sleep(REQ_GAP);
        pbrHistory = await fetchPbrHistory(code);
      } catch { /* 未取得のまま（IR Bank取得失敗） */ }
      const dividendPeak = dividendYieldPeakSignal({
        currentYield: main.dividendYield, maxYield: dividendHistory.maxYield, maxPeriod: dividendHistory.maxPeriod,
      });
      const pbrHistoricalLow = pbrHistoricalLowSignal({
        currentPbr: main.pbr, minPbr: pbrHistory.minPbr, minPeriod: pbrHistory.minPeriod,
      });

      const squeeze = shortSqueezeSignal(weekly);
      let institutionalShortInfo = {};
      try {
        await sleep(REQ_GAP);
        institutionalShortInfo = await fetchInstitutionalShortInterest(code);
      } catch { /* 未取得のまま（機関投資家の空売り開示が無い/取得失敗） */ }
      const institutionalShort = institutionalShortSignal(institutionalShortInfo);
      let shareholderInfo = {};
      try {
        await sleep(REQ_GAP);
        shareholderInfo = await fetchMajorShareholderTrend(code);
      } catch { /* 未取得のまま（IR Bank取得失敗） */ }
      const majorShareholder = majorShareholderSignal(shareholderInfo);
      const sec = main.sectorName ? sectors[main.sectorName] : null;
      const lowPbr = lowPbrSignal({ pbr: main.pbr, sectorPbr: sec?.pbr });
      const hiddenGem = hiddenGemSignal({
        consensusProfit: s.consensusProfit, netNet, lowPbr,
        dividendStreakYears: dividendHistory.streakYears, dividendStreakDirection: dividendHistory.streakDirection,
      });
      const sectorLag = sectorMomentumSignal(tech.changePct, sec?.changePct ?? null);
      const sectorRotation = sectorRotationSignal({
        sectorTrendPct: sectorTrendPct(sectorHistory, main.sectorName, today, SECTOR_ROTATION.trendDays),
        kairi: tech.kairi,
        cross: tech.cross,
      });
      // 該当パターンが要求する信用倍率としてではなく、一般的な注意喚起
      // として（該当パターンに関係なく）出す。
      const marginOverhang = marginOverhangSignal(loanRatio);
      // SMART ENTRYは決算スケジュールを見ずに選ぶが、「決算直前の新規
      // エントリーは避ける」のは需給とは独立した地雷回避ルールなので、
      // 該当パターンの判定とは別枠で警告する（除外はしない）。
      const earningsDaysLeft = daysUntil(s.earningsDate ?? s.earningsDateApprox, today);
      const earningsWarning = earningsProximitySignal(earningsDaysLeft);
      // 個人投資家による期待の織り込み（軸E）。screener.mjs(AMBUSH)と
      // 同じ考え方。ivFresh/weeklyはselling climax/信用トレンド用に
      // 既に取得済みのため、追加のリクエストは発生しない。
      // volRatioはtech.volRatio（Stage1の非拡張取得）ではなくivFresh
      // （拡張取得）由来にする。return1w/return1m/priceLevelPctと同じ
      // 取得タイミングのデータに揃えないと、株価側の指標だけ違う時点の
      // スナップショットを混ぜて判定することになるため（screener.mjsの
      // ambushConviction側は最初からivFreshで統一している）。
      const retailExpectation = retailExpectationSignal({
        return1w: returnPct(ivFresh?.closes, 5),
        return1m: returnPct(ivFresh?.closes, 20),
        priceLevelPct: priceLevelVsRange(ivFresh?.closes, 60),
        volRatio: volumeRatio(ivFresh?.volumes),
        creditTrendPct, creditWeek1Pct: creditTrend(weekly, 1),
        daysToEarnings: earningsDaysLeft,
      });

      results.push({
        code,
        name: universe[code] ?? code,
        price: tech.price,
        changePct: tech.changePct,
        closes: tech.closes.slice(-20),
        kairi: tech.kairi,
        rsi: tech.rsi,
        cross: tech.cross,
        volRatio: tech.volRatio,
        market: tech.market ?? null,
        loanRatio,
        creditTrendPct,
        creditLevelPct,
        estimateProfit: s.estimateProfit ?? null,
        consensusProfit: s.consensusProfit ?? null,
        sectorName: main.sectorName ?? null,
        sectorChangePct: sec?.changePct ?? null,
        dividendYield: main.dividendYield ?? null,
        // 同業他社比較(peerComparisonBlock)・バリュエーション上限目安
        // (ceilingPriceNote)用。screener.mjs(AMBUSH)側では元々渡していたが、
        // smart_entry.mjs(SMART ENTRY)側は渡しておらず、SMART ENTRYの
        // カードには同業他社比較ブロック自体が一度も表示されていなかった
        // （実測: 9052等SMART ENTRY全カードでpeerbox 0件）。
        pbr: main.pbr ?? null,
        sectorPbr: sec?.pbr ?? null,
        per: main.per ?? null,
        sectorPer: sec?.per ?? null,
        sectorDividendYield: sec?.dividendYield ?? null,
        marketCap: main.marketCap ?? null,
        roe: fin.latestRoe ?? null,
        balanceSheetSource: bs.docID ? 'edinet' : null,
        balanceSheetAsOf: bs.periodEnd ?? null,
        climax, netNet, lowPbr, pbrHistoricalLow, dividendPeak, hiddenGem, divFloor, squeeze, institutionalShort,
        institutionalShortPct: institutionalShortInfo.totalPct ?? null,
        majorShareholder,
        majorShareholderTop1Pct: shareholderInfo.top1Pct ?? null,
        dividendMaxYield: dividendHistory.maxYield ?? null,
        dividendMaxPeriod: dividendHistory.maxPeriod ?? null,
        dividendStreakYears: dividendHistory.streakYears ?? 0,
        dividendStreakDirection: dividendHistory.streakDirection ?? null,
        pbrMin: pbrHistory.minPbr ?? null,
        pbrMinPeriod: pbrHistory.minPeriod ?? null,
        sectorLag, sectorRotation, marginOverhang,
        earningsDaysLeft, earningsWarning, receivablesAnomaly, retailExpectation,
        matched,
        sig1, sig2, sig3,
      });
    }
    await sleep(REQ_GAP);
  }
  console.log(`   Stage 2 完了（取得失敗 ${s2err} / 赤字・債務超過除外 ${s2excluded}） / 該当 ${results.length}銘柄`);

  // 順位付けは該当パターン数を主軸にしつつ、乖離の深さ「だけ」で
  // 決めていた（実測: 信用倍率39倍で買い方が積み上がった銘柄が、
  // 単に乖離が深いという理由だけで1位になっていた）。smartEntryConviction
  // （底打ち確認の追加根拠・警告・部分該当も加味した総合スコア）で並べ、
  // 乖離はそれでも並んだ場合の最終判定に回す。
  results.sort((a, b) => smartEntryConviction(b) - smartEntryConviction(a) || (a.kairi ?? 999) - (b.kairi ?? 999));
  const shown = results.slice(0, limit);
  const dropped = results.length - shown.length;
  if (dropped > 0) console.log(`   ⚠️ 表示上限${limit}件のため ${dropped}銘柄を切り捨て（該当は${results.length}件）`);

  const out = {
    date: today,
    universe: codes.length,
    stage2: stage2Set.size,
    matched: results.length,
    dropped,
    results: shown,
    growthPrecursors,
    tenbaggerCandidatesA,
    tenbaggerCandidatesB,
  };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(out, null, 2));
  return out;
}
