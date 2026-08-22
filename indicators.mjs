// ==================================================================
// indicators.mjs — テクニカル指標
//
//  すべて kabutan の kabuka ページ1枚（直近30営業日の終値・売買高）
//  だけで計算できるものに限定している。外部API依存ゼロ。
//
//  データが足りない場合は 0 や適当な代替値を返さず null を返す。
//  （仕様書§25: N/A を数値に変換しない）
// ==================================================================

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const round2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

// 25日移動平均。25本に満たない場合は本数不足を明示して null を返す。
// （旧版は常に25で割っていたためMAが最大16%過小になり、乖離率が過大に出ていた）
export function ma(closes, period = 25) {
  if (!closes || closes.length < period) return null;
  const w = closes.slice(-period);
  return w.reduce((a, b) => a + b, 0) / period;
}

// 移動平均乖離率(%)
export function kairi(price, closes, period = 25) {
  const m = ma(closes, period);
  if (m === null || !Number.isFinite(price) || m === 0) return null;
  return round1((price / m - 1) * 100);
}

// RSI(14) — Wilder の平滑化。
// 初期14本を単純平均、以降を平滑化していく標準的な実装。
export function rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (al === 0) return ag === 0 ? 50 : 100; // 下落が一度もない期間
  return round1(100 - 100 / (1 + ag / al));
}

// 出来高Zスコア — 直近 period 本（当日を除く）に対する当日の乖離。
// 母集団が動かない（標準偏差0）銘柄は判定不能として null。
export function volumeZScore(volumes, period = 20) {
  if (!volumes || volumes.length < period + 1) return null;
  const hist = volumes.slice(-(period + 1), -1).filter(Number.isFinite);
  const today = volumes.at(-1);
  if (hist.length < period || !Number.isFinite(today)) return null;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  const sd = Math.sqrt(hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length);
  if (sd === 0) return null;
  return round2((today - mean) / sd);
}

// 直近 n 営業日の騰落率(%)（セクターモメンタム用）
export function returnPct(closes, n = 5) {
  if (!closes || closes.length < n + 1) return null;
  const base = closes.at(-(n + 1));
  if (!Number.isFinite(base) || base === 0) return null;
  return round1((closes.at(-1) / base - 1) * 100);
}

// ------------------------------------------------------------------
// Stage 1 判定
//
//  「まだ織り込まれていない」ことの確認であって、良し悪しの判定ではない。
//  仕様書§Stage1: 乖離率 ≤ +5% / RSI ≤ 60 / 出来高Zスコア ≤ 0.5
//
//  指標が null（＝算出不能）の場合は通過させない。
//  未取得を「条件を満たした」と読み替えるのは誤検出の温床になるため。
// ------------------------------------------------------------------
export const STAGE1 = { maxKairi: 5, maxRsi: 60, maxVolZ: 0.5 };

