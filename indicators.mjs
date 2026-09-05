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
// （旧）エントリー健康診断 — 大型株WATCHLIST専用の「4つの信号」
//
//  ここにあった valueSignal（お買い得度）・creditSignal（上値の重さ）は
//  SMART ENTRY化（コミットdec2509）で呼び出し側だけ削除され、長期間
//  デッドコード化していたのを発見。復活はさせず削除した — 復活すると
//  現行の overheatSignal（乖離+15%）・marginOverhangSignal（信用倍率
//  10倍）と同じ指標を別の閾値（乖離+10%・信用倍率6倍）で二重に判定する
//  ことになり、同じ銘柄で「過熱」と「過熱でない」のような矛盾した表示が
//  再発しかねない（実測: creditFloatSignalとmarginOverhangSignalの矛盾を
//  同日に修正したばかり）。同じ枠にあったconsensusTrapSignal（期待値の
//  ワナ）だけは他の現行シグナルと重複しない独自の判定だったため、
//  screener.mjsに配線し直して復活させた。
// ------------------------------------------------------------------

export const CONSENSUS_TRAP = { tooHigh: -5, tooLow: 5 };

// コンセンサス（アナリスト予想）が実在するかの判定。consensusProfit===0は
// SBI側の「未算出」を意味し「予想利益0円」ではないため除外する。
//
// ■ なぜ関数として括り出したか
// 同じ式 `Number.isFinite(consensusProfit) && consensusProfit !== 0` が
// indicators.mjs(consensusTrapSignal/hiddenGemSignal)とscraper.mjs
// (bottomChips/buyRuleChecklist/consensusEvidenceBlock)の計5箇所に
// 独立にコピーされていた。「コンセンサス有り」の定義を変える（例:
// 0を有効値として扱うようにする）場合、5箇所すべてを見つけて直さないと
// 判定がズレる危険な状態だったため、単一の情報源に統一した。
export function hasConsensusProfit(consensusProfit) {
  return Number.isFinite(consensusProfit) && consensusProfit !== 0;
}

