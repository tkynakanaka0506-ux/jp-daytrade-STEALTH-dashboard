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