export function stage1(t) {
  const reasons = [];
  if (t.kairi === null) reasons.push('乖離率N/A');
  else if (t.kairi > STAGE1.maxKairi) reasons.push(`乖離${t.kairi}%>+${STAGE1.maxKairi}%`);

  if (t.rsi === null) reasons.push('RSI N/A');
  else if (t.rsi > STAGE1.maxRsi) reasons.push(`RSI${t.rsi}>${STAGE1.maxRsi}`);

  if (t.volZ === null) reasons.push('出来高Z N/A');
  else if (t.volZ > STAGE1.maxVolZ) reasons.push(`VolZ${t.volZ}>${STAGE1.maxVolZ}`);

  return { pass: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------
// テクニカル未織込スコア（10点）
//   仕様書の刻み: 0〜+2%→10 / +2〜3%→8 / +3〜4%→6 / +4〜5%→3 / ≥+5%→0
//   マイナス乖離（＝MAより下）は最も織り込まれていない状態なので満点。
// ------------------------------------------------------------------
export function unpricedScore(k) {
  if (k === null) return null;
  if (k < 2) return 10;
  if (k < 3) return 8;
  if (k < 4) return 6;
  if (k < 5) return 3;
  return 0;
}

// ------------------------------------------------------------------
// エントリー健康診断 — 大型株WATCHLIST専用の「4つの信号」
//
//  AMBUSHの100点スコアとは別物。数値を足し合わせて順位を付けるのではなく、
//  項目ごとに good/warn/bad を判定してそのまま見せる。しきい値は名前付き
//  定数にまとめてあるので、後から実測を見て調整できるようにしてある。
// ------------------------------------------------------------------

export const VALUE_SIGNAL = { overheatKairi: 10, nearLowPct: 3 };

// お買い得度 — 25日線乖離率 + 直近20日安値からの位置
export function valueSignal({ kairi: k, price, closes }) {
  if (k === null) return { level: null, label: 'N/A', note: '乖離率N/A' };
  if (k >= VALUE_SIGNAL.overheatKairi) {
    return { level: 'bad', label: '過熱', note: `乖離+${k}%・今は手出し無用（ハメ込み注意）` };
  }
  const recentLow = closes && closes.length >= 5 ? Math.min(...closes.slice(-20)) : null;
  const nearLow = recentLow !== null && Number.isFinite(price) && price <= recentLow * (1 + VALUE_SIGNAL.nearLowPct / 100);
  if (k < 0 || nearLow) {
    return { level: 'good', label: '割安', note: `乖離${k}%・今が仕込み時` };
  }
  return { level: 'warn', label: '適正', note: `乖離${k}%・過熱感なし` };
}

export const CREDIT_SIGNAL = { heavy: 6, light: 3 };

// 上値の重さ — 信用倍率（買い残/売り残）
export function creditSignal(loanRatio) {
  if (loanRatio === null || loanRatio === undefined) return { level: null, label: 'N/A', note: '信用倍率N/A' };
  if (loanRatio >= CREDIT_SIGNAL.heavy) {
    return { level: 'bad', label: '重い', note: `信用${loanRatio}倍・好材料が出てもすぐ利確売りに押されるリスクあり` };
  }
  if (loanRatio < CREDIT_SIGNAL.light) {
    return { level: 'good', label: '軽い', note: `信用${loanRatio}倍・上がるときに邪魔な売りが出にくい` };
  }
  return { level: 'warn', label: '普通', note: `信用${loanRatio}倍` };
}

export const CONSENSUS_TRAP = { tooHigh: -5, tooLow: 5 };

// 期待値のワナ — 会社予想 vs 市場コンセンサス
export function consensusTrapSignal(estimateProfit, consensusProfit) {
  if (!Number.isFinite(estimateProfit) || !Number.isFinite(consensusProfit) || consensusProfit === 0) {
    return { level: null, label: 'N/A', note: 'コンセンサスN/A' };
  }
  const diffPct = Math.round(((estimateProfit - consensusProfit) / Math.abs(consensusProfit)) * 1000) / 10;
  if (diffPct <= CONSENSUS_TRAP.tooHigh) {
    return { level: 'bad', label: '期待過剰', note: `会社予想がコンセンサス比${diffPct}%・上方修正しても予想に届かず暴落する危険地帯` };
  }
  if (diffPct >= CONSENSUS_TRAP.tooLow) {
    return { level: 'good', label: '期待薄', note: `会社予想がコンセンサス比+${diffPct}%・ちょっと良い数字が出るだけで跳ねる可能性` };
  }
  return { level: 'warn', label: '中立', note: `コンセンサス比${diffPct > 0 ? '+' : ''}${diffPct}%` };
}

// ------------------------------------------------------------------
// スマート・エントリー — 「仕込みパターン」3種
//
//  仕様（新提案）: 決算スケジュールは見ず、需給と乖離だけで機械的に判定する。
//  各パターンは3条件のANDで、1つでもN/A（算出不能）なら「該当」とは言えない
//  ので good にはしない（仕様書§25と同じ考え方: 未取得を満たしたと読み替えない）。
// ------------------------------------------------------------------

// 信用買い残の増減トレンド — 直近週 vs lookback週前 の変化率(%)
// weekly は fetchWeeklyCredit() の戻り値（新しい週が先頭）。
export function creditTrend(weekly, lookback = 4) {
  if (!weekly || weekly.length <= lookback) return null;
  const latest = weekly[0]?.buy, past = weekly[lookback]?.buy;
  if (!Number.isFinite(latest) || !Number.isFinite(past) || past === 0) return null;
  return round1(((latest - past) / past) * 100);
}

// 信用売り残（空売り）の増減トレンド — creditTrend と同じ考え方で sell 列を見る。
export function shortTrend(weekly, lookback = 4) {
  if (!weekly || weekly.length <= lookback) return null;
  const latest = weekly[0]?.sell, past = weekly[lookback]?.sell;
  if (!Number.isFinite(latest) || !Number.isFinite(past) || past === 0) return null;
  return round1(((latest - past) / past) * 100);
}

// 直近 period 週（既定13週≒3ヶ月）レンジの中で今どの位置か（0%=最低水準・100%=最高水準）
export function creditLevelVsRange(weekly, period = 13) {
  const w = (weekly ?? []).slice(0, period).map((r) => r.buy).filter(Number.isFinite);
  if (w.length < period) return null;
  const latest = w[0], min = Math.min(...w), max = Math.max(...w);
  if (max === min) return 0;
  return round1(((latest - min) / (max - min)) * 100);
}

// ゴールデンクロス — 直近 lookback 営業日以内にMA5がMA25を下から上に抜けたか
export function goldenCross(closes, lookback = 3) {
  if (!closes || closes.length < 26) return null;
  const maAt = (period, endIdx) => {
    if (endIdx < period) return null;
    const w = closes.slice(endIdx - period, endIdx);
    return w.reduce((a, b) => a + b, 0) / period;
  };
  for (let back = 0; back < lookback; back++) {
    const idx = closes.length - back, prevIdx = idx - 1;
    if (prevIdx < 25) break;
    const m5 = maAt(5, idx), m25 = maAt(25, idx), pm5 = maAt(5, prevIdx), pm25 = maAt(25, prevIdx);
    if ([m5, m25, pm5, pm25].some((v) => v === null)) continue;
    if (pm5 <= pm25 && m5 > m25) return { crossed: true, daysAgo: back };
  }
  return { crossed: false };
}

// 出来高倍率 — 当日 / 直近period日平均（当日を除く）
export function volumeRatio(volumes, period = 20) {
  if (!volumes || volumes.length < period + 1) return null;
  const hist = volumes.slice(-(period + 1), -1).filter(Number.isFinite);
  const today = volumes.at(-1);
  if (hist.length < period || !Number.isFinite(today)) return null;
  const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
  if (mean === 0) return null;
  return round2(today / mean);
}

const condText = (label, value, unit, ok) =>
  `${label}${value === null || value === undefined ? 'N/A' : `${value}${unit}`}${ok === null ? '' : ok ? '○' : '×'}`;

// 3条件すべて既知かつ真のときだけ「該当」。それ以外は根拠の内訳をそのまま見せる。
// データが1つでも欠けると「N/A」の一言で片付けていたが、それだと
// 「3条件中2つは条件クリア・1つだけ未取得」という有力な状態と
// 「3条件とも丸ごと不明」という無情報の状態が同じ表記になってしまい、
// 実際には根拠がある銘柄が「情報なし」に見えてしまう問題があった
// （実測: 7061のパターン③は信用残水準○・乖離○で条件クリア、
// コンセンサスだけ未取得なのに「N/A」表記だった）。
// 分かっている条件が全てクリアなら「一部該当」として区別し、
// それでも matched（該当パターン数）には数えない（推測で加点はしない）。
function composePattern(conds, matchedNote) {
  const known = conds.filter((c) => c.ok !== null);
  const allKnown = known.length === conds.length;
  const allTrue = conds.every((c) => c.ok === true);
  const note = conds.map((c) => c.text).join(' / ');
  if (allKnown && allTrue) return { level: 'good', label: '該当', note: matchedNote };
  if (!allKnown && known.length > 0 && known.every((c) => c.ok === true)) {
    return { level: 'partial', label: '一部該当（データ不足）', note };
  }
  return { level: null, label: allKnown ? '非該当' : 'N/A', note };
}

// パターン① リバウンド狙い（逆張り）— 乖離-10%以下 / RSI30以下 / 信用買い残減少
export const PATTERN1 = { maxKairi: -10, maxRsi: 30 };
export function reboundPatternSignal({ kairi, rsi, creditTrendPct }) {
  const c1 = kairi === null ? null : kairi <= PATTERN1.maxKairi;
  const c2 = rsi === null ? null : rsi <= PATTERN1.maxRsi;
  const c3 = creditTrendPct === null ? null : creditTrendPct < 0;
  return composePattern(
    [
      { ok: c1, text: condText('乖離', kairi, '%', c1) },
      { ok: c2, text: condText('RSI', rsi, '', c2) },
      { ok: c3, text: condText('信用残4週比', creditTrendPct, '%', c3) },
    ],
    '売られすぎの極致。リバウンドの初動を狙える位置です'
  );
}

// パターン② トレンド転換の初動（順張り）— ゴールデンクロス / 出来高1.5倍以上 / 信用倍率が低い
export const PATTERN2 = { minVolRatio: 1.5, maxLoanRatio: 3 };
export function trendReversalPatternSignal({ cross, volRatio, loanRatio }) {
  const c1 = !cross ? null : cross.crossed;
  const c2 = volRatio === null ? null : volRatio >= PATTERN2.minVolRatio;
  const c3 = loanRatio === null || loanRatio === undefined ? null : loanRatio < PATTERN2.maxLoanRatio;
  return composePattern(
    [
      { ok: c1, text: `GC${c1 === null ? 'N/A' : c1 ? `○(${cross.daysAgo}日前)` : '×'}` },
      { ok: c2, text: condText('出来高倍率', volRatio, '倍', c2) },
      { ok: c3, text: condText('信用倍率', loanRatio, '倍', c3) },
    ],
    'トレンド転換。大きな上昇トレンドの入り口かもしれません'
  );
}

// パターン③ しこり解消・出遅れ株 — 信用残が3ヶ月レンジの下位20%以内 / コンセンサスが会社予想より高い / 株価未反応
export const PATTERN3 = { lowLevelMaxPct: 20, consensusGapMax: -5, maxKairi: 5 };
export function laggingPatternSignal({ creditLevelPct, estimateProfit, consensusProfit, kairi }) {
  const c1 = creditLevelPct === null ? null : creditLevelPct <= PATTERN3.lowLevelMaxPct;
  let diffPct = null;
  if (Number.isFinite(estimateProfit) && Number.isFinite(consensusProfit) && consensusProfit !== 0) {
    diffPct = round1(((estimateProfit - consensusProfit) / Math.abs(consensusProfit)) * 100);
  }
  const c2 = diffPct === null ? null : diffPct <= PATTERN3.consensusGapMax;
  const c3 = kairi === null ? null : kairi < PATTERN3.maxKairi;
  return composePattern(
    [
      { ok: c1, text: condText('信用残水準', creditLevelPct, '%', c1) },
      { ok: c2, text: condText('コンセンサス差', diffPct, '%', c2) },
      { ok: c3, text: condText('乖離', kairi, '%', c3) },
    ],
    '需給はスカスカ。火がつければ一気に飛ぶ準備ができています'
  );
}

export const SECTOR_MOMENTUM = { hot: 1.5, hotGap: -0.5, laggingSector: 0.5, laggingGap: -1 };

// セクターの勢い — 当日騰落率 vs 業種当日騰落率
export function sectorMomentumSignal(changePct, sectorChangePct) {
  if (sectorChangePct === null || sectorChangePct === undefined) return { level: null, label: 'N/A', note: '業種騰落N/A' };
  if (!Number.isFinite(changePct)) return { level: null, label: 'N/A', note: '騰落率N/A' };
  const gap = round1(changePct - sectorChangePct);
  if (sectorChangePct > SECTOR_MOMENTUM.hot && gap > SECTOR_MOMENTUM.hotGap) {
    return { level: 'bad', label: '連れ高', note: `業種+${sectorChangePct}%・業種全体が上がりきっている` };
  }
  if (sectorChangePct > SECTOR_MOMENTUM.laggingSector && gap <= SECTOR_MOMENTUM.laggingGap) {
    return { level: 'good', label: '出遅れ', note: `業種+${sectorChangePct}%に対し銘柄${gap > 0 ? '+' : ''}${gap}pt・この銘柄だけ置いていかれている（狙い目）` };
  }
  return { level: 'warn', label: '中立', note: `業種${sectorChangePct > 0 ? '+' : ''}${sectorChangePct}%` };
}

// ==================================================================
// 全セクション共通の除外フィルター（ゴミ箱排除）
//
//  「表示してから警告する」のではなく「候補にすら上げない」。
//  ここで弾かれた銘柄はAMBUSH/SMART ENTRYどちらにも一切表示しない。
//  2段階に分けているのは、株価・流動性はkabukaページ1枚（Stage1で
//  既に取得済み）で判定でき追加コストが無いのに対し、赤字・債務超過は
//  決算ページの取得が要る（Stage2の候補にしか回さない）ため。
// ==================================================================
export const EXCLUDE = {
  minPrice: 300,                  // 倒産リスク・仕手性の高い低位株を除外
  minLiquidityYen: 100_000_000,   // 直近5日平均売買代金。買えても売れない銘柄を除外
  liquidityDays: 5,
};

// Stage1（kabukaページのみ）で判定できる除外条件
export function cheapExclusion({ price, closes, volumes }) {
  const reasons = [];
  if (price === null || price === undefined) reasons.push('株価N/A');
  else if (price < EXCLUDE.minPrice) reasons.push(`株価${price}円 < ${EXCLUDE.minPrice}円`);

  const n = EXCLUDE.liquidityDays;
  if (!closes || !volumes || closes.length < n || volumes.length < n) {
    reasons.push('流動性N/A');
  } else {
    const recentCloses = closes.slice(-n), recentVols = volumes.slice(-n);
    const avgYen = recentCloses.reduce((sum, c, i) => sum + c * (recentVols[i] ?? 0), 0) / n;
    if (avgYen < EXCLUDE.minLiquidityYen) {
      reasons.push(`5日平均売買代金${Math.round(avgYen / 1e4).toLocaleString()}万円 < ${EXCLUDE.minLiquidityYen / 1e8}億円`);
    }
  }
  return { excluded: reasons.length > 0, reasons };
}

// Stage2（決算ページ取得後）で判定する除外条件 — 赤字・債務超過
// latestOpProfit/equityRatioはkabutan.mjsのfetchFinance()が返す単位（百万円/%）のまま。
export function fundamentalExclusion({ latestOpProfit, equityRatio }) {
  const reasons = [];
  if (latestOpProfit !== null && latestOpProfit !== undefined && latestOpProfit < 0) {
    reasons.push(`直近営業損益が赤字(${latestOpProfit.toLocaleString()}百万円)`);
  }
  if (equityRatio !== null && equityRatio !== undefined && equityRatio <= 0) {
    reasons.push(`債務超過の疑い(自己資本比率${equityRatio}%)`);
  }
  return { excluded: reasons.length > 0, reasons };
}

// ------------------------------------------------------------------
// ハメ込み防止バッジ — 25日線乖離率+15%超は「一切表示しない」ではなく
// 「赤信号を出した上で表示する」。除外ではなく警告。
// ------------------------------------------------------------------
export const OVERHEAT_KAIRI = 15;

export function overheatSignal(kairi) {
  if (kairi === null || kairi === undefined) return { level: null, label: null, note: null };
  if (kairi > OVERHEAT_KAIRI) {
    return { level: 'bad', label: '過熱', note: `乖離+${kairi}%・超割高。今買うのは高値掴みの危険あり` };
  }
  return { level: null, label: null, note: null };
}

// グロース市場の急騰銘柄 — 時価総額の履歴は保有していないため、
// 直近30営業日の終値騰落率で代用する（発行株数が急変しなければ近似できる）。
export const GROWTH_MARKET = '東証Ｇ';
export const GROWTH_SURGE_PCT = 50;

export function growthSurgeSignal(market, closes) {
  if (market !== GROWTH_MARKET || !closes || closes.length < 20) return { level: null, label: null, note: null };
  const base = closes[0];
  if (!Number.isFinite(base) || base === 0) return { level: null, label: null, note: null };
  const pct = round1((closes.at(-1) / base - 1) * 100);
  if (pct >= GROWTH_SURGE_PCT) {
    return { level: 'bad', label: '急騰グロース', note: `直近1ヶ月+${pct}%・上がってもすぐ利確売りに押される重い株` };
  }
  return { level: null, label: null, note: null };
}

// ------------------------------------------------------------------
// 市場区分の日本語表記
// ------------------------------------------------------------------
export const MARKET_LABEL = { '東証Ｐ': 'プライム', '東証Ｓ': 'スタンダード', '東証Ｇ': 'グロース' };
export const marketLabel = (m) => MARKET_LABEL[m] ?? m ?? '市場N/A';

// ------------------------------------------------------------------
// 初心者向け：指標の平易な日本語訳
// ------------------------------------------------------------------
export function describeRsi(v) {
  if (v === null || v === undefined) return 'N/A';
  if (v <= 30) return '売られすぎ（底値圏）';
  if (v >= 70) return '買われすぎ（高値圏）';
  return '中立';
}

export function describeKairi(k) {
  if (k === null || k === undefined) return 'N/A';
  if (k <= -10) return '売られすぎ';
  if (k > OVERHEAT_KAIRI) return '超割高';
  if (k > 5) return 'やや割高';
  if (k < 0) return '割安';
  return '中立';
}

export function describeCross(cross) {
  if (!cross) return 'N/A';
  return cross.crossed ? '上昇トレンド開始' : '転換シグナルなし';
}

// ------------------------------------------------------------------
// ステータスランプ — 買い推奨/様子見/見送りの一言結論
// ------------------------------------------------------------------

// AMBUSH: スコアランクを軸に、過熱（ハメ込み）を最優先で見送りに落とす
//
//  ランクは日次スキャン時点のStage1（未織込）判定を前提に付いているが、
//  場中の価格再取得はランクを再計算しない。値動きが進んでStage1基準
//  （乖離≤+5%・RSI≤60・出来高Z≤0.5）を後から超えた銘柄まで「買い推奨」と
//  表示すると、期待値が織り込まれた株を仕込み時と誤認させてしまうため、
//  過熱ゲートと同様にここで先に弾く。
// ステータスランプの「悪化させる方向にしか働かない」重み付け。
// 以前は赤旗チェックを先に判定して即returnしていたため、ベースの結論が
// 既に「見送り」（rank D等）の銘柄でも、赤旗（信用過多等）が1つ見つかった
// 時点で「様子見」（見送りより甘い）に上書きされてしまうバグがあった
// （実測: 3038/3415がrank Dで本来「見送り」のところ、marginOverhangの
// 早期returnにより「様子見」表示になっていた）。ベース判定→赤旗は
// 「より悪い方向にだけ」動かす、の2段階に直して再発を防ぐ。
const VERDICT_SEVERITY = { buy: 0, hold: 1, avoid: 2 };

function worsen(current, candidateLevel, candidateLabel, candidateReason) {
  if (VERDICT_SEVERITY[candidateLevel] <= VERDICT_SEVERITY[current.level]) return current;
  return { level: candidateLevel, label: candidateLabel, reason: candidateReason };
}

export function ambushVerdict(r) {
  // 1. ベース判定（ランク・根拠のみ。赤旗はまだ見ない）
  let v;
  if (r.rank === 'S' || r.rank === 'A') {
    const top = r.catalysts?.[0]?.label;
    v = {
      level: 'buy', label: '買い推奨',
      reason: top ? `${top}という好材料があり、決算に向けて上昇余地があると判断しました` : 'テクニカル・需給ともに良好で、決算に向けて上昇余地があると判断しました',
    };
  } else if (r.rank === 'B' || r.rank === 'C') {
    v = { level: 'hold', label: '様子見', reason: '好材料はあるものの根拠がやや弱く、様子見が無難です' };
  } else {
    v = {
      level: 'avoid', label: '見送り',
      reason: r.evidence === false ? '先行カタリストが見当たらず、根拠不足のため見送り推奨です' : 'スコアが低く、積極的に狙う理由が乏しいです',
    };
  }

  // 2. 赤旗は「より悪い方向にだけ」ベースを上書きする。
  if (r.kairi !== null && r.kairi !== undefined && r.kairi > OVERHEAT_KAIRI) {
    v = worsen(v, 'avoid', '見送り', `乖離+${r.kairi}%は過熱圏。高値掴みのリスクが高いため見送り推奨です`);
  }
  const pricedIn = r.kairi !== null && r.rsi !== null && r.volZ !== null
    && r.kairi !== undefined && r.rsi !== undefined && r.volZ !== undefined
    && !stage1({ kairi: r.kairi, rsi: r.rsi, volZ: r.volZ }).pass;
  if (pricedIn) {
    v = worsen(v, 'hold', '様子見', `乖離${r.kairi}%・RSI${r.rsi}まで値動きが進み、未織込の基準を超えました。期待値が織り込まれつつあるため様子見が無難です`);
  }
  // 「連れ高」（業種全体が上がりきっている）・信用過多・売掛金の異常増加は
  // いずれも「様子見」相当の注意喚起。ベースが既に「見送り」ならそのまま。
  if (r.sectorLag?.level === 'bad') v = worsen(v, 'hold', '様子見', r.sectorLag.note);
  if (r.marginOverhang?.level === 'bad') v = worsen(v, 'hold', '様子見', r.marginOverhang.note);
  if (r.receivablesAnomaly?.level === 'bad') v = worsen(v, 'hold', '様子見', r.receivablesAnomaly.note);
  // 急騰グロース（グロース市場で直近1ヶ月+50%）は card() で赤チップとして
  // 出しているのに、以前はここで見ておらず「買い推奨」のまま矛盾しうる
  // 状態だった（SMART ENTRY側は元々見ていたのにAMBUSH側だけ抜けていた）。
  const growthSurge = growthSurgeSignal(r.market, r.closes);
  if (growthSurge.level === 'bad') v = worsen(v, 'hold', '様子見', growthSurge.note);

  return v;
}

// SMART ENTRY: 既に条件を満たしたパターンだけが並ぶので基本は買い推奨。
// AMBUSHと同じ「ベース判定→悪化方向のみ上書き」の2段階にしている
// （場中にパターンが崩れて「見送り」が妥当な銘柄が、赤旗の早期return
// によって「様子見」に上書きされる同種のバグを防ぐため）。
export function smartEntryVerdict(r, overheat, growthSurge) {
  const top = [r.sig1, r.sig2, r.sig3].find((s) => s?.level === 'good');
  // 場中の値動きでパターンが崩れ、3条件どれも「該当」でなくなることがある
  // （sig1〜3が再判定される場中ライブ更新後）。根拠が無いのに「複数の
  // シグナルが揃っています」と言い切るのは仕様書の方針に反するため、
  // その場合は見送りに落とす（買い推奨には絶対にしない）。
  let v = top
    ? { level: 'buy', label: '買い推奨', reason: top.note }
    : { level: 'avoid', label: '見送り', reason: '値動きが進み、選定時点の仕込みパターンにはもう該当しなくなりました' };

  // 過熱（乖離+15%超）はAMBUSH側でも「見送り」まで落とす最重要の赤旗
  // なので、同じ閾値・同じ関数(overheatSignal)を使うSMART ENTRY側も
  // 揃える（以前はここだけ「様子見」止まりで、同じ危険度の乖離が
  // セクションによって結論の重さが違うという矛盾があった）。
  if (overheat?.level === 'bad') v = worsen(v, 'avoid', '見送り', overheat.note);
  if (growthSurge?.level === 'bad') v = worsen(v, 'hold', '様子見', growthSurge.note);
  if (r.sectorLag?.level === 'bad') v = worsen(v, 'hold', '様子見', r.sectorLag.note);
  if (r.marginOverhang?.level === 'bad') v = worsen(v, 'hold', '様子見', r.marginOverhang.note);
  if (r.earningsWarning?.level === 'bad') v = worsen(v, 'hold', '様子見', r.earningsWarning.note);
  if (r.receivablesAnomaly?.level === 'bad') v = worsen(v, 'hold', '様子見', r.receivablesAnomaly.note);

  return v;
}

// ==================================================================
// 底打ち確認（＋α）— 「まだ下がるかも」という不安を裏付けデータで払拭する
// ための補助シグナル。いずれも除外条件ではなく、根拠を積み増す一言メモ。
// データが無い/判定できない場合は level:null（何も主張しない）を返す。
// ==================================================================

// ① セリングクライマックス（近似）
//
//  本来の歩み値（ティックデータ）による「機関投資家の大口約定」検出は、
//  kabutanが20分ディレイの日次データしか持たないため不可能。代わりに
//  「直近lookback営業日以内に、20日平均の何倍もの出来高を伴う大陰線
//  または長い下ヒゲが出たか」を株価の四本値から検出する近似値。
//  歩み値そのものではないことをnoteに明記する。
export const SELLING_CLIMAX = { lookback: 15, volRatioMin: 3, bigDownPct: 4, wickRatioMin: 0.4 };

export function sellingClimaxSignal({ opens, highs, lows, closes, volumes } = {}) {
  const n = closes?.length ?? 0;
  // kabutanのkabukaページは実測30営業日分しか返さないため、lookback(15)+21=36を
  // 要求すると常にnullになり判定不能になっていた（実データで確認済みのバグ）。
  // ループ側は既に「20日平均が組める日まで」で自然に打ち切るので、
  // ここでは最低ライン（直近1日分の判定に必要な21日）だけ要求すればよい。
  if (!opens || !highs || !lows || !volumes || n < 21) {
    return { level: null, label: null, note: null };
  }
  let best = null;
  for (let back = 0; back < SELLING_CLIMAX.lookback; back++) {
    const i = n - 1 - back;
    if (i < 20) break;
    const hist = volumes.slice(i - 20, i).filter(Number.isFinite);
    if (hist.length < 20 || !Number.isFinite(volumes[i])) continue;
    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    if (avg === 0) continue;
    const volRatio = volumes[i] / avg;
    if (volRatio < SELLING_CLIMAX.volRatioMin) continue;

    const o = opens[i], h = highs[i], l = lows[i], c = closes[i];
    if (![o, h, l, c].every(Number.isFinite) || o === 0) continue;
    const range = h - l;
    const bigDown = ((o - c) / o) * 100 >= SELLING_CLIMAX.bigDownPct;
    const lowerWick = range > 0 && (Math.min(o, c) - l) >= range * SELLING_CLIMAX.wickRatioMin;
    if (!bigDown && !lowerWick) continue;

    if (!best || volRatio > best.volRatio) best = { back, volRatio: round1(volRatio), bigDown, lowerWick };
  }
  if (!best) return { level: null, label: null, note: null };
  const shape = best.bigDown && best.lowerWick ? '大陰線+長い下ヒゲ' : best.bigDown ? '大陰線' : '長い下ヒゲ';
  return {
    level: 'good', label: '底打ち観測',
    note: `${best.back}営業日前に平均${best.volRatio}倍の出来高を伴う${shape}（セリングクライマックスの可能性。歩み値の大口約定ではなく四本値からの近似判定）`,
  };
}

// ② ネットネット判定（簡易・現金ベース）
//
//  本来は (現預金＋売掛金×0.75)－負債総額 と時価総額を比較するが、
//  kabutanの決算ページに売掛金の内訳が無いため、保守的に現金等残高の
//  みで判定する簡易版（本来の基準より厳しい＝ネットネットと出た銘柄は
//  より確度が高い）。
// receivables（売上債権＝売掛金＋受取手形）はkabutanに無いため、
// IR Bank（irbank.mjs）から取れたときだけ本来の式
// (現預金＋売掛金×0.75)－負債総額 を使う。取れなければ現金だけの
// 簡易版（より保守的＝厳しい基準）にフォールバックする。
export const NET_NET_RECEIVABLES_HAIRCUT = 0.75;

export function netNetSignal({ cash, totalAssets, equity, marketCap, receivables } = {}) {
  if (![cash, totalAssets, equity, marketCap].every(Number.isFinite) || marketCap <= 0) {
    return { level: null, label: null, note: null };
  }
  const liabilities = totalAssets - equity;
  const hasReceivables = Number.isFinite(receivables);
  const netAssets = hasReceivables
    ? cash + receivables * NET_NET_RECEIVABLES_HAIRCUT - liabilities
    : cash - liabilities;
  const ratio = netAssets / marketCap;
  const basis = hasReceivables ? '現預金+売掛金×0.75-負債' : '現預金-負債(簡易版・売掛金データ無し)';
  if (ratio >= 1) {
    return {
      level: 'good', label: '解散価値割れ',
      note: `${basis}が時価総額の${round1(ratio * 100)}%・会社を今すぐ解散して資産を分けた方が株価より高い計算です。事業の価値はほぼ0円評価されており、下値は極めて限定的とみられます`,
    };
  }
  if (ratio >= 0.7) {
    return {
      level: 'warn', label: '解散価値に接近',
      note: `${basis}が時価総額の${round1(ratio * 100)}%まで接近・株価がもう一段下がると解散価値割れの水準です`,
    };
  }
  return { level: null, label: null, note: null };
}

// ②' 業種内での相対的な割安度（PBRが業種平均以下）
//
//  「1日30分の銘柄調査ルーティン」の下値チェックはネットネットだけでは
//  ほぼ発動しない（実測: AMBUSH候補21銘柄中0件）。ネットネットに次ぐ
//  下値の目安として、ユーザー提示の元の項目「PBRが業種平均以下」を
//  追加する。個別銘柄PBR(kabutan.mjsのparseMain)・業種平均PBR
//  (fetchSectorMomentumの同じページに実は入っていた列)はどちらも
//  既存の取得済みページから取れるため追加リクエストは無い。
export const LOW_PBR = { goodRatio: 0.7, warnRatio: 1 };

export function lowPbrSignal({ pbr, sectorPbr } = {}) {
  if (!Number.isFinite(pbr) || !Number.isFinite(sectorPbr) || sectorPbr <= 0) {
    return { level: null, label: null, note: null };
  }
  const ratio = round1((pbr / sectorPbr) * 100);
  if (pbr / sectorPbr <= LOW_PBR.goodRatio) {
    return {
      level: 'good', label: '業種内で割安',
      note: `PBR${pbr}倍・業種平均${sectorPbr}倍の${ratio}%。業種内で相対的に割安な水準です`,
    };
  }
  if (pbr / sectorPbr <= LOW_PBR.warnRatio) {
    return { level: 'warn', label: '業種平均並み', note: `PBR${pbr}倍・業種平均${sectorPbr}倍の${ratio}%` };
  }
  return { level: null, label: null, note: null };
}

// ③ 配当利回りの下限サポート
export const DIVIDEND_FLOOR = { strong: 4, watch: 3 };

export function dividendYieldFloorSignal(yieldPct) {
  if (!Number.isFinite(yieldPct)) return { level: null, label: null, note: null };
  if (yieldPct >= DIVIDEND_FLOOR.strong) {
    return { level: 'good', label: '配当下限', note: `配当利回り${yieldPct}%・4%超は機関投資家の買いが入りやすい水準です` };
  }
  if (yieldPct >= DIVIDEND_FLOOR.watch) {
    return { level: 'warn', label: '配当下限接近', note: `配当利回り${yieldPct}%・もう一段下がれば下支えが期待できる水準です` };
  }
  return { level: null, label: null, note: null };
}

// ④ 踏み上げ狙い（信用残の解消）
//
//  信用買い残が減り（個人の投げ売りが進み）、逆に信用売り残（空売り）が
//  増えている＝将来「買い戻さざるを得ない」需要が積み上がっている状態。
export function shortSqueezeSignal(weekly) {
  const buyTrendPct = creditTrend(weekly);
  const sellTrendPct = shortTrend(weekly);
  if (buyTrendPct === null || sellTrendPct === null) return { level: null, label: null, note: null };
  if (buyTrendPct < 0 && sellTrendPct > 0) {
    return {
      level: 'good', label: '踏み上げ狙い',
      note: `信用買い残4週比${buyTrendPct}%・空売り(売り残)4週比+${sellTrendPct}%。個人の投げが進み空売りが積み上がっており、戻りで買い戻し需要が出やすい状態です`,
    };
  }
  return { level: null, label: null, note: null };
}

// ⑥ 信用過多（買い方の過密）警告
//
//  パターン②は信用倍率<3を条件の1つにしているが、それはあくまで
//  「トレンド転換パターンとして該当するか」の判定であって、他の
//  パターン(①③)で該当した銘柄の信用倍率が高くても警告されない。
//  信用倍率が非常に高い（買い方が積み上がっている）銘柄は、上昇時に
//  含み益確定売りが出やすく上値が重くなりがちなので、該当パターンに
//  関わらず一般的な注意喚起として出す（除外ではなく警告）。
export const MARGIN_OVERHANG = { heavy: 10 };

export function marginOverhangSignal(loanRatio) {
  if (loanRatio === null || loanRatio === undefined) return { level: null, label: null, note: null };
  if (loanRatio >= MARGIN_OVERHANG.heavy) {
    return {
      level: 'bad', label: '信用過多',
      note: `信用倍率${loanRatio}倍・買い方の含み益が積み上がっており、上昇時に利益確定売りに押されて上値が重くなりやすい状態です`,
    };
  }
  return { level: null, label: null, note: null };
}

// ⑦ 決算間近の警告（地雷回避）
//
//  SMART ENTRYは決算スケジュールを見ずに需給・乖離だけで選ぶ設計だが、
//  「決算発表の直前は新規エントリーを避ける」のは需給とは独立した
//  一般的なリスク管理ルールなので、該当パターンとは別枠で警告する。
//  除外はしない（AMBUSHと違い決算日が分からない銘柄も多いため）。
export const EARNINGS_WARNING_DAYS = 5;

export function earningsProximitySignal(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return { level: null, label: null, note: null };
  if (daysLeft >= 0 && daysLeft <= EARNINGS_WARNING_DAYS) {
    return {
      level: 'bad', label: '決算間近',
      note: `決算まであと${daysLeft}日。地雷回避の原則から、決算をまたぐ新規エントリーは避けるのが無難です`,
    };
  }
  return { level: null, label: null, note: null };
}

// ⑧ 売掛金（売上債権）の異常増加チェック
//
//  「1日30分の銘柄調査ルーティン」の財務チェック項目。売上債権の伸びが
//  売上高の伸びを大きく上回っている場合、回収遅延・在庫化・販売条件の
//  緩和（押し込み販売）などが疑われる。年度決算ベースの前期比成長率
//  同士を比較する（kabutan: revenueGrowth、IR Bank: receivablesGrowth）。
//  どちらか一方でも取得できなければnull（推測で判定しない）。
export const RECEIVABLES_ANOMALY = { ratioWarn: 1.5, ratioBad: 2 };

export function receivablesAnomalySignal({ revenueGrowthPct, receivablesGrowthPct } = {}) {
  if (!Number.isFinite(revenueGrowthPct) || !Number.isFinite(receivablesGrowthPct)) {
    // データ不足で「判定できない」状態。level:nullの「異常なし」と
    // 呼び出し側が混同しないよう checked:false で明示的に区別する。
    return { level: null, label: null, note: null, checked: false };
  }
  // 売上が横ばい/減収なのに売掛金が増えているのは特に強い警戒サイン。
  if (revenueGrowthPct <= 0 && receivablesGrowthPct > 5) {
    return {
      level: 'bad', label: '売掛金急増', checked: true,
      note: `売上高${revenueGrowthPct > 0 ? '+' : ''}${revenueGrowthPct}%に対し売上債権+${receivablesGrowthPct}%。売上が伸びていないのに売掛金だけ膨らんでおり、回収遅延の懸念があります`,
    };
  }
  if (revenueGrowthPct > 0) {
    const ratio = round1(receivablesGrowthPct / revenueGrowthPct);
    if (ratio >= RECEIVABLES_ANOMALY.ratioBad) {
      return {
        level: 'bad', label: '売掛金急増', checked: true,
        note: `売上高+${revenueGrowthPct}%に対し売上債権+${receivablesGrowthPct}%（売上の${ratio}倍のペース）。回収サイクルの長期化や押し込み販売の懸念があります`,
      };
    }
    if (ratio >= RECEIVABLES_ANOMALY.ratioWarn) {
      return {
        level: 'warn', label: '売掛金やや増加', checked: true,
        note: `売上高+${revenueGrowthPct}%に対し売上債権+${receivablesGrowthPct}%（売上の${ratio}倍のペース）。決算での運転資本の動きは確認しておきたいところです`,
      };
    }
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑤ 出遅れ修正（セクターローテーション、複数日トレンド版）
//
//  既存の sectorMomentumSignal は「今日1日」の業種騰落率としか比べない。
//  こちらは sector_history.mjs に積み上がった業種の直近複数営業日の
//  累積騰落率を見て、「業種は既に反発トレンドに入っているのに、
//  この銘柄はまだ値動きに反映されていない」出遅れを判定する。
//  履歴が足りない（仕組みを入れてから日数が浅い）うちはnullを返す。
export const SECTOR_ROTATION = { trendDays: 5, sectorMinPct: 3 };

export function sectorRotationSignal({ sectorTrendPct, kairi, cross } = {}) {
  if (sectorTrendPct === null || sectorTrendPct === undefined) return { level: null, label: null, note: null };
  if (sectorTrendPct < SECTOR_ROTATION.sectorMinPct) return { level: null, label: null, note: null };
  const stockNotYetTurned = (kairi !== null && kairi !== undefined && kairi < 0) || (cross ? cross.crossed !== true : true);
  if (!stockNotYetTurned) return { level: null, label: null, note: null };
  return {
    level: 'good', label: '出遅れ修正待ち',
    note: `同業種は直近${SECTOR_ROTATION.trendDays}営業日で+${sectorTrendPct}%と既に反発トレンドに入っていますが、この銘柄はまだ値動きに反映されていません。業種全体に資金が向かえば遅れて買われる可能性があります`,
  };
}