// 期待値のワナ — 会社予想 vs 市場コンセンサス
//
// ■ 発掘の経緯（再発防止の一環）
// この関数はWATCHLIST時代（エントリー健康診断カード）で実際に使われて
// いたが、SMART ENTRY への置き換え（コミットdec2509）で呼び出し側だけ
// 削除され、関数定義だけが取り残されて長期間デッドコード化していた。
// 「会社予想がコンセンサス比-5%以下＝期待過剰（上方修正しても届かず
// 暴落する危険地帯）」「+5%以上＝期待薄（跳ねる可能性）」という判定は
// buyRuleChecklistの「期待値」行（|diff|<=10%かどうかの対称なOK/NG）
// では代替できない非対称な判断で、AMBUSHの加点/減点にも一切使われて
// いなかった。CHIP_SIGNAL_FIELDS/AMBUSH_BONUS・PENALTY_FIELDSに配線し
// 直す（screener.mjs）。
export function consensusTrapSignal(estimateProfit, consensusProfit) {
  if (!Number.isFinite(estimateProfit) || !Number.isFinite(consensusProfit) || consensusProfit === 0) {
    // 会社予想とコンセンサスは欠ける原因が別（前者はSBI決算カレンダー側の
    // 未収録、後者はアナリスト非カバー）なので、どちらが実際に欠けている
    // かで文言を分ける。両方欠けている場合のみ「コンセンサスN/A」と言うと、
    // コンセンサスはあるのに会社予想が無いだけの銘柄まで誤って「コンセン
    // サスが無い」と伝えてしまう。「会社が通期予想を非開示」と断定する
    // のも誤り（実測: 7921はkabutanの決算ページには来期予想の数値が
    // 載っているのに、SBI側のカレンダーには収録されていなかった）ため、
    // 原因を決めつけず「このデータソースには無い」という事実だけを伝える。
    const hasEstimate = Number.isFinite(estimateProfit);
    const hasConsensus = hasConsensusProfit(consensusProfit);
    const note = !hasEstimate && hasConsensus ? '会社予想N/A（決算カレンダーに未収録）'
      : hasEstimate && !hasConsensus ? 'コンセンサスN/A'
      : '会社予想・コンセンサス共にN/A';
    return { level: null, label: 'N/A', note, checked: false };
  }
  const diffPct = Math.round(((estimateProfit - consensusProfit) / Math.abs(consensusProfit)) * 1000) / 10;
  if (diffPct <= CONSENSUS_TRAP.tooHigh) {
    return { level: 'bad', label: '期待過剰', checked: true, note: `会社予想がコンセンサス比${diffPct}%・上方修正しても予想に届かず暴落する危険地帯` };
  }
  if (diffPct >= CONSENSUS_TRAP.tooLow) {
    return { level: 'good', label: '期待薄', checked: true, note: `会社予想がコンセンサス比+${diffPct}%・ちょっと良い数字が出るだけで跳ねる可能性` };
  }
  return { level: 'warn', label: '中立', checked: true, note: `コンセンサス比${diffPct > 0 ? '+' : ''}${diffPct}%` };
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

// 直近 period 営業日（既定60日≒3ヶ月）の終値レンジの中で今の株価がどの
// 位置か（0%=期間最安値・100%=期間最高値）。creditLevelVsRangeと同じ
// 考え方だが、closesは古い→新しい順（weeklyは新しい→古い順）と並びが
// 逆なので取り出し方が異なる点に注意。retailExpectationSignalの
// 「既に高値圏か」の判定に使う。
export function priceLevelVsRange(closes, period = 60) {
  const w = (closes ?? []).slice(-period).filter(Number.isFinite);
  if (w.length < period) return null;
  const latest = w.at(-1), min = Math.min(...w), max = Math.max(...w);
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
  const note = conds.map((c) => c.text).join(' / ');
  const known = conds.filter((c) => c.ok !== null);
  if (conds.every((c) => c.ok === true)) return { level: 'good', label: '該当', note: matchedNote };
  // 既知の条件のうち1つでも明確に「不一致」なら、残りの条件が未取得でも
  // 「該当しない」と確定できる（AND条件なので1つでも満たさなければ
  // 他がどうであれ該当し得ない）。これを見ずに「未知が1つでもあれば
  // 一律N/A」としていたため、実際には根拠があるのに「総不明」と誤表示
  // していた（実測: 9052山陽電鉄のパターン③は信用残水準100%で明確に
  // 条件を満たさないのに、コンセンサス差が未取得というだけで「N/A」
  // 表示になっていた）。
  //
  // 「非該当」（既知の条件だけで確定的に不一致と判定できた）と「N/A」
  // （何一つ判定材料が無い）は、どちらもlevel:nullにしていたため
  // scraper.mjsのsignalRow（🟢🟡🔴⚪の信号表示）ではどちらも同じ⚪灰色
  // になり、「確定的に該当しない」という積極的な結論と「何も分からない」
  // という無情報が視覚的に区別できていなかった（実測: ユーザーから
  // 「信号の赤色が機能していない」との指摘。SIG_EMOJI/SIG_CLASSに
  // bad:'🔴'/'red'の定義はあったが、composePatternが'bad'を一切返さない
  // ため到達不能なデッドコードになっていた）。「非該当」を専用の
  // level:'none'にし、signalRow側で🔴（確定的に非該当＝見送り）として
  // 扱う。matched集計（level==='good'のみ数える）には影響しない。
  if (known.some((c) => c.ok === false)) return { level: 'none', label: '非該当', note };
  if (known.length > 0) return { level: 'partial', label: '一部該当（データ不足）', note };
  return { level: null, label: 'N/A', note };
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

// AMBUSH向けの時価総額上限（ユーザー提案: 良品計画・しまむらのような
// 大型株が「決算前の待ち伏せ」候補として上位に出てくるのはノイズという
// 指摘への対応）。テンバガー候補（tenbaggerSignal/midCapGrowthSignal）
// とは別の判定軸であり、AMBUSH自体の逆張り・決算前待ち伏せロジックは
// 変更しない。marketCap/maxMarketCapは呼び出し側の単位（JP:百万円/
// US:百万USD）のまま渡せば良い（通貨非依存）。
export function marketCapExclusion({ marketCap, maxMarketCap }) {
  const reasons = [];
  if (Number.isFinite(marketCap) && Number.isFinite(maxMarketCap) && marketCap > maxMarketCap) {
    reasons.push(`時価総額${Math.round(marketCap).toLocaleString()} > 上限${maxMarketCap.toLocaleString()}`);
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
// v7.3改修（ユーザー指示書 項目12）: 「買い推奨」という断定的な3段階
// （買い推奨/様子見/見送り）を廃止し、5段階に拡張する。strong_buyは
// Phase 1-B（buyScore導入後）まではambushVerdict/smartEntryVerdictから
// 実際に返されることは無いが、severityの並び自体は先に用意しておく。
// priced_in_caution（🟠織り込み警戒）は「見送り」ほど重くない、
// 「期待が既に株価に織り込まれつつある」ことに特化した中間段階
// （既存のrepricingLag priced_in判定・決算間近の判定をここに再マップ）。
// scraper.mjs側のソート（byVerdict/VERDICT_ORDER）でも同じ重大度順序を
// 使うため export する（以前は3段階の頃からscraper.mjs側に別コピーが
// 2箇所あり、5段階化で更新を1箇所忘れるとNaN比較でソートが壊れる
// リスクがあった。単一の情報源に統一する）。
export const VERDICT_SEVERITY = { strong_buy: 0, buy: 1, hold: 2, priced_in_caution: 3, avoid: 4 };
const VERDICT_LABEL = {
  strong_buy: '🔥 強い買い候補', buy: '🟢 買い候補', hold: '🟡 様子見',
  priced_in_caution: '🟠 織り込み警戒', avoid: '🔴 見送り',
};
// screener.mjs/us_screener.mjsのWINDOW.sweetMin/US_WINDOW.sweetMinと同じ値
// （14日）。indicators.mjsはscreener.mjsからimportされる側のため、循環
// importを避けてここに複製する（WINDOW定数自体を変えたらここも合わせる）。
const NEAR_EARNINGS_MIN_DAYS = 14;

// v7.3改修: labelをVERDICT_LABELから自動的に引くようにし（呼び出し側で
// 手書きの文字列を渡さない）、level/labelの綴りが食い違うリスクを消す
// （単一の情報源パターン。今回5段階に増やすタイミングで統一した）。
function worsen(current, candidateLevel, candidateReason) {
  if (VERDICT_SEVERITY[candidateLevel] <= VERDICT_SEVERITY[current.level]) return current;
  return { level: candidateLevel, label: VERDICT_LABEL[candidateLevel], reason: candidateReason };
}

// ------------------------------------------------------------------
// 「底打ち確認」チップとして画面に出す全シグナルの一覧（単一の情報源）。
//
// ■ 再発防止の経緯
// growthSurgeSignal・上場廃止(スクイーズアウト)は、カード側で赤チップと
// して表示されているのに、verdict計算（ambushVerdict）側にその判定を
// 追加し忘れており、「赤チップが出ているのに買い推奨」という矛盾が
// 2回実際に発生した（このセッションで発見・修正済み）。原因は「表示する
// シグナルの一覧」と「verdictを悪化させるシグナルの一覧」が別々の場所に
// 手書きで重複していたこと。ここに列挙した r のフィールド名は
// scraper.mjsのbottomChips()（チップ表示）とambushVerdict/
// smartEntryVerdict（verdict計算）の両方から参照する単一の情報源にし、
// 新しいシグナルを追加するときはここに1行足すだけで両方に自動的に
// 反映されるようにする。
//
// ※ overheat（乖離+15%超）・growthSurge（急騰グロース）・上場廃止
// （r.warningsの内容チェック）は、r[key].levelの単純な参照ではなく
// 追加の計算や別データ（kairi/market/closes/warnings）を要するため、
// このリストには含めず、ambushVerdict/smartEntryVerdict内で個別に
// 判定している。この3つを増やす・変えるときは、そのすぐ下のコメントに
// 「チップ表示側と対応させること」という注意書きがあるので、必ず両方を
// 同時に直すこと。
export const CHIP_SIGNAL_FIELDS = [
  'climax', 'netNet', 'lowPbr', 'pbrHistoricalLow', 'dividendPeak', 'hiddenGem', 'divFloor', 'squeeze',
  'institutionalShort', 'majorShareholder', 'sectorLag', 'sectorRotation', 'marginOverhang', 'earningsWarning',
  'receivablesAnomaly', 'retailExpectation', 'progressStreak', 'dividendPotential', 'hiddenAsset', 'creditFloat',
  'consensusTrap',
];

// コンセンサス（アナリスト予想）が無い銘柄のカードでは、「未来の期待値」
// ではなく「過去の事実」に基づくチップ（解散価値・PBR・配当・お宝候補）を
// 優先して先頭に並べる（scraper.mjsのbottomChipsが参照する）。
export const VALUATION_CHIP_FIELDS = ['hiddenGem', 'netNet', 'lowPbr', 'pbrHistoricalLow', 'dividendPeak'];

// CHIP_SIGNAL_FIELDS のうち、実際に level:'bad' が付いているものだけを返す。
export function badChipSignals(r) {
  return CHIP_SIGNAL_FIELDS.map((k) => r[k]).filter((s) => s && s.level === 'bad');
}

// retailExpectationがwarn段階のとき、結論の理由に必ず一言補足する
// （ambushVerdict/smartEntryVerdictの両方から使う単一の情報源。以前は
// 同じ文言を2箇所に個別に書いており、将来どちらか一方だけ文言を直して
// 食い違う抜けが起きうる状態だった）。呼び出し側でworsen()呼び出しが
// 全て終わった最後に呼ぶことで、途中のworsen()による上書きで消えない
// ようにする。
function appendRetailExpectationCaution(v, r) {
  if (r.retailExpectation?.level !== 'warn') return v;
  return { ...v, reason: `${v.reason}。${r.retailExpectation.label}：株価や信用買い残の動きから、好材料への期待の一部が既に株価に織り込まれつつある可能性があります` };
}

export function ambushVerdict(r) {
  // 1. ベース判定（ランク・根拠のみ。赤旗はまだ見ない）
  let v;
  if (r.rank === 'S' || r.rank === 'A') {
    const top = r.catalysts?.[0]?.label;
    v = {
      level: 'buy', label: VERDICT_LABEL.buy,
      reason: top ? `${top}という好材料があり、決算に向けて上昇余地があると判断しました` : 'テクニカル・需給ともに良好で、決算に向けて上昇余地があると判断しました',
    };
  } else if (r.rank === 'B' || r.rank === 'C') {
    v = { level: 'hold', label: VERDICT_LABEL.hold, reason: '好材料はあるものの根拠がやや弱く、様子見が無難です' };
  } else {
    v = {
      level: 'avoid', label: VERDICT_LABEL.avoid,
      reason: r.evidence === false ? '先行カタリストが見当たらず、根拠不足のため見送り推奨です' : 'スコアが低く、積極的に狙う理由が乏しいです',
    };
  }

  // 2. 赤旗は「より悪い方向にだけ」ベースを上書きする。
  if (r.kairi !== null && r.kairi !== undefined && r.kairi > OVERHEAT_KAIRI) {
    v = worsen(v, 'avoid', `乖離+${r.kairi}%は過熱圏。高値掴みのリスクが高いため見送り推奨です`);
  }
  const pricedIn = r.kairi !== null && r.rsi !== null && r.volZ !== null
    && r.kairi !== undefined && r.rsi !== undefined && r.volZ !== undefined
    && !stage1({ kairi: r.kairi, rsi: r.rsi, volZ: r.volZ }).pass;
  if (pricedIn) {
    v = worsen(v, 'priced_in_caution', `乖離${r.kairi}%・RSI${r.rsi}まで値動きが進み、未織込の基準を超えました。期待値が既に織り込まれつつあります`);
  }
  // 「連れ高」（業種全体が上がりきっている）・信用過多・売掛金の異常増加
  // など、bottomChips()に出る赤チップ全てを一括で見る（CHIP_SIGNAL_FIELDS
  // 参照）。新しいシグナルをbottomChipsに追加すれば、ここにも手を加える
  // ことなく自動的に反映される（配線忘れの再発防止）。
  for (const s of badChipSignals(r)) {
    v = worsen(v, 'hold', s.note);
  }
  // 急騰グロース（グロース市場で直近1ヶ月+50%）は card() で赤チップとして
  // 出しているのに、以前はここで見ておらず「買い推奨」のまま矛盾しうる
  // 状態だった（SMART ENTRY側は元々見ていたのにAMBUSH側だけ抜けていた）。
  // ※ この判定はCHIP_SIGNAL_FIELDSに含まれていない（r.market/r.closesから
  // 計算する必要があるため）。チップ表示側（card()）を変えるときはここも
  // 必ず対応させること。
  const growthSurge = growthSurgeSignal(r.market, r.closes);
  if (growthSurge.level === 'bad') v = worsen(v, 'hold', growthSurge.note);

  // スクイーズアウトによる上場廃止決定は「決算カタリストで株価が動く」
  // というAMBUSHの前提そのものを壊す（株価は買収価格に固定され、以後
  // 決算に反応しなくなる）。ランクがどれだけ高くても必ず見送りにする
  // （実測: 3480ジェイ・エス・ビーはランクCで様子見のまま表示されて
  // いたが、2026-08-10にスクイーズアウト決定が開示されていた）。
  // ※ この判定もCHIP_SIGNAL_FIELDSに含まれていない（r.warningsの中身を
  // 検索する必要があるため）。warnChips（scraper.mjs）の表示条件を
  // 変えるときはここも必ず対応させること。
  const delisting = r.warnings?.find((w) => w.label?.includes('上場廃止'));
  if (delisting) v = worsen(v, 'avoid', `${delisting.title}。上場廃止が決定しており、決算カタリストによる株価反応はもう見込めません`);

  // 実測バグ（ユーザー報告: 米国株ALOYがSCORE 70・rank Aで1位表示なのに、
  // カード内の仕込み妙味スコア（repricingLagBlockのwhyNote）は
  // 「新規の仕込み対象としては見送り推奨です」と明記しており、順位と
  // 結論が矛盾していた）。repricingLagScoreのオーバーライドルール
  // （直近急騰でzone:'priced_in'）はambushVerdictに一切配線されて
  // おらず、verdictBlockの公式な結論とrepricingLagBlockの説明文が
  // 別々に矛盾したメッセージを出せる状態だった。zone:'priced_in'が
  // 確定的に判定できた（checked:true）場合は、repricingLagBlockの文言と
  // 整合させるため見送りまで落とす。r.repricingLagが無いオブジェクト
  // （SMART ENTRY等）ではoptional chainingにより何もしない。
  if (r.repricingLag?.checked && r.repricingLag.zone === 'priced_in') {
    v = worsen(v, 'priced_in_caution', `直近1ヶ月・3ヶ月の株価上昇により仕込み妙味スコアが「織り込み済み」（オーバーライドルール発動）。新規の仕込み対象としては様子見〜織り込み警戒が妥当です`);
  }

  // v7.3改修（ユーザー指示書 項目4）: 「決算直前は買い時ではなく織り込み
  // 警戒を強める」。AMBUSH NOWの下限を14日→7日に広げたため、7〜13日
  // （決算直前・sweetMinの外側）は「まだ狙い目の核ではない」ことを
  // verdictにも反映する。daysLeftが無い呼び出し元（SMART ENTRY等）は
  // 対象外。
  if (Number.isFinite(r.daysLeft) && r.daysLeft >= 0 && r.daysLeft < NEAR_EARNINGS_MIN_DAYS) {
    v = worsen(v, 'priced_in_caution', `決算まであと${r.daysLeft}日と間近で、決算リスク自体が高まっています。新規の仕込みには織り込み警戒が必要な時期です`);
  }

  // retailExpectationSignal（個人投資家の期待織り込み）がbad段階なら
  // badChipSignalsのループで既にreasonが書き換わっている。warn段階は
  // 単独で「買い推奨」を覆すほどの赤旗ではないが、「良い会社」と
  // 「まだ株価に織り込まれていない良い会社」を見分けるための重要な
  // 文脈なので、結論の理由に必ず一言添える（ユーザー要望: 「買い推奨や
  // 様子見のところにもう少し結論の説明が欲しい」）。
  v = appendRetailExpectationCaution(v, r);

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
    ? { level: 'buy', label: VERDICT_LABEL.buy, reason: top.note }
    : { level: 'avoid', label: VERDICT_LABEL.avoid, reason: '値動きが進み、選定時点の仕込みパターンにはもう該当しなくなりました' };

  // 過熱（乖離+15%超）はAMBUSH側でも「見送り」まで落とす最重要の赤旗
  // なので、同じ閾値・同じ関数(overheatSignal)を使うSMART ENTRY側も
  // 揃える（以前はここだけ「様子見」止まりで、同じ危険度の乖離が
  // セクションによって結論の重さが違うという矛盾があった）。
  // ※ overheat/growthSurgeはCHIP_SIGNAL_FIELDSに含まれていない
  // （r.kairi/r.market/r.closesから計算するため、呼び出し側で
  // 事前計算して渡している）。card()側の表示条件を変えるときは
  // ここも必ず対応させること。
  if (overheat?.level === 'bad') v = worsen(v, 'avoid', overheat.note);
  if (growthSurge?.level === 'bad') v = worsen(v, 'hold', growthSurge.note);
  // bottomChips()に出る赤チップ全てを一括で見る（CHIP_SIGNAL_FIELDS参照）。
  // 新しいシグナルをbottomChipsに追加すれば、ここにも手を加えることなく
  // 自動的に反映される（配線忘れの再発防止）。
  for (const s of badChipSignals(r)) {
    v = worsen(v, 'hold', s.note);
  }

  // ambushVerdictと同じ理由でwarn段階を結論の理由に必ず補足する
  // （ユーザー要望。文言はappendRetailExpectationCautionに一本化し、
  // 2箇所で個別に書いて将来食い違う抜けを防ぐ）。
  v = appendRetailExpectationCaution(v, r);

  return v;
}

// ==================================================================
// v7.3改修（ユーザー指示書 項目1/2/7/19）: BUY SCORE / EXPECTATION SCORE /
// EARNINGS SURPRISE SCOREの3分割と、DATA/CONFIDENCE分離＋Effective Score。
//
//  「銘柄そのものが良いか」（EXPECTATION）と「今この瞬間に仕込む価値が
//  あるか」（BUY）と「次の決算で市場予想を上回りそうか」（SURPRISE）を
//  混同しない、というユーザー方針に対応する。新規データ取得はせず、
//  既存の信号（score/repricingLag/consensusTrap/daysLeft/netNet等）を
//  5要素・3要素にそれぞれ再配点する。JP/US双方から呼べるよう、raw値
//  ではなく{value:0-100,note}形式のpartsを受け取る（screener.mjs:
//  composite()と同じgot/max正規化パターン）。
//
//  ■ JP/US差分の吸収は呼び出し側（各screener.mjs）の責務
//  US側にはconsensusTrap/progressStreak/hasMonthly等が存在しないため、
//  該当partsはnull（未計算）になる。それ自体はconfidenceの低下として
//  正しく反映され、「データが少ない銘柄が不当に有利にならない」という
//  項目7の方針とも整合する。
// ------------------------------------------------------------------

function weightedComposite(parts, weights) {
  let got = 0, max = 0;
  const detail = {};
  for (const [k, w] of Object.entries(weights)) {
    const p = parts[k];
    detail[k] = p ?? null;
    if (p && Number.isFinite(p.value)) { got += (p.value / 100) * w; max += w; }
  }
  if (max === 0) return { score: null, confidence: 0, detail };
  return { score: Math.round((got / max) * 100), confidence: Math.round(max), detail };
}

export const BUY_SCORE_WEIGHTS = { expectedReturn: 30, unpriced: 25, surprise: 20, timing: 15, quality: 10 };
// 改修指示書 項目2「財務リスク・希薄化リスク・信用過熱・会計リスク・
// 業績悪化などをリスクペナルティとして反映する」: BUY SCOREはこれまで
// 100点配点の合成だけで、リスク側は一切減点していなかった（重大な
// リスクは既にworsen()でverdictを見送りまで落とす/severeRiskHitsで
// ハード除外しているが、BUY SCOREの数値自体はリスクの有無に関係なく
// 高いままになりうる矛盾があった＝実測バグ）。個別リスクごとの正確な
// 減点幅の根拠となる実データが無いため、既存のbadChipSignals（bad級の
// リスクシグナル。財務リスク=netNet等、希薄化リスク=将来的な該当項目、
// 信用過熱=marginOverhang、会計リスク=receivablesAnomaly、業績悪化=
// earningsWarning等を包含）の該当件数×一律の減点で反映する。
export const BUY_SCORE_RISK_PENALTY_PER_SIGNAL = 10;
export function buyScoreRiskPenalty(r) {
  return badChipSignals(r).length * BUY_SCORE_RISK_PENALTY_PER_SIGNAL;
}
export function buyScore(parts = {}, riskPenalty = 0) {
  const base = weightedComposite(parts, BUY_SCORE_WEIGHTS);
  if (base.score === null || !riskPenalty) return base;
  return { ...base, score: Math.max(0, base.score - riskPenalty), rawScoreBeforeRisk: base.score, riskPenalty };
}

export const EXPECTATION_SCORE_WEIGHTS = { revenueGrowth: 40, profitGrowth: 30, quality: 20, sectorMomentum: 10 };
export function expectationScore(parts = {}) {
  return weightedComposite(parts, EXPECTATION_SCORE_WEIGHTS);
}

export const SURPRISE_SCORE_WEIGHTS = { consensusGap: 60, progressMomentum: 20, monthlyDisclosure: 20 };
export function earningsSurpriseScore(parts = {}) {
  return weightedComposite(parts, SURPRISE_SCORE_WEIGHTS);
}

// buyScoreの「タイミング」要素用の目安（screener.mjs WINDOW/us_screener.mjs
// US_WINDOWと同じ閾値。indicators.mjsは循環importを避けるため値を複製する
// ＝WINDOW側の値を変えたらここも合わせて変更すること）。
const TIMING_WINDOW = { nowMin: 7, sweetMin: 14, nowMax: 30, watchMax: 45, preMax: 60 };

// buyScore/expectationScore/earningsSurpriseScoreの各partsを、AMBUSH
// 結果オブジェクト（JP/US共通の最小限のフィールドのみ参照）から組み立てる。
// r.score/r.repricingLag/r.consensusTrap/r.progressStreak/r.hasMonthly/
// r.netNet/r.revenueGrowthPct等、既存の各screener.mjsが既に計算済みの
// フィールドだけを使い、新規リクエストは発生しない。
export function buildScoreParts(r) {
  const expectedReturn = Number.isFinite(r.score) ? { value: r.score, note: '既存SCORE(素点)を流用' } : null;
  const unpriced = r.repricingLag?.checked && Number.isFinite(r.repricingLag.score)
    ? { value: r.repricingLag.score, note: `妙味スコア${r.repricingLag.score}/100（zone:${r.repricingLag.zone}）` }
    : null;
  const surpriseMap = { good: 90, warn: 50, bad: 10 };
  const surprise = r.consensusTrap?.checked && r.consensusTrap.level in surpriseMap
    ? { value: surpriseMap[r.consensusTrap.level], note: r.consensusTrap.note }
    : null;
  let timing = null;
  if (Number.isFinite(r.daysLeft) && r.daysLeft >= 0) {
    const d = r.daysLeft;
    const v = d < TIMING_WINDOW.nowMin ? null
      : d < TIMING_WINDOW.sweetMin ? 40
        : d <= TIMING_WINDOW.nowMax ? 100
          : d <= TIMING_WINDOW.watchMax ? 60
            : d <= TIMING_WINDOW.preMax ? 20 : null;
    if (v !== null) timing = { value: v, note: `決算まで${d}日` };
  }
  const qualityFields = ['netNet', 'lowPbr', 'hiddenGem', 'pbrHistoricalLow'];
  const qualityChecked = qualityFields.map((k) => r[k]).filter((s) => s?.checked);
  const quality = qualityChecked.length
    ? { value: Math.round((qualityChecked.filter((s) => s.level === 'good').length / qualityChecked.length) * 100), note: `下値・割安系シグナル${qualityChecked.filter((s) => s.level === 'good').length}/${qualityChecked.length}件該当` }
    : null;

  const revenueGrowth = Number.isFinite(r.revenueGrowthPct)
    ? { value: Math.max(0, Math.min(100, Math.round(r.revenueGrowthPct * 2))), note: `売上高成長率+${r.revenueGrowthPct}%` }
    : null;
  const profitGrowth = Number.isFinite(r.earningsTrend?.netIncomeGrowthPct ?? r.profitGrowthPct)
    ? { value: Math.max(0, Math.min(100, Math.round((r.earningsTrend?.netIncomeGrowthPct ?? r.profitGrowthPct) * 2))), note: '利益成長率' }
    : null;
  const sectorMomentum = Number.isFinite(r.sectorChangePct)
    ? { value: Math.max(0, Math.min(100, Math.round(50 + r.sectorChangePct * 10))), note: `業種騰落率${r.sectorChangePct}%` }
    : null;

  const progressMomentum = r.progressStreak?.checked
    ? { value: r.progressStreak.level === 'good' ? 90 : r.progressStreak.level === 'warn' ? 40 : 50, note: r.progressStreak.note ?? '進捗率トレンド' }
    : null;
  const monthlyDisclosure = typeof r.hasMonthly === 'boolean'
    ? { value: r.hasMonthly ? 70 : 30, note: r.hasMonthly ? '月次開示あり' : '月次開示なし' }
    : null;

  return {
    buy: { expectedReturn, unpriced, surprise, timing, quality },
    expectation: { revenueGrowth, profitGrowth, quality, sectorMomentum },
    surprise: { consensusGap: surprise, progressMomentum, monthlyDisclosure },
  };
}

// DATA/CONFIDENCE分離（項目7）。confidenceRaw（0-100、composite()系関数の
// confidence=取得できた配点合計）をHIGH/MEDIUM/LOWの3段階に丸める。
export const CONFIDENCE_TIER = { high: 80, medium: 50 };
export function confidenceTier(confidenceRaw) {
  if (!Number.isFinite(confidenceRaw)) return null;
  if (confidenceRaw >= CONFIDENCE_TIER.high) return 'HIGH';
  if (confidenceRaw >= CONFIDENCE_TIER.medium) return 'MEDIUM';
  return 'LOW';
}

// Effective Score = Raw Score × Confidence係数（項目7）。元のSCORE表示は
// 別途保持し、ランキングにはこちらを使う。データが薄いのに高得点な銘柄が
// 不当に上位へ来るのを防ぐ。
export const CONFIDENCE_ADJUSTMENT = { HIGH: 1.0, MEDIUM: 0.85, LOW: 0.65 };
export function effectiveScore(rawScore, confidenceRaw) {
  if (!Number.isFinite(rawScore)) return null;
  const tier = confidenceTier(confidenceRaw) ?? 'LOW';
  return Math.round(rawScore * CONFIDENCE_ADJUSTMENT[tier]);
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

// EDINET由来の財務数値（cash/totalAssets/equity/receivables/
// retainedEarnings/investmentSecurities等）は単位が「円」だが、kabutan
// 由来のmarketCapは単位が「百万円」（kabutan.mjsのparseMain参照）。
// EDINETの値とmarketCapを比較する信号は必ずこの関数で単位を揃えてから
// 割ること。
//
// ■ 実測バグ（重大・このコメントを書くに至った経緯）
// netNetSignalがこの換算をせずにnetAssets(円) / marketCap(百万円)を
// 計算しており、比率が約100万倍に水増しされていた。ratio>=1の閾値判定
// 自体は（値が巨大に狂っていても閾値を超えることに変わりはないため）
// 結果的に多くの銘柄で「解散価値割れ」と表示され続けてしまっており、
// 単なる表示バグでは済まず、下値の裏付け・hiddenGemSignal・AMBUSHの
// 加点（AMBUSH_BONUS_FIELDS経由）に本物の影響が出ていた。EDINET統合を
// 行った当初からこの状態だったとみられる。
export function marketCapYen(marketCapMillionYen) {
  return Number.isFinite(marketCapMillionYen) ? marketCapMillionYen * 1_000_000 : null;
}

// v7.3改修（ユーザー指示書 項目10）: EV/EBITDA。単純なPER/PBRだけでは
// 割安・割高を判断しない、という方針への対応。marketCap/operatingProfit
// はkabutanの「百万円」単位、interestBearingDebt/cash/dAndAはEDINETの
// 生の円単位（実測確認済み。edinet.mjs参照）なので、marketCapYen()と
// 同じ考え方でoperatingProfitも生の円単位に揃えてから計算する。
// dAndA（減価償却費）が取れない銘柄はEBITDA≒営業利益として計算する
// （実態のEBITDAより小さめに出るだけで、過大評価には振れない安全側）。
// 赤字（EBITDA<=0）はEV/EBITDA自体が無意味な指標になるため比率は出さない。
export function evEbitda({ marketCap, interestBearingDebt, cash, operatingProfit, dAndA } = {}) {
  if (!Number.isFinite(marketCap) || marketCap <= 0 || !Number.isFinite(operatingProfit)) {
    return { ev: null, ebitda: null, ratio: null, checked: false };
  }
  const ev = marketCapYen(marketCap) + (Number.isFinite(interestBearingDebt) ? interestBearingDebt : 0) - (Number.isFinite(cash) ? cash : 0);
  const ebitda = marketCapYen(operatingProfit) + (Number.isFinite(dAndA) ? dAndA : 0);
  if (ebitda <= 0) return { ev, ebitda, ratio: null, checked: true };
  return { ev, ebitda, ratio: round1(ev / ebitda), checked: true };
}

export function netNetSignal({ cash, totalAssets, equity, marketCap, receivables } = {}) {
  // level:nullには「データ不足で判定できない」場合と「データは揃って
  // いて解散価値割れではないと確認できた」場合の2通りがある。呼び出し側
  // （buyRuleChecklistの「下値」行）がこれを混同すると、PBRデータが
  // 完全に揃っていて明確に「割安ではない」と分かる銘柄まで「？（未確認）」
  // と表示してしまう（実測: 350A等11銘柄でPBRデータが揃っているのに
  // 「解散価値・PBRいずれでも下値の裏付けは確認できず」と表示されていた）。
  // receivablesAnomalySignalと同じくchecked flagで明示的に区別する。
  if (![cash, totalAssets, equity, marketCap].every(Number.isFinite) || marketCap <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const liabilities = totalAssets - equity;
  const hasReceivables = Number.isFinite(receivables);
  const netAssets = hasReceivables
    ? cash + receivables * NET_NET_RECEIVABLES_HAIRCUT - liabilities
    : cash - liabilities;
  const ratio = netAssets / marketCapYen(marketCap);
  const basis = hasReceivables ? '現預金+売掛金×0.75-負債' : '現預金-負債(簡易版・売掛金データ無し)';
  if (ratio >= 1) {
    return {
      level: 'good', label: '解散価値割れ', checked: true,
      note: `${basis}が時価総額の${round1(ratio * 100)}%・会社を今すぐ解散して資産を分けた方が株価より高い計算です。事業の価値はほぼ0円評価されており、下値は極めて限定的とみられます`,
    };
  }
  if (ratio >= 0.7) {
    return {
      level: 'warn', label: '解散価値に接近', checked: true,
      note: `${basis}が時価総額の${round1(ratio * 100)}%まで接近・株価がもう一段下がると解散価値割れの水準です`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
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
  // netNetSignalと同じ理由でchecked flagを持たせる（PBRデータが揃って
  // いて「割安ではない」と確認できた場合と、データ不足で判定できない
  // 場合を区別する）。
  if (!Number.isFinite(pbr) || !Number.isFinite(sectorPbr) || sectorPbr <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const ratio = round1((pbr / sectorPbr) * 100);
  if (pbr / sectorPbr <= LOW_PBR.goodRatio) {
    return {
      level: 'good', label: '業種内で割安', checked: true,
      note: `PBR${pbr}倍・業種平均${sectorPbr}倍の${ratio}%。業種内で相対的に割安な水準です`,
    };
  }
  if (pbr / sectorPbr <= LOW_PBR.warnRatio) {
    return { level: 'warn', label: '業種平均並み', checked: true, note: `PBR${pbr}倍・業種平均${sectorPbr}倍の${ratio}%` };
  }
  return { level: null, label: null, note: null, checked: true };
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

// ③' 過去最高配当利回りへの接近度（IR Bank）
//
//  現在の配当利回りが単体で高いだけでなく、その銘柄自身の過去5年の
//  レンジの中でどの位置にあるかを見る。無配銘柄（過去最高が0%）は
//  接近率という概念が成立しないためnull（IR Bank側で既にガード済み）。
export const DIVIDEND_PEAK = { near: 90 };

// currentYieldはkabutanの最新値（他のシグナルの「現在利回り」と揃える）
// を渡す。IR Bank自身が持つ「現在値」を使うと、取得タイミングのズレで
// 同じカードの中に4.21%(kabutan)と4.29%(IR Bank)のような、利用者から
// 見て矛盾する2つの「現在利回り」が同居してしまう（実測: 7921で発生）。
// maxYield/maxPeriodだけIR Bankの過去5年データを使い、接近率はここで
// 一貫した基準で計算し直す。
export function dividendYieldPeakSignal({ currentYield, maxYield, maxPeriod } = {}) {
  if (!Number.isFinite(currentYield) || !Number.isFinite(maxYield) || maxYield <= 0) {
    return { level: null, label: null, note: null };
  }
  const approachPct = Math.round((currentYield / maxYield) * 1000) / 10;
  if (approachPct >= 100) {
    return {
      level: 'good', label: '配当利回り最高水準',
      note: `現在${currentYield}%は過去5年の最高（${maxPeriod}時点${maxYield}%）に並ぶか上回る水準です`,
    };
  }
  if (approachPct >= DIVIDEND_PEAK.near) {
    return {
      level: 'good', label: '配当利回り高水準',
      note: `現在${currentYield}%は過去5年の最高（${maxPeriod}・${maxYield}%）の${approachPct}%まで接近しています`,
    };
  }
  return { level: null, label: null, note: null };
}

// ③'' 過去最低PBRへの接近度（IR Bank）
//
//  コンセンサス（アナリスト予想）が無い銘柄は「未来の期待値」で判定
//  できないため、代わりに「過去の事実」として自分自身の過去のPBR推移の
//  中で今がどの位置にあるかを見る。current/maxYieldと同じ考え方だが
//  向きが逆（低いほど良い）なので、接近率は min/currentで計算する
//  （現在が最低値そのものなら100%、現在が最低値を更に下回れば100%超）。
//  netNet/lowPbrと同じ理由でchecked flagを持たせる（buyRuleChecklistの
//  「下値」行がnetNet/lowPbrと同じOR条件に組み込むため、「データ不足で
//  未確認」と「データは揃っていて下値の裏付けにならないと確認できた」を
//  混同してはならない）。
export const PBR_LOW = { near: 90 };

export function pbrHistoricalLowSignal({ currentPbr, minPbr, minPeriod } = {}) {
  if (!Number.isFinite(currentPbr) || !Number.isFinite(minPbr) || currentPbr <= 0 || minPbr <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const approachPct = Math.round((minPbr / currentPbr) * 1000) / 10;
  if (approachPct >= 100) {
    return {
      level: 'good', label: 'PBR歴史的最低水準', checked: true,
      note: `現在PBR${currentPbr}倍は過去最低（${minPeriod}時点${minPbr}倍）に並ぶか下回る水準です`,
    };
  }
  if (approachPct >= PBR_LOW.near) {
    return {
      level: 'good', label: 'PBR歴史的低水準', checked: true,
      note: `現在PBR${currentPbr}倍は過去最低（${minPeriod}・${minPbr}倍）の${approachPct}%まで接近しています`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑤ コンセンサス不在＝アナリスト非カバーという属性そのものをシグナル化する
//
//  時価総額が小さい銘柄はそもそも証券会社のリサーチ対象外（コンセンサス
//  自体が存在しない）だが、それは同時に「機関投資家がまだ見つけていない
//  可能性がある」という意味でもある。EDINET確認済みの財務健全性
//  （解散価値割れ or 業種内で割安なPBR）と増配トレンドが同時に揃う場合に
//  限り「お宝候補」として拾い上げる（コンセンサスが無いというだけでは
//  何の裏付けにもならないため、単独では発火させない）。
export const HIDDEN_GEM = { minStreakYears: 1 };

export function hiddenGemSignal({ consensusProfit, netNet, lowPbr, dividendStreakYears, dividendStreakDirection } = {}) {
  const hasConsensus = hasConsensusProfit(consensusProfit);
  if (hasConsensus) return { level: null, label: null, note: null };
  const soundFinance = netNet?.level === 'good' || lowPbr?.level === 'good';
  if (!soundFinance) return { level: null, label: null, note: null };
  if (dividendStreakDirection !== 'up' || !Number.isFinite(dividendStreakYears) || dividendStreakYears < HIDDEN_GEM.minStreakYears) {
    return { level: null, label: null, note: null };
  }
  const basis = netNet?.level === 'good' ? '解散価値割れ' : '業種内で割安なPBR';
  return {
    level: 'good', label: 'お宝候補',
    note: `アナリスト未カバー（コンセンサスN/A）ながら${basis}かつ${dividendStreakYears}期連続増配中。機関投資家にまだ見つかっていない可能性があり、注目された際の反応が大きくなりやすい銘柄です`,
  };
}

// ④ 踏み上げ狙い（信用残の解消）
//
//  信用買い残が減り（個人の投げ売りが進み）、逆に信用売り残（空売り）が
//  増えている＝将来「買い戻さざるを得ない」需要が積み上がっている状態。
export function shortSqueezeSignal(weekly) {
  // level:nullが「週次信用残データが無い」場合と「データはあり踏み上げ
  // 狙いの条件（買い残減少かつ売り残増加）を満たさないと確認できた」
  // 場合の両方に使われるため、checked flagで区別する。これが無いと、
  // buyRuleChecklistの「需給」行のOR条件（信用過多でない、または踏み
  // 上げが積み上がっている）が壊れる：marginOverhangが確定的にbadで
  // squeezeが単に未取得なだけの場合でも「OR全体がfalseと確定」と
  // 誤認して✗を出してしまう（本来は「squeezeが分かれば結果が変わる
  // かもしれない」ので？が正しい）。
  const buyTrendPct = creditTrend(weekly);
  const sellTrendPct = shortTrend(weekly);
  if (buyTrendPct === null || sellTrendPct === null) return { level: null, label: null, note: null, checked: false };
  if (buyTrendPct < 0 && sellTrendPct > 0) {
    return {
      level: 'good', label: '踏み上げ狙い', checked: true,
      note: `信用買い残4週比${buyTrendPct}%・空売り(売り残)4週比+${sellTrendPct}%。個人の投げが進み空売りが積み上がっており、戻りで買い戻し需要が出やすい状態です`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ④' 機関投資家の空売り縮小（karauri.net・大量保有報告に基づく法定開示）
//
//  shortSqueezeSignalは信用取引（主に個人投資家）の空売りトレンドだが、
//  こちらは残高割合0.5%超で法定開示義務のある機関投資家（ヘッジファンド等）
//  の空売りポジション推移。投資主体が異なる別データで、個人の踏み上げ
//  期待とは独立した「大口が撤退し始めている」根拠として使う。
export const INSTITUTIONAL_SHORT = { meaningfulPct: 0.5, coveringDrop: -0.2 };

export function institutionalShortSignal({ totalPct, changePct, checked } = {}) {
  if (!checked || totalPct === null) return { level: null, label: null, note: null, checked: false };
  if (totalPct >= INSTITUTIONAL_SHORT.meaningfulPct && changePct !== null && changePct <= INSTITUTIONAL_SHORT.coveringDrop) {
    return {
      level: 'good', label: '機関の空売り縮小', checked: true,
      note: `機関投資家の空売り残高${totalPct}%（直近90日で${changePct}pt減少）。大口の買い戻しが進んでおり、踏み上げ的な反発の余地があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ④'' 大株主の買い増し（IR Bank・大株主一覧の推移）
//
//  Ulletの「大株主構成・浮動株比率」提案を受けて、既に統合済みで信頼できる
//  IR Bankの同等データ（/holder）で代替する。筆頭株主の持株比率が高いほど
//  浮動株は薄く、上位3株主の合計持株比率が直近の開示で増えていれば
//  大株主が買い増している（＝経営陣や大口が自信を持っている）根拠とする。
//  上位3株主「合計」で見るのは、信託銀行名義などで筆頭株主自体が期に
//  よって入れ替わることがあり、単一株主の継続履歴を追えないケースが
//  あるため（実測: 7921で新規の名義が突然1位に現れ、それ以前の履歴が
//  無かった）。
export const MAJOR_SHAREHOLDER = { thinFloatPct: 20, accumulatingChange: 3 };

export function majorShareholderSignal({ top1Pct, top3PctChange, checked } = {}) {
  if (!checked || top1Pct === null) return { level: null, label: null, note: null, checked: false };
  if (top1Pct >= MAJOR_SHAREHOLDER.thinFloatPct && top3PctChange !== null && top3PctChange >= MAJOR_SHAREHOLDER.accumulatingChange) {
    return {
      level: 'good', label: '大株主が買い増し中', checked: true,
      note: `筆頭株主の持株比率${top1Pct}%・上位3株主合計が前回開示比+${top3PctChange}pt。浮動株が少なく、大株主の買い増しで需給が締まっている可能性があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
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
  // level:nullが「信用倍率データが無い」場合と「データはあり信用過多
  // ではないと確認できた」場合の両方に使われるため、checked flagで区別
  // する（実測: 石井表記等4銘柄はloanRatio自体が取得できていないのに、
  // buyRuleChecklistの「需給」行が「✓ 信用過多の兆候なし」＝確認済みと
  // 誤表示していた）。
  if (loanRatio === null || loanRatio === undefined) return { level: null, label: null, note: null, checked: false };
  if (loanRatio >= MARGIN_OVERHANG.heavy) {
    return {
      level: 'bad', label: '信用過多', checked: true,
      note: `信用倍率${loanRatio}倍・買い方の含み益が積み上がっており、上昇時に利益確定売りに押されて上値が重くなりやすい状態です`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
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

// v7.3改修（ユーザー指示書 項目9）: 売上高と売掛金だけの比較では判断しない、
// という要望に対応し、営業CFの方向を追加考慮する。ユーザー提示の例
// 「売上+5%・売掛金+12%・営業CF↓→高リスク」「同じ数字でも営業CF↑→
// 必ずしも悪材料ではない（季節性・M&A・大型案件等の可能性）」をそのまま
// ロジック化する: 売掛金急増でbad判定になったケースでも、営業CFが
// 前期から改善していれば1段階軽いwarnに緩和し、理由をnoteに明記する。
// operatingCfGrowthPctが無い（データ不足）場合は従来通りbadのまま
// （安全側に倒す＝softenしない）。
export function receivablesAnomalySignal({ revenueGrowthPct, receivablesGrowthPct, operatingCfGrowthPct } = {}) {
  if (!Number.isFinite(revenueGrowthPct) || !Number.isFinite(receivablesGrowthPct)) {
    // データ不足で「判定できない」状態。level:nullの「異常なし」と
    // 呼び出し側が混同しないよう checked:false で明示的に区別する。
    return { level: null, label: null, note: null, checked: false };
  }
  const cfImproving = Number.isFinite(operatingCfGrowthPct) && operatingCfGrowthPct > 0;
  const cfNote = cfImproving ? `一方で営業キャッシュ・フローは前期比+${operatingCfGrowthPct}%と改善しており、季節性・大型案件・M&A等による一時的な運転資本の増加で、必ずしも粉飾等の悪材料とは限りません。` : '';
  const softened = (label, note) => cfImproving
    ? { level: 'warn', label: `${label}（営業CF改善）`, checked: true, note: `${note}${cfNote}` }
    : { level: 'bad', label, checked: true, note };
  // 売上が横ばい/減収なのに売掛金が増えているのは特に強い警戒サイン。
  if (revenueGrowthPct <= 0 && receivablesGrowthPct > 5) {
    return softened('売掛金急増', `売上高${revenueGrowthPct > 0 ? '+' : ''}${revenueGrowthPct}%に対し売上債権+${receivablesGrowthPct}%。売上が伸びていないのに売掛金だけ膨らんでおり、回収遅延の懸念があります。`);
  }
  if (revenueGrowthPct > 0) {
    const ratio = round1(receivablesGrowthPct / revenueGrowthPct);
    if (ratio >= RECEIVABLES_ANOMALY.ratioBad) {
      return softened('売掛金急増', `売上高+${revenueGrowthPct}%に対し売上債権+${receivablesGrowthPct}%（売上の${ratio}倍のペース）。回収サイクルの長期化や押し込み販売の懸念があります。`);
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

// ⑥ 個人投資家による期待の織り込み（retailExpectationSignal）
//
//  「決算が良さそう」「先行材料が良い」（＝これから起こりうる好材料への
//  期待）と、「その期待が既に株価に反映されているか」は別の軸である。
//  好材料があっても、株価が既に個人投資家の期待で大きく買われていれば、
//  決算発表そのものが「材料出尽くし」の売り材料になりかねない。
//
//  信用買い残（kabutanの週次信用残）は個人投資家中心のデータであり、
//  機関投資家の売買とは投資主体が異なる（karauri.mjsの空売り・IR Bankの
//  大株主構成とは別の切り口）。「株価上昇」だけでは誰が買っているか
//  分からないが、「株価上昇 かつ 信用買い残の増加」が揃って初めて
//  「個人投資家の期待が株価に織り込まれつつある」と言える、というのが
//  この関数の核心の考え方。株価だけ急騰していて信用買い残が伴わない
//  場合（大口・機関投資家主導とみられる値動き）は、個人投資家による
//  織り込みとは別物として扱い、この信号では強く警戒しない。
//
//  ambushConviction/smartEntryConvictionでは「重要な減点要素」として
//  扱う（AMBUSH_PENALTY_FIELDS参照）。CHIP_SIGNAL_FIELDSにも含めるため、
//  level:'bad'は既存のworsen-onlyパターンにより自動的に「買い推奨」から
//  外れる（ambushVerdict/smartEntryVerdictの配線を新たに書く必要はない）。
export const RETAIL_EXPECTATION = {
  moderateReturn1m: 7, bigReturn1m: 15,
  moderateCreditTrend: 8, bigCreditTrend: 20,
  highLevelPct: 80,
  bigVolRatio: 2,
  nearEarningsDays: 10,
};

export function retailExpectationSignal({
  return1w, return1m, priceLevelPct, volRatio,
  creditTrendPct, creditWeek1Pct, daysToEarnings,
} = {}) {
  const c = RETAIL_EXPECTATION;
  // 株価・信用買い残のどちらも判定材料が無ければ判定不能（推測しない）。
  if (!Number.isFinite(return1m) && !Number.isFinite(creditTrendPct)) {
    return { level: null, label: null, note: null, checked: false };
  }

  const priceModerate = Number.isFinite(return1m) && return1m >= c.moderateReturn1m;
  const priceStrong = Number.isFinite(return1m) && return1m >= c.bigReturn1m;
  const creditModerate = Number.isFinite(creditTrendPct) && creditTrendPct >= c.moderateCreditTrend;
  const creditStrong = Number.isFinite(creditTrendPct) && creditTrendPct >= c.bigCreditTrend;
  const nearHigh = Number.isFinite(priceLevelPct) && priceLevelPct >= c.highLevelPct;
  const volumeUp = Number.isFinite(volRatio) && volRatio >= c.bigVolRatio;
  const earningsNear = Number.isFinite(daysToEarnings) && daysToEarnings >= 0 && daysToEarnings <= c.nearEarningsDays;

  const fmtPct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v}%` : 'N/A');
  const detail = `1ヶ月${fmtPct(return1m)}(1週間${fmtPct(return1w)}) / 信用買い残4週比${fmtPct(creditTrendPct)}(前週比${fmtPct(creditWeek1Pct)}) / `
    + `3ヶ月高値圏位置${Number.isFinite(priceLevelPct) ? `${priceLevelPct}%` : 'N/A'} / `
    + `決算まで${Number.isFinite(daysToEarnings) ? `${daysToEarnings}日` : 'N/A'}`;

  // 核心の組み合わせ：株価上昇 かつ 信用買い残増加が揃って初めて
  // 「個人投資家の期待が織り込まれつつある」と言える（どちらか一方
  // だけでは判断しない）。
  const combo = priceModerate && creditModerate;

  if (combo && priceStrong && creditStrong && (nearHigh || earningsNear || volumeUp)) {
    const why = earningsNear ? '決算直前の急騰' : nearHigh ? '高値圏での急騰' : '出来高急増を伴う急騰';
    return {
      level: 'bad', label: '期待先行・織り込み大', checked: true,
      note: `${detail}。株価急騰と信用買い残急増が重なった${why}で、決算で好材料が出ても「材料出尽くし」で下落するリスクが高い状態です`,
    };
  }
  if (combo) {
    return {
      level: 'warn', label: '期待織り込みあり', checked: true,
      note: `${detail}。株価上昇と信用買い残増加が同時に進んでおり、好材料への期待はある程度株価に反映されつつあります`,
    };
  }
  if (priceModerate || creditModerate) {
    // 株価と信用買い残のどちらか一方しか動いていない状態。特に「株価だけ
    // 急騰し信用買い残が伴わない」ケースは大口・機関投資家主導の値動きが
    // 疑われ、個人投資家の期待織り込みとは別物として扱う（強く警戒しない）。
    const why = priceModerate && !creditModerate
      ? '株価は上昇していますが信用買い残は伴っておらず、個人投資家主体の織り込みとは言い切れません（大口・機関投資家主導の値動きの可能性があります）'
      : '信用買い残は増加していますが株価は大きく動いておらず、様子見の域です';
    return { level: 'warn', label: '期待織り込みの兆し', checked: true, note: `${detail}。${why}` };
  }
  return {
    level: null, label: '未織り込み', checked: true,
    note: `${detail}。株価・信用買い残ともに大きな動きが無く、好材料への期待はまだ株価に織り込まれていません`,
  };
}

// ==================================================================
// カタリスト予兆 — 「材料が出てから買う」のではなく「材料が出るしか
// ない財務状況」を先回りして拾う（ユーザー提案）。いずれも公開データ
// （EDINET/kabutan）のみに基づく客観的な予兆で、内部情報は使わない。
// ==================================================================

// ⑦ 進捗率の連続上振れ（決算の「クセ」が良化している予兆）
//
//  kabutan決算ページの進捗率テーブルは、同じ相対四半期（例: 毎年2〜4月期）
//  の実績が年ごとに並ぶ構成（pickLatestActualと同じ表）。異なる四半期
//  どうしを比べると季節性が混ざるため、必ず「同じ時期どうし」を年で
//  比較する。直近2年以上にわたって進捗率が上昇し続けていれば、業績の
//  上振れ基調が続いていると考えられる（次の決算も上振れる保証はないが、
//  単発の好決算より再現性のある予兆）。
export const PROGRESS_STREAK = { minStreak: 2 };

// 「同じ時期（history.at(-1)）」と「その1年前（history.at(-2)）」の経常益
// （profit）を比べたYoY成長率。progressStreakSignal専用に埋め込んで
// いたロジックを、仕込み妙味スコア（repricingLagScore）のprofitGrowthPct
// 入力としても再利用できるよう独立関数として切り出した（連続上昇の
// streak条件とは無関係に、historyが2件以上あれば常に計算できる）。
// 営業赤字→黒字転換等、前年が0以下だと%が定義できないためnullを返す。
export function latestProfitYoyPct(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const latest = history.at(-1);
  const prev = history.at(-2);
  return Number.isFinite(latest?.profit) && Number.isFinite(prev?.profit) && prev.profit > 0
    ? round1(((latest.profit - prev.profit) / prev.profit) * 100)
    : null;
}

export function progressStreakSignal(history) {
  if (!Array.isArray(history) || history.length === 0) return { level: null, label: null, note: null, checked: false };
  if (history.length < 2) return { level: null, label: null, note: null, checked: true }; // 1件だけでは連続と言えない
  // points = 連続して上昇している区間に含まれるデータ点数。「N年連続で
  // 上昇」の“N”は上昇（増加）が起きた回数＝points-1であり、点数そのもの
  // ではない（3点(19.8→37.2→91.7)は上昇が2回＝「2年連続」が正しい）。
  let points = 1;
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i].progress > history[i - 1].progress) points++;
    else break;
  }
  const increases = points - 1;
  if (increases < PROGRESS_STREAK.minStreak) return { level: null, label: null, note: null, checked: true };
  const latest = history.at(-1);
  const trail = history.slice(-points).map((h) => `${h.period}:${h.progress}%`).join('→');
  const profitYoyPct = latestProfitYoyPct(history);
  // 実測（あさひ3333）: 進捗率は加速していても経常利益が前年同期比マイナス
  // というケースがある（今期の会社予想自体が前年実績より低く設定されて
  // いる可能性）。この場合は「業績の上振れ基調」と言い切れないため、
  // goodのまま前向きな結論を出さずwarnに格下げし、文言もその旨に変える。
  if (profitYoyPct !== null && profitYoyPct < 0) {
    return {
      level: 'warn', label: '進捗率は加速も利益は前年割れ', checked: true, profitYoyPct,
      note: `同じ時期（${latest.label}）の進捗率は${increases}年連続で上昇しています（${trail}）が、経常利益は前年同期比${profitYoyPct}%と減益です。今期の会社予想自体が前年実績より低く設定されている可能性があり、進捗率の見た目ほど強気の材料ではないかもしれません`,
    };
  }
  return {
    level: 'good', label: '進捗率が加速中', checked: true, profitYoyPct,
    note: `同じ時期（${latest.label}）の進捗率が${increases}年連続で上昇しています（${trail}）。業績の上振れ基調が続いており、次の決算でも好材料が出る可能性があります${profitYoyPct !== null ? `（経常利益は前年同期比+${profitYoyPct}%）` : ''}`,
  };
}

// ⑧ 株主還元ポテンシャル（初配・増配・自社株買いの予兆）
//
//  無配のまま利益剰余金（内部留保）が時価総額に対して大きく積み上がって
//  いる銘柄は、IPO後の投資フェーズが一巡すると株主還元（初配・自社株
//  買い）に転じる余地が大きい。配当利回りが0%であることを「無配」の
//  確認に使うため、dividendYieldが取得できていない場合と無配の場合を
//  区別する（未取得を無配と誤認しない）。
export const DIVIDEND_POTENTIAL = { retainedEarningsRatio: 0.2 };

export function dividendPotentialSignal({ retainedEarnings, marketCap, dividendYield } = {}) {
  if (![retainedEarnings, marketCap, dividendYield].every(Number.isFinite) || marketCap <= 0 || retainedEarnings <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const ratio = round1((retainedEarnings / marketCapYen(marketCap)) * 100);
  if (dividendYield === 0 && ratio >= DIVIDEND_POTENTIAL.retainedEarningsRatio * 100) {
    return {
      level: 'good', label: '初配・株主還元期待', checked: true,
      note: `無配のまま利益剰余金が時価総額の${ratio}%まで積み上がっています。投資フェーズが一巡すれば、初配や自社株買いに動く余地があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑨ 含み資産アラート（投資有価証券の売却益・特別利益の予兆）
//
//  投資有価証券（政策保有株・持ち合い株等）を時価総額に対して大きく
//  保有している銘柄は、東証のPBR改善要請もあり、売却して特別利益を
//  計上する余地がある。決算直前に利益を捻出する目的で売却されることも
//  ある「隠れ資産」。
export const HIDDEN_ASSET = { ratio: 0.3 };

export function hiddenAssetSignal({ investmentSecurities, marketCap } = {}) {
  if (![investmentSecurities, marketCap].every(Number.isFinite) || marketCap <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const mcYen = marketCapYen(marketCap);
  const ratio = round1((investmentSecurities / mcYen) * 100);
  if (investmentSecurities / mcYen >= HIDDEN_ASSET.ratio) {
    return {
      level: 'good', label: '含み資産あり', checked: true,
      note: `投資有価証券（政策保有株等）が時価総額の${ratio}%あります。東証のPBR改善要請もあり、売却して特別利益を計上する余地があります`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ⑩ 信用買い占有率（浮動株に対する信用買い残の重さ。ユーザー提案）
//
//  信用買い残の「絶対数」だけでは需給の軽重が分からない（同じ100万株
//  でも、浮動株1,000万株の銘柄と200万株の銘柄では意味が全く違う）。
//  IR Bank（irbank.mjs）の大株主上位3名の合計保有比率を使い、
//  「発行済株式数 × (1 - 上位3株主保有比率)」を浮動株数の概算として、
//  信用買い残との比率を見る。
//
//  ■ 近似であることの注意
//  本来の「浮動株比率」は東証が自己株式・役員持株・上位10大株主等を
//  除いて算出する公式指標だが、そのデータは無料では取得できない。
//  ここでは上位3株主（IR Bank大株主一覧）だけを控除する簡易な近似值
//  であり、実際の浮動株比率より甘め（大きめ）に出る傾向がある点に注意。
//  creditBuyBalance（信用買い残）とsharesOutstanding（発行済株式数）は
//  どちらもkabutan由来で単位「株」（marketCapのような単位換算は不要。
//  実データで確認済み: 6336は信用買い残475,100株・発行済株式数
//  8,176,452株で桁が整合している）。
//
//  ■ marginOverhangSignal（信用倍率）との矛盾チェック（実測で発覚）
//  occupancy（浮動株に対する信用買いの「絶対量」）が小さくても、既存の
//  信用買いの買い/売り比率（信用倍率）が極端に偏っていれば、その買い方は
//  一方向に積み上がっていて利益確定売りに押されやすい。実測でサムコ
//  (6387,信用倍率83.09倍)・神戸物産(3038,16.26倍)・Japan Eyewear
//  Holdings(5889,1872倍)がoccupancy的には「軽い」のに信用倍率は「過多」
//  という正反対の判定になっていた。loanRatioがMARGIN_OVERHANG.heavy以上
//  の場合は「軽い」と言い切らずwarnに格下げする。
export const CREDIT_FLOAT = { heavy: 20, light: 5 };

// 浮動株比率の近似計算（発行済株式数から上位3株主の保有分を控除する）。
// creditFloatSignal（信用買い残との組み合わせ）とfloatSqueezeSignal
// （出来高急増との組み合わせ、ユーザー提案）の両方から使う共通部分を
// 切り出したもの。
export function computeFloatRatio({ sharesOutstanding, top3PctNow } = {}) {
  if (![sharesOutstanding, top3PctNow].every(Number.isFinite) || sharesOutstanding <= 0) return null;
  const floatRatio = 1 - top3PctNow / 100;
  return floatRatio > 0 ? floatRatio : null; // 上位株主データが異常（発行済株式数を超過）
}

export function creditFloatSignal({ creditBuyBalance, sharesOutstanding, top3PctNow, loanRatio } = {}) {
  if (!Number.isFinite(creditBuyBalance)) {
    return { level: null, label: null, note: null, checked: false };
  }
  const floatRatio = computeFloatRatio({ sharesOutstanding, top3PctNow });
  if (floatRatio === null) return { level: null, label: null, note: null, checked: false };
  const floatingShares = sharesOutstanding * floatRatio;
  const occupancy = round1((creditBuyBalance / floatingShares) * 100);
  const basis = `信用買い残${Math.round(creditBuyBalance).toLocaleString()}株 ÷ 推定浮動株数${Math.round(floatingShares).toLocaleString()}株（発行済株式数から上位3株主の保有分${top3PctNow}%を控除した近似値）`;
  // occupancyはlevelがgood/badに達しない中間域でもワンポイント表示
  // （precursorCardの需給バッジ）に使うため、level問わず常に返す。
  if (occupancy >= CREDIT_FLOAT.heavy) {
    return {
      level: 'bad', label: '信用買い占有率が高い', checked: true, occupancy,
      note: `${basis}＝${occupancy}%。浮動株に対して信用買いが積み上がっており、好材料が出ても上値が重く飛びにくい状態です`,
    };
  }
  if (occupancy <= CREDIT_FLOAT.light) {
    if (Number.isFinite(loanRatio) && loanRatio >= MARGIN_OVERHANG.heavy) {
      return {
        level: 'warn', label: '需給判断に注意', checked: true, occupancy,
        note: `${basis}＝${occupancy}%と浮動株に対する信用買いの絶対量は少ないですが、信用倍率${loanRatio}倍と買い方に極端に偏っており、含み益確定売りの重さを考えると「需給が軽い」とは言い切れません`,
      };
    }
    return {
      level: 'good', label: '需給が軽い', checked: true, occupancy,
      note: `${basis}＝${occupancy}%。浮動株に対して信用買いが少なく、好材料が出れば一気に動きやすい「軽い」需給です`,
    };
  }
  return { level: null, label: null, note: null, checked: true, occupancy };
}

// 浮動株比率×出来高急増（ユーザー提案）。creditFloatSignalは信用買い残
// との組み合わせだが、こちらは「株主が固定されて市場に出回る株が少ない
// ところに買いが集まると値動きが跳ねやすい」という別の組み合わせ。
// テンバガー候補のランキング補正用の加点シグナル（除外条件ではない）。
export const FLOAT_SQUEEZE = { maxFloatRatioPct: 40, minVolumeRatio: 2 };

export function floatSqueezeSignal({ floatRatio, volumeRatio } = {}) {
  if (![floatRatio, volumeRatio].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  const floatRatioPct = round1(floatRatio * 100);
  if (floatRatioPct <= FLOAT_SQUEEZE.maxFloatRatioPct && volumeRatio >= FLOAT_SQUEEZE.minVolumeRatio) {
    return {
      level: 'good', label: '浮動株が少なく出来高急増', checked: true,
      note: `推定浮動株比率${floatRatioPct}%と少ない中、出来高が20日平均の${volumeRatio}倍に急増しています。株主が固定されており市場に出回る株が少ないため、買いが集まった際の値動きが大きくなりやすい状態です`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// 高値圏×出来高急増（順張りブレイクアウト、ユーザー提案）。既存の
// repricingLagScore（乖離度が大きい＝織り込み済みという逆張り寄りの
// 解釈）とは正反対の軸のため、両方を表示する場合はどちらの話か分かる
// ツールチップを必ず付ける（SCORE/妙味スコアの混同を防いだのと同じ
// 処方）。テンバガー候補のランキング補正用の加点シグナル。
export const BREAKOUT_VOLUME = { minPriceLevelPct: 90, minVolumeRatio: 2 };

export function breakoutVolumeSignal({ priceLevelPct, volumeRatio } = {}) {
  if (![priceLevelPct, volumeRatio].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (priceLevelPct >= BREAKOUT_VOLUME.minPriceLevelPct && volumeRatio >= BREAKOUT_VOLUME.minVolumeRatio) {
    return {
      level: 'good', label: '出来高急増のブレイクアウト', checked: true,
      note: `直近レンジ内の位置${priceLevelPct}%（高値圏）で、出来高が20日平均の${volumeRatio}倍に急増しています。順張り・高値更新型のシグナルです。上部の仕込みゾーン（妙味スコア）とは別軸の判定で、乖離度が大きいこと自体は妙味スコアでは減点材料になりますが、出来高を伴う高値更新は別の意味でポジティブなシグナルです`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// 「攻めの赤字」（ユーザー提案: 研究開発費・広告宣伝費が売上を上回る
// 速度で増えている銘柄は、目先の利益より市場シェア獲得を優先している
// 成長投資フェーズと捉える）。JP側はedinet.mjs:extractBalanceSheetSnapshot
// のrndGrowthPct（実測タグ: jppfs_cor:ResearchAndDevelopmentExpensesSGA）、
// US側はus_edgar.mjs:extractQuarterlyTrendのrnd系列から計算した値を渡す。
// 研究開発費を開示している銘柄自体が少ない見込みのため、他の項目より
// checked:falseになる頻度が高い（推測で埋めない）。
export const AGGRESSIVE_INVESTMENT = { minOutpacePt: 10 };
export function aggressiveInvestmentSignal({ rndGrowthPct, revenueGrowthPct } = {}) {
  if (![rndGrowthPct, revenueGrowthPct].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (rndGrowthPct - revenueGrowthPct >= AGGRESSIVE_INVESTMENT.minOutpacePt) {
    return {
      level: 'good', label: '攻めの投資（研究開発費が売上を上回る伸び）', checked: true,
      note: `研究開発費が前年（同期）比+${rndGrowthPct}%と、売上高成長率+${revenueGrowthPct}%を上回るペースで増加しています。目先の利益より成長投資を優先しているフェーズと考えられます（研究開発費を開示している銘柄のみ判定できます）`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// テーマ性マッチング（ユーザー提案）。完全自動のNLP/キーワード検索は
// 存在しないため、tenbagger_research_log.mdの手動リサーチで実在確認
// 済みのkabutan.jpテーマページ一覧（THEME_WATCHLIST、smart_entry.mjs）
// を定期的に照合するだけの簡易版（自動発見ではない点に注意）。
// US側は対応する一元的なテーマページが無いため、us_tenbagger.mjsの
// ウォッチリストに手動で付けたthemeフィールドをそのまま根拠にする。
export function themeMatchSignal({ matchedThemes } = {}) {
  if (!Array.isArray(matchedThemes)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (matchedThemes.length > 0) {
    return {
      level: 'good', label: `テーマ性あり（${matchedThemes.join('・')}）`, checked: true,
      note: `手動で選定したテーマページ一覧（${matchedThemes.join('・')}）に掲載されている銘柄です。自動発見ではなく決め打ちのテーマ一覧との照合のため、このリストに無いテーマは拾えません`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ------------------------------------------------------------------
// カタリスト予兆セクション（ユーザー提案）
//
//  「材料が出てから買う」のではなく「材料が出るしかない財務状況」を
//  先回りして拾う。screener.mjs(AMBUSH)は既に取得済みのEDINET貸借対照表・
//  kabutan決算ページのデータから計算するため追加のリクエストは発生しない
//  （＝AMBUSHのユニバース＝決算T+14〜45日の銘柄）。smart_entry.mjsの
//  東証グロース銘柄向けカタリスト予兆スキャン（ユーザー要望）でも同じ
//  基準を使い回すため、scraper.mjsからここに移設した（scraper.mjsに
//  置いたままだとsmart_entry.mjsからimportする際にscraper.mjs→
//  smart_entry.mjs→scraper.mjsの循環importになってしまうため）。
//  進捗率・利益剰余金・投資有価証券のいずれか1つでも該当すれば掲載する
//  （AND条件にしないのは、性質の異なる予兆を1つの基準で絞ると、他の
//  兆候が強くても掲載されなくなるため）。
//
//  好材料の先取り（🔮）だけでなく、粉飾・悪化のリスクを先取りする注意
//  予兆（⚠️、ユーザー提案「利益の質の逆行チェック」）もこのセクションに
//  含める。receivablesAnomalySignal（売上高成長率<売上債権成長率）は
//  「まだ発表されていない下方修正リスク」、progressStreakSignalのwarn枝
//  （進捗率は加速も経常利益は前年割れ）は「見た目ほど強気ではない」を
//  先取りする点でどちらも「決算前に読み取れる予兆」という同じ性質を持つ。
//
//  ■ creditFloatSignalをこのリストに含めない理由（実測で判明した誤り）
//  当初はcreditFloatのgood（需給が軽い）もPRECURSOR_GOOD_FIELDSに含めて
//  いたが、実測でAMBUSH候補15銘柄中11銘柄が「需給が軽いというだけ」で
//  このセクションに掲載され、「材料が出るしかない財務状況」という本来の
//  趣旨（＝将来の好材料そのものの予兆）とは無関係な「材料が出た場合に
//  伸びやすい体質」という別軸の情報で埋まってしまっていた。creditFloatは
//  precursorCard先頭のワンポイントバッジ（creditFloatBadge）としては
//  引き続き常時表示するが、このセクションへの掲載可否には使わない
//  （バッジ＝補助情報、GOOD/CAUTION_FIELDS＝掲載基準、と役割を分離する）。
// ------------------------------------------------------------------
export const PRECURSOR_GOOD_FIELDS = ['progressStreak', 'dividendPotential', 'hiddenAsset'];
export const PRECURSOR_CAUTION_FIELDS = ['receivablesAnomaly', 'progressStreak'];

export function hasPrecursor(r) {
  return PRECURSOR_GOOD_FIELDS.some((k) => r[k]?.level === 'good')
    || PRECURSOR_CAUTION_FIELDS.some((k) => r[k]?.level === 'warn' || r[k]?.level === 'bad');
}

// ------------------------------------------------------------------
// 米国株版「進捗率加速」— usEarningsTrendSignal
//
//  日本のprogressStreakSignalが使う「対通期/対上期進捗率」という開示
//  形式は米国の会計制度に存在しない（米国企業は日本のような公式な通期
//  進捗率を開示しない）ため直訳できない。代わりにSEC EDGARの四半期
//  売上高・純利益（us_edgar.mjsのextractQuarterlyTrend）を使い、
//  直近四半期の前年同期比成長率で判定する。
//
//  ■ 「約1年前」を実データに基づいてインデックスではなく日付で探す理由
//  US-GAAPの四半期開示には、年度末の第4四半期単独の値がXBRL上に
//  存在しない会社が多い（10-Kは年度累計のみ開示し、Q4単独値は開示側で
//  引き算しないと出てこないため。実データ検証で確認済み: Appleの
//  quarterlyTrendは2025-06-28の次が2025-12-27で、2025-09-27週の
//  単独Q3が欠けている）。そのため「4つ前のインデックス＝1年前」という
//  決め打ちはできず、日付ベースで「約1年前（330〜400日前）に最も近い
//  四半期」を探す。
//
//  ■ 古すぎるデータを「直近」と誤表示しない（実データで発見した重大な穴）
//  一部の会社（実測: BXMTのようなREIT）は、業種特有の収益認識のため
//  ある時点からXBRLの汎用的な売上高タグ（Revenues等）でのquarterly
//  duration開示をやめてしまい、配列の最後の要素が実は10年以上前の
//  データだった、という事例が実際に発生した（quarterlyTrend.at(-1)を
//  無条件に「直近四半期」として使うと「直近四半期(2014-12-31)」という
//  明らかにおかしい表示になっていた）。asOf（実行時点の日付、通常は
//  todayJST()）を渡し、最後の要素があまりに古ければ「データが古すぎて
//  信頼できない」としてchecked:falseにする。
const US_EARNINGS_TREND_MAX_STALE_DAYS = 200; // 四半期開示は通常90日毎なので、2四半期分以上開かなければ許容

// quarterlyTrend[fromIdx]から見て「約1年前（330〜400日前）に最も近い
// 四半期」を探す（usEarningsTrendSignal本体のYoY探索ロジックを、成長の
// 「加速」判定（growthAccelerationSignal、ユーザー提案）用に直近四半期
// 以外にも使えるよう切り出したもの）。
function findYoyQuarter(quarterlyTrend, fromIdx) {
  const fromEnd = new Date(quarterlyTrend[fromIdx].end);
  let yoy = null, yoyDiffDays = Infinity;
  for (let i = fromIdx - 1; i >= 0; i--) {
    const days = (fromEnd - new Date(quarterlyTrend[i].end)) / 86400000;
    if (days < 330) continue; // 1年未満は前年同期にならない
    if (days > 400) break; // これより古いものを見ても近づかない（古い→新しい順のため）
    const diff = Math.abs(days - 365);
    if (diff < yoyDiffDays) { yoy = quarterlyTrend[i]; yoyDiffDays = diff; }
  }
  return yoy;
}

export function usEarningsTrendSignal(quarterlyTrend, asOf = null) {
  if (!Array.isArray(quarterlyTrend) || quarterlyTrend.length === 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const latest = quarterlyTrend.at(-1);
  const latestEnd = new Date(latest.end);
  if (asOf) {
    const staleDays = (new Date(asOf) - latestEnd) / 86400000;
    if (staleDays > US_EARNINGS_TREND_MAX_STALE_DAYS) {
      return { level: null, label: null, note: null, checked: false };
    }
  }
  const yoy = findYoyQuarter(quarterlyTrend, quarterlyTrend.length - 1);
  if (!yoy || !Number.isFinite(latest.revenue) || !Number.isFinite(yoy.revenue) || yoy.revenue <= 0) {
    return { level: null, label: null, note: null, checked: false };
  }
  const revenueGrowthPct = round1(((latest.revenue - yoy.revenue) / yoy.revenue) * 100);
  const hasNetIncome = Number.isFinite(latest.netIncome) && Number.isFinite(yoy.netIncome) && yoy.netIncome > 0;
  const netIncomeGrowthPct = hasNetIncome ? round1(((latest.netIncome - yoy.netIncome) / yoy.netIncome) * 100) : null;
  const niText = netIncomeGrowthPct !== null ? `、純利益は${netIncomeGrowthPct > 0 ? '+' : ''}${netIncomeGrowthPct}%` : '';

  // 成長の「加速」判定（growthAccelerationSignal）用に、1つ前の四半期でも
  // 同様にYoYが計算できれば付随情報として返す（既存フィールドの意味は
  // 変えないので呼び出し側は無改修で動く）。
  let prevRevenueGrowthPct = null;
  if (quarterlyTrend.length >= 2) {
    const prevLatest = quarterlyTrend.at(-2);
    const prevYoy = findYoyQuarter(quarterlyTrend, quarterlyTrend.length - 2);
    if (prevYoy && Number.isFinite(prevLatest.revenue) && Number.isFinite(prevYoy.revenue) && prevYoy.revenue > 0) {
      prevRevenueGrowthPct = round1(((prevLatest.revenue - prevYoy.revenue) / prevYoy.revenue) * 100);
    }
  }

  // 攻めの赤字（aggressiveInvestmentSignal）用。latest/yoyは既に確定
  // 済みなので追加の探索無しで計算できる。R&D非開示企業も多いためnullの
  // ままになるケースを許容する（推測で埋めない）。
  const hasRnd = Number.isFinite(latest.rnd) && Number.isFinite(yoy.rnd) && yoy.rnd > 0;
  const rndGrowthPct = hasRnd ? round1(((latest.rnd - yoy.rnd) / yoy.rnd) * 100) : null;

  if (revenueGrowthPct >= 15 && (netIncomeGrowthPct === null || netIncomeGrowthPct >= 15)) {
    return {
      level: 'good', label: '増収増益が加速', checked: true, revenueGrowthPct, netIncomeGrowthPct, prevRevenueGrowthPct, rndGrowthPct,
      note: `直近四半期(${latest.end})の売上高は前年同期比+${revenueGrowthPct}%${niText}`,
    };
  }
  if (revenueGrowthPct <= -10 || (netIncomeGrowthPct !== null && netIncomeGrowthPct <= -20)) {
    return {
      level: 'bad', label: '減収減益', checked: true, revenueGrowthPct, netIncomeGrowthPct, prevRevenueGrowthPct, rndGrowthPct,
      note: `直近四半期(${latest.end})の売上高は前年同期比${revenueGrowthPct}%${niText}`,
    };
  }
  return { level: null, label: null, note: null, checked: true, revenueGrowthPct, netIncomeGrowthPct, prevRevenueGrowthPct, rndGrowthPct };
}

// 売上高成長の「加速」（ユーザー提案: 前々期+10%→前期+15%→今期+30%の
// ように、伸び率自体が伸びている銘柄を評価する）。テンバガー候補
// （tenbaggerSignal/midCapGrowthSignal）の判定基準は変えず、候補内の
// 並び順を補正する加点シグナルとして使う。growthPct/prevGrowthPctは
// JP側はkabutan.mjs:parseAnnualRevenueYoYの戻り値、US側は
// usEarningsTrendSignalの戻り値（revenueGrowthPct/prevRevenueGrowthPct）
// をそのまま渡せる（通貨非依存・%の比較のみ）。
export function growthAccelerationSignal({ growthPct, prevGrowthPct } = {}) {
  if (![growthPct, prevGrowthPct].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (growthPct > 0 && growthPct > prevGrowthPct) {
    return {
      level: 'good', label: '成長が加速', checked: true,
      note: `売上高成長率が前期の${prevGrowthPct >= 0 ? '+' : ''}${prevGrowthPct}%から今期は${growthPct >= 0 ? '+' : ''}${growthPct}%に加速しています`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ------------------------------------------------------------------
// テンバガー候補（ユーザー提案）— 小時価総額 × 高成長率の持続
//
//  日本株・米国株の両方から呼ぶ市場非依存の比率判定。marketCap/
//  maxMarketCapは呼び出し側で「その通貨の100万単位」に揃えて渡す規約に
//  する（日本は百万円、米国は百万USD。どちらも100万単位という同じ意味の
//  値なので、この関数自体は単位変換をしない＝marketCapYen()のような
//  変換は不要。呼び出し側の値がそもそも揃っていることが前提）。
//
//  ■ ユニバースの制約について（Phase 1の既知の割り切り）
//  日本はsmart_entry.mjsの東証グロース向け成長株予兆スキャン（決算日
//  非依存）、米国はus_tenbagger.mjsの手動キュレーションリスト（同じく
//  決算日非依存）が対象。以前は米国側がus_screener.mjs（AMBUSH、決算
//  T+14〜45日ユニバース）を流用しており、次回決算が窓の外にある銘柄
//  （実測: IONQ・Aurora Innovation/AUR）が機械的に除外される欠陥が
//  あったため、テンバガー探索とAMBUSHは完全に分離した。
//
//  ■ 閾値について
//  minGrowthPct・maxMarketCapとも実運用データが無い状態で決めた初期値。
//  実際にスキャンしてみて該当0件・該当過多になったら調整する前提。
export const TENBAGGER = { minGrowthPct: 25 };

// 実測バグ: noteの時価総額を単位無しの生の数字（例:「時価総額が20,300」）
// で埋め込んでおり、百万円なのか円なのか読者には分からなかった
// （footer chipの「時価総額 ¥20,300M」は単位付きだが、noteの文中数値は
// 独立した文字列で単位が抜けていた）。indicators.mjs自体はJP/US通貨を
// 区別しない設計のため、呼び出し側（smart_entry.mjs='百万円'、
// us_tenbagger.mjs='百万USD'）にunitLabelを渡してもらう。
export function tenbaggerSignal({ marketCap, maxMarketCap, revenueGrowthPct, unitLabel = '' } = {}) {
  if (![marketCap, maxMarketCap, revenueGrowthPct].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (marketCap <= maxMarketCap && revenueGrowthPct >= TENBAGGER.minGrowthPct) {
    return {
      level: 'good', label: 'テンバガー候補', checked: true,
      note: `時価総額が${Math.round(marketCap).toLocaleString()}${unitLabel}（上限${maxMarketCap.toLocaleString()}${unitLabel}以下）と小さく、売上高成長率が前年同期比+${revenueGrowthPct}%と高水準です。小型のうちに成長を捉えられれば大きなリターンが狙えますが、その分値動きも荒く、成長の失速リスクも大きい点に注意してください`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ------------------------------------------------------------------
// 中型成長株候補（Tier B、設計変更版）— テンバガーは無理だが2〜3倍は
// 狙えるグロース中堅株
//
//  ■ 設計変更の経緯（実データで発覚した問題、旧「次世代テンバガー候補」
//  からの再設計）
//  旧版はTier Aの上限を超えた銘柄を上限なしで一律「次世代テンバガー
//  候補」としていたが、実データで運用したところ2つの問題が出た。
//  (1) AUR（時価総額約$118億）が10倍になるには$1,180億（Uber・Intel級）
//  が必要で、「テンバガー候補」と呼ぶには非現実的な目標だった。
//  (2) 402A（時価総額347億円、Tier Aの上限300億円をわずかに超えただけ）
//  とAUR（$118億）が同じ「Tier B」に同居し、時価総額で50倍近い差がある
//  銘柄が同格に扱われ、「時価総額がバラバラすぎる成長株リスト」になって
//  いた。この2点を踏まえ、Tier Bに上限を設け（日本1000億円/米国$10B）、
//  「テンバガー」ではなく「2〜3倍程度が狙えるグロース中堅株」という
//  現実的な期待値に定義し直した。IONQ（$158億）・AUR（$118億）は新しい
//  上限を超えるため候補から外れる（テンバガー候補としては非現実的な
//  規模と判断）。
//
//  ■ 実装しないこと（Phase 1の既知の限界）
//  TAM・受注/RPO/ARR成長率・市場シェア拡大は、無料で継続取得できる
//  データソースが無いため対象外。売上高成長率のみによる簡易判定。
export const MID_CAP_GROWTH = { minGrowthPct: 25 };

export function midCapGrowthSignal({ marketCap, maxMarketCap, revenueGrowthPct, unitLabel = '' } = {}) {
  if (![marketCap, maxMarketCap, revenueGrowthPct].every(Number.isFinite)) {
    return { level: null, label: null, note: null, checked: false };
  }
  if (marketCap <= maxMarketCap && revenueGrowthPct >= MID_CAP_GROWTH.minGrowthPct) {
    return {
      level: 'good', label: '中型成長株候補', checked: true,
      note: `時価総額${Math.round(marketCap).toLocaleString()}${unitLabel}（上限${maxMarketCap.toLocaleString()}${unitLabel}以下）・売上高成長率は前年同期比+${revenueGrowthPct}%です。この規模からの10倍（テンバガー）達成は現実的ではありませんが、2〜3倍程度の成長余地は狙える水準です。Tier A（低時価総額のテンバガー候補）とは前提が異なる点にご注意ください`,
    };
  }
  return { level: null, label: null, note: null, checked: true };
}

// ------------------------------------------------------------------
// 仕込み妙味スコア（Repricing Lag、ユーザー提案）
//
//  目的は「割安株」を探すことではなく、「業績・材料の改善に対して株価の
//  織り込みが遅れている銘柄」を検出すること。既存のretailExpectation
//  Signalは「既に織り込まれつつある」方向の警告のみで、逆方向（まだ
//  織り込まれていない）を積極的にスコア化する仕組みが無かったため新設。
//
//  ■ 100点満点の内訳（ユーザー指定の配点をそのまま採用）
//  未織り込み度25 + 業績改善25 + 株価割安度15 + 成長率15 + 先行材料10
//  + 今後のイベント10。各サブスコアの具体的な区切り値（tier）は
//  ユーザー指定の例には無かったため、この実装時点での初期値であり、
//  実データを見ながら調整する前提。
//
//  ■ 「割安」と「仕込みどき」を混同しない設計
//  株価割安度(15点)は他のサブスコアの1つに過ぎず、未織り込み度・業績
//  改善・成長率と独立して積み上げる。安いだけで成長していない銘柄は
//  improvement/growthが0点のままなので高スコアにはならない
//  （実測: ハンモック(173A)のような「PERは低いが成長が鈍化している」
//  銘柄を上位に出さないための構造）。
//
//  ■ オーバーライドルール
//  直近1ヶ月・3ヶ月の騰落率が大きければ、スコアの内訳に関係なく強制的に
//  zone:'priced_in'（🔴織り込み済み・新規仕込み対象から除外）にする。
//
//  ■ 日本株・米国株の非対称性について
//  - priceLevelPct: 日本株は直近60営業日（約3ヶ月）レンジでの位置、
//    米国株も同じ関数（priceLevelVsRange）で計算するため対称。
//  - per/sectorPer: 日本株は業種平均PERとの比較が可能（lowPbrSignalと
//    同じデータ源）。米国株はセクター平均PERを算出する仕組みが無い
//    （Phase 1の既知の限界）ため、psrによる代替評価にフォールバックする。
//  - hasCatalyst: 日本株はTDnetの先行材料開示を使えるが、米国株には
//    相当するデータ源が無いため常にfalse（Phase 1の既知の限界）。
export const REPRICING_LAG = {
  surgeReturn1mPct: 20, // 1ヶ月+20%以上は「既に織り込み済み」とみなす
  surgeReturn3mPct: 40, // 3ヶ月+40%以上も同様
  preMovePriceLevelMax: 30, // 60日レンジの下位30%以内なら「株価反応小」
  earlyMoveReturn1mMax: 10, // 1ヶ月+10%未満ならまだ「初動」段階
};

function growthTier(pct, tiers) {
  if (!Number.isFinite(pct)) return 0;
  for (const t of tiers) if (pct >= t.min) return t.pt;
  return 0;
}

export function repricingLagScore({
  return1m, return3m, priceLevelPct,
  revenueGrowthPct, profitGrowthPct,
  per, sectorPer, psr,
  hasCatalyst, daysToEarnings,
} = {}) {
  const untapped = Number.isFinite(priceLevelPct) ? round1(25 * (1 - priceLevelPct / 100)) : 0;

  const improvement = round1(
    growthTier(revenueGrowthPct, [{ min: 25, pt: 12.5 }, { min: 10, pt: 8 }, { min: 0, pt: 4 }])
    + growthTier(profitGrowthPct, [{ min: 25, pt: 12.5 }, { min: 10, pt: 8 }, { min: 0, pt: 4 }])
  );
  const growth = round1(
    growthTier(revenueGrowthPct, [{ min: 30, pt: 7.5 }, { min: 15, pt: 5 }, { min: 5, pt: 2.5 }])
    + growthTier(profitGrowthPct, [{ min: 30, pt: 7.5 }, { min: 15, pt: 5 }, { min: 5, pt: 2.5 }])
  );

  // 株価割安度(15): 業種平均PERとの比較を優先（sectorPerが無ければPSRで代替）。
  let valuation = 0;
  if (Number.isFinite(per) && Number.isFinite(sectorPer) && sectorPer > 0) {
    const ratio = per / sectorPer;
    valuation = ratio <= 0.7 ? 15 : ratio <= 1.0 ? 10 : ratio <= 1.3 ? 5 : 0;
  } else if (Number.isFinite(psr)) {
    valuation = psr <= 1 ? 15 : psr <= 3 ? 10 : psr <= 6 ? 5 : 0;
  }

  const catalyst = hasCatalyst ? 10 : 0;

  let event = 0;
  if (Number.isFinite(daysToEarnings) && daysToEarnings >= 0) {
    event = daysToEarnings <= 14 ? 10 : daysToEarnings <= 30 ? 7 : daysToEarnings <= 60 ? 4 : 1;
  }

  const score = Math.max(0, Math.min(100, round1(untapped + improvement + valuation + growth + catalyst + event)));

  const alreadySurged = (Number.isFinite(return1m) && return1m >= REPRICING_LAG.surgeReturn1mPct)
    || (Number.isFinite(return3m) && return3m >= REPRICING_LAG.surgeReturn3mPct);

  // 判定に最低限必要なデータ（株価の位置と業績改善の両方）が無ければ、
  // ゾーンを無理に決め打ちしない（他のchecked flagパターンと同じ思想）。
  const hasMinimumData = Number.isFinite(priceLevelPct) && (Number.isFinite(revenueGrowthPct) || Number.isFinite(profitGrowthPct));

  // 実測バグ: alreadySurged（直近1ヶ月/3ヶ月の騰落率だけで判定できる）は
  // priceLevelPct/成長率が無くても確定的に真偽が分かるのに、checkedを
  // hasMinimumDataだけで決めていたため、株価が既に急騰したことは分かって
  // いるのに「判定不可（灰色）」と表示され、🔴織り込み済みの警告が
  // scraper.mjs側（checked===trueをゲートにしている）で握りつぶされて
  // いた（実測: 584A・581Aがzone:'priced_in'なのにchecked:falseのため
  // 警告バッジが出ていなかった）。alreadySurgedはhasMinimumDataとは
  // 独立に「確定的に判定できた」ことを意味するので、OR条件にする。
  const checked = hasMinimumData || alreadySurged;

  let zone = null;
  if (alreadySurged) {
    zone = 'priced_in';
  } else if (hasMinimumData) {
    if (priceLevelPct <= REPRICING_LAG.preMovePriceLevelMax
        && (!Number.isFinite(return1m) || return1m < REPRICING_LAG.earlyMoveReturn1mMax) && improvement > 0) {
      zone = 'pre_move';
    } else if (Number.isFinite(return1m) && return1m >= REPRICING_LAG.earlyMoveReturn1mMax) {
      zone = 're_rating';
    } else if (improvement > 0) {
      zone = 'early_move';
    } else {
      zone = 're_rating'; // 業績改善が無いのに株価だけ位置が高い、等の消極ケース
    }
  }

  return { score, zone, breakdown: { untapped, improvement, valuation, growth, catalyst, event }, checked };
}
