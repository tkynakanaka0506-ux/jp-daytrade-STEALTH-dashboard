// ==================================================================
// policy_catalyst.mjs — POLICY CATALYST
//
// 別リポジトリ(jp-daytrade-dashboard、Python製のニュース→政策テーマ
// ルールエンジン)が書き出す policy_catalyst_signals.json を読み込み、
// 銘柄コード別に集約するだけのモジュール。
//
// IMPORTANT(Phase2のスコープ、必ず守ること):
//  - BUY SCOREを変更しない
//  - EXPECTATION / SURPRISE / UNPRICED / TIMINGを変更しない
//  - direction/theme/tierを再判定しない(Python側で確定した値をそのまま使う)
//  - 既存のAMBUSH / SMART ENTRYの順位ロジックを書き換えない
//
// Python側の役割 = 「何が起きたか」(FACTUAL LAYER)。
// このモジュールの役割 = それを読み込んで銘柄別に引けるようにするだけ。
// 「今買う価値があるか」の判断(BUY SCOREとの統合)はPhase3以降。
// ==================================================================

import fs from 'node:fs';

// JSONの読み込み。ファイルが無い/壊れている/期待した形でない場合も
// 例外を投げず、呼び出し側(scraper.mjs)を止めない。
export function loadPolicyCatalystData(jsonPath) {
  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf-8');
  } catch (e) {
    return { available: false, reason: `ファイル読み込み失敗: ${e?.message ?? e}` };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { available: false, reason: `JSON解析失敗: ${e?.message ?? e}` };
  }
  if (!data || !Array.isArray(data.events)) {
    return { available: false, reason: 'events配列が見つからない(スキーマ不一致の可能性)' };
  }
  return { available: true, events: data.events, generatedAt: data.generated_at ?? null };
}

// 銘柄コード別に集約する。
//
// 同一銘柄に複数の政策イベントが同時に存在しうる(例: 三菱重工に防衛政策・
// 造船政策・サイバー政策が同時に立つ)。代表スコア(topScore)は最大値を
// 採用する。平均すると強い材料が薄まり、合計すると多重計上になるため。
// 元イベントは1件も失わず events 配列にすべて保持する(表示側で
// 「他にもこの銘柄に効いている材料がある」ことを追跡できるようにするため)。
//
// 同一policy_event_id(=Python側で束ねた同じ政策の続報系列)は、
// 公開日時が一番新しいものだけを残す(束ねた続報を別々の材料として
// 多重計上しないため。policy_event_idが無い=ライフサイクル未追跡の
// ニュースは従来通りnews idがそのままevent_idになるので、無関係な
// ニュース同士が誤って集約されることはない)。
// policy_event_state===CLOSED(施策実施済み)の政策は、既に実現した話で
// 「今から乗る材料」ではなくなっているため、この集約自体から除外する。
export function buildPolicyCatalystByCode(events) {
  const byCodeMap = {};
  for (const event of events ?? []) {
    if (event.policy_event_state === 'CLOSED') continue;
    for (const stock of event.stocks ?? []) {
      const code = stock?.code;
      if (!code) continue;
      const score = stock.policy_impact_score ?? event.policy_impact_score ?? null;
      const entry = {
        eventId: event.event_id,
        theme: stock.theme || event.theme || '',
        primaryTheme: event.primary_theme || '',
        direction: stock.impact, // Python側で確定した値をそのまま使う(再判定しない)
        tier: stock.tier ?? null,
        maturity: event.policy_maturity ?? null,
        horizon: event.time_horizon ?? null,
        score,
        matchedKeyword: event.matched_keyword ?? null,
        reason: event.reason ?? '',
        source: event.source ?? '',
        url: event.url ?? '',
        publishedAt: event.published_at ?? '',
      };
      if (!byCodeMap[code]) byCodeMap[code] = new Map();
      const existing = byCodeMap[code].get(entry.eventId);
      if (!existing || entry.publishedAt >= (existing.publishedAt || '')) {
        byCodeMap[code].set(entry.eventId, entry);
      }
    }
  }
  const byCode = {};
  for (const [code, map] of Object.entries(byCodeMap)) {
    const entries = [...map.values()];
    const topScore = entries.reduce((max, e) => Math.max(max, e.score ?? 0), 0);
    byCode[code] = { topScore, events: entries };
  }
  return byCode;
}

// scraper.mjs から呼ぶ想定の一括ロード関数。
// 読み込みに失敗しても available:false を返すだけで、呼び出し側は
// 「POLICY CATALYST unavailable」として扱えばよく、既存処理は止まらない。
export function loadPolicyCatalystByCode(jsonPath) {
  const data = loadPolicyCatalystData(jsonPath);
  if (!data.available) {
    return { available: false, reason: data.reason, byCode: {} };
  }
  return { available: true, byCode: buildPolicyCatalystByCode(data.events), generatedAt: data.generatedAt };
}
