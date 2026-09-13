// ==================================================================
// policy_catalyst_score.mjs — POLICY CATALYST SCORE(Phase3)
//
// Phase3の目的は「政策材料とBUY SCOREを合成すること」ではなく、
// 「政策材料がBUY SCOREだけでは拾えない追加情報を持っているかを
// 検証すること」。この検証のために、まず独立スコアを作って横に
// 並べられるようにする(このファイルの役割はここまで。合成の判断は
// 十分なNが溜まってから別途行う)。
//
// IMPORTANT(ユーザー指示、必ず守ること):
//  - theme/direction/tier/primary_theme/既存BUY SCORE/EXPECTATION/
//    SURPRISE/UNPRICED/TIMINGを直接変更しない(このファイルはrを
//    受け取って新しいオブジェクトを返すだけで、rを書き換えない)
//  - UNPRICEDは既存のr.repricingLag.score(BUY SCOREが内部で使って
//    いるのと同じ値、buildScoreParts参照)をそのまま使う。
//    unpricedScore(kairi)のような別の「未織り込み度」を新たに
//    計算しない(=UNPRICEDの二重評価を避ける)
//  - 同一銘柄に複数の政策イベントがあっても、代表イベント(policy_
//    catalyst.mjsのbuildPolicyCatalystByCodeがtopScoreとして選んだ
//    ものと同じ、最大スコアのイベント)だけを使う。平均すると強い
//    材料が薄まり、合計すると多重計上になるため使わない
// ==================================================================

export const POLICY_CATALYST_WEIGHTS = { policy: 0.40, unpriced: 0.30, timing: 0.15, exposure: 0.15 };

// ①「既に織り込み済み」検知(ユーザー指示、必ず守ること):
// 加重平均(score)は4要素を1つの数字に潰すため、「政策は強いがUNPRICEDは
// 低い(=もう株価に織り込まれている)」という矛盾した組み合わせが平均されて
// 「そこそこ強い」に見えてしまい、埋もれる。verdictはscoreとは独立に、
// policyとunpriced の生の値の組み合わせだけを見て判定する。
// これは新しい合成スコアを増やすものではなく、除外条件(exclusion)である:
// 「加点する」のではなく「強いのに買う理由が別問題、と警告する」ためだけに使う。
export const POLICY_STRONG_THRESHOLD = 70;
export const UNPRICED_LOW_THRESHOLD = 40;

// STRONG               : 政策が強く、UNPRICEDも十分残っている(素直に強い)
// PRICED_IN_RISK       : 政策は強いが、UNPRICEDが低い(=既に株価に織り込み済みの可能性)
// STRONG_UNKNOWN_PRICING: 政策は強いが、UNPRICED自体が判定不能(r.repricingLag未チェック等)
// WEAK                  : 政策そのものが強くない(UNPRICEDの値に関わらず「弱い」)
export function computePriceInRiskVerdict(policy, unpriced) {
  if (!Number.isFinite(policy) || policy < POLICY_STRONG_THRESHOLD) return 'WEAK';
  if (!Number.isFinite(unpriced)) return 'STRONG_UNKNOWN_PRICING';
  if (unpriced <= UNPRICED_LOW_THRESHOLD) return 'PRICED_IN_RISK';
  return 'STRONG';
}

// time_horizon(Python側revenue_horizon、業績・受注への到達時期) → スコア。
// 近いほど「今から効いてくる」ため高得点。MJS既存のTIMING(BUY SCOREの
// 内訳、決算までの日数から見たエントリーの値動きタイミング)とは別概念
// なので、あえて別の変換テーブルにする(混同して同じ意味だと扱わない)。
const TIMING_SCORE_BY_HORIZON = { '0-3m': 100, '3-6m': 70, '6-12m': 40, '12m+': 15 };

// tier(direct/indirect、Python側beneficiary_tier) → 恩恵の直接度。
// 現状Python側には0-1の連続値のpolicy_exposureが無い(バックログ入り、
// 未実装)ため、暫定的な粗いマッピングとして使う。連続値が来たら
// この関数だけ差し替えればよい設計にしてある。
const EXPOSURE_SCORE_BY_TIER = { direct: 100, indirect: 60 };

// 複数イベントがある場合の代表イベント選択。policy_catalyst.mjsの
// buildPolicyCatalystByCode()と同じ「最大値を代表とする」考え方を
// 流用する(平均・合計は二重計上になるため使わない)。
function pickTopEvent(entry) {
  return entry.events.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a));
}

// entry: policy_catalyst.mjsのbyCode[code](= {topScore, events:[...]})
// r    : AMBUSH/SMART ENTRYの結果オブジェクト(r.repricingLagを参照するだけ、
//        書き換えない)
//
// 戻り値: { score, confidence, parts, theme, reason, eventId } または、
// 政策材料が無ければnull(=既存の画面に何も追加しない)。
export function computePolicyCatalystScore(entry, r) {
  if (!entry || !Array.isArray(entry.events) || entry.events.length === 0) return null;
  const top = pickTopEvent(entry);

  const policy = Number.isFinite(entry.topScore) ? entry.topScore
    : (Number.isFinite(top.score) ? top.score : null);
  const unpriced = r?.repricingLag?.checked && Number.isFinite(r.repricingLag.score)
    ? r.repricingLag.score : null;
  const timing = TIMING_SCORE_BY_HORIZON[top.horizon] ?? null;
  const exposure = EXPOSURE_SCORE_BY_TIER[top.tier] ?? null;

  const parts = { policy, unpriced, timing, exposure };

  // データが無い要素は分母からも除外して再配点する(buyScore等の
  // weightedCompositeと同じ考え方。欠損はスコアを下げず、CONFIDENCEを
  // 下げるだけにする)。
  let weightedSum = 0;
  let weightUsed = 0;
  for (const [key, w] of Object.entries(POLICY_CATALYST_WEIGHTS)) {
    const v = parts[key];
    if (!Number.isFinite(v)) continue;
    weightedSum += v * w;
    weightUsed += w;
  }
  if (weightUsed === 0) return null;

  return {
    score: Math.round(weightedSum / weightUsed),
    confidence: Math.round(weightUsed * 100),
    parts,
    verdict: computePriceInRiskVerdict(parts.policy, parts.unpriced),
    theme: top.theme || top.primaryTheme || '',
    direction: top.direction, // Python側の値をそのまま透過する(ここでは再判定しない)
    reason: top.reason || '',
    eventId: top.eventId,
  };
}
