// ==================================================================
// policy_catalyst_compare.mjs — POLICY CATALYST 競合比較(③)
//
// 同じ政策テーマに複数の受益銘柄がぶら下がっている場合、「政策が強い」
// だけでは銘柄間の優劣がわからない(例: 造船政策でA/B/C社が全部positiveでも
// 同列に扱うべきではない)。既存のentryPriorityScore.detail(未織り込み・
// 成長加速・バリュエーション・需給。いずれも新規計算はせず、既に
// attachScores()で計算済みの値をそのまま参照するだけ)で銘柄間を比較し、
// 「同じ政策テーマの中で一番仕込む価値があるのはどこか」のランキングを作る。
//
// IMPORTANT(必ず守ること):
//  - BUY SCORE / entryPriorityScore / policyCatalystScore 自体の値は
//    一切変更しない(参照するだけ。ここで新しい合成スコアは作らない)
//  - 比較対象は「今回のビルドでentryPriorityScoreが計算済みの銘柄」に限る
//    (AMBUSH/SMART ENTRYの足切りを通らなかった政策材料銘柄はここでは
//    比較できないという既知の限界がある。対象を広げるには専用フェッチが
//    別途必要で、このモジュールの範囲外)
//  - 比較する相手がいない(テーマ内1銘柄だけの)場合は結果に含めない
// ==================================================================

// entryPriorityScoreの重み順(未織り込み25 > 成長加速20 > バリュエーション15
// > 需給10)に合わせたカスケード比較。「業績感応度」は成長加速(growthAccel)
// を代理指標として使う(既存フィールドの中で最も近い概念のため)。
const COMPARE_AXES = ['untapped', 'growthAccel', 'valuation', 'supplyDemand'];
export const AXIS_LABEL = {
  untapped: '未織り込み', growthAccel: '業績感応度', valuation: 'バリュエーション', supplyDemand: '需給',
};

function axisValue(r, axis) {
  const v = r.entryPriorityScore?.detail?.[axis]?.value;
  return Number.isFinite(v) ? v : null;
}

// データが無い(null)軸は「不利」とはみなさず、値がある方を優先するだけで
// 次の軸に進む(null同士なら次の軸で決める)。全軸nullなら同点(0)。
function compareStocks(a, b) {
  for (const axis of COMPARE_AXES) {
    const av = axisValue(a, axis);
    const bv = axisValue(b, axis);
    if (av === null && bv === null) continue;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av !== bv) return bv - av;
  }
  return 0;
}

// policyCatalystScore.parts.exposureは100(direct)/60(indirect)のスコア値
// (policy_catalyst_score.mjsのEXPOSURE_SCORE_BY_TIER参照)。生のtier文字列
// ではなくここから逆引きするのは、r.policyCatalystの複数イベントを
// 再走査せずに済ませるため(policyCatalystScoreは既にtopScoreに紐づく
// 代表イベントの値を持っている)。
function tierLabelFromExposure(exposure) {
  if (exposure >= 100) return '直接';
  if (exposure >= 60) return '間接';
  return null;
}

// results: attachScores()・attachPolicyCatalyst()適用済みの配列を想定
// (amb.results/smart.resultsをそのまま、または結合して渡す)。
// 同じ銘柄が複数の配列に重複して出てくる場合は最初に見つかった方を使う。
export function groupPolicyCatalystByTheme(results) {
  const byTheme = new Map();
  const seenCodes = new Set();
  for (const r of results ?? []) {
    const pcs = r.policyCatalystScore;
    const theme = pcs?.theme;
    if (!theme) continue;
    const dedupeKey = `${theme}|${r.code}`;
    if (seenCodes.has(dedupeKey)) continue;
    seenCodes.add(dedupeKey);
    if (!byTheme.has(theme)) byTheme.set(theme, []);
    byTheme.get(theme).push(r);
  }

  const comparisons = [];
  for (const [theme, stocks] of byTheme.entries()) {
    if (stocks.length < 2) continue; // 比較する相手がいなければ意味が無い
    const ranked = [...stocks].sort(compareStocks).map((r, i) => ({
      rank: i + 1,
      code: r.code,
      name: r.name,
      verdict: r.policyCatalystScore?.verdict ?? null,
      policyImpactScore: r.policyCatalystScore?.parts?.policy ?? null,
      tierLabel: Number.isFinite(r.policyCatalystScore?.parts?.exposure)
        ? tierLabelFromExposure(r.policyCatalystScore.parts.exposure) : null,
      axes: Object.fromEntries(COMPARE_AXES.map((axis) => [axis, axisValue(r, axis)])),
    }));
    comparisons.push({ theme, stocks: ranked });
  }
  // テーマ内の最上位銘柄のpolicyImpactScoreが高い順(=より材料が強い
  // テーマ比較から先に見せる)。同点ならテーマ名で安定ソート。
  comparisons.sort((a, b) => (b.stocks[0].policyImpactScore ?? 0) - (a.stocks[0].policyImpactScore ?? 0)
    || a.theme.localeCompare(b.theme));
  return comparisons;
}
