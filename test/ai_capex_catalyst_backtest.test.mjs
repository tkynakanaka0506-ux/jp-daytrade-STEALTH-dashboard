// ai_capex_catalyst_backtest.mjs のテスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  recordAiCapexCatalystSnapshot, loadAiCapexCatalystBacktest, aiCapexCatalystBacktestStatus,
} from '../ai_capex_catalyst_backtest.mjs';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'accb-')), 'cache.json');
}

function sampleR(overrides = {}) {
  return {
    code: '8035', name: '東京エレクトロン', price: 30000,
    buyScore: { score: 72, confidence: 80, detail: { unpriced: { value: 40 }, timing: { value: 60 } } },
    expectationScore: { score: 60 },
    earningsSurpriseScore: { score: 50 },
    sig1: { level: null, label: 'N/A', note: null },
    sig2: { level: null, label: 'N/A', note: null },
    sig3: { level: null, label: 'N/A', note: null },
    ...overrides,
  };
}

test('aiCapexCatalystが無い銘柄は記録しない', () => {
  const file = tmpFile();
  const added = recordAiCapexCatalystSnapshot('2026-09-13', [sampleR()], file);
  assert.equal(added, 0);
});

test('eventsもriskFlagsも空の銘柄は記録しない', () => {
  const file = tmpFile();
  const r = sampleR({ aiCapexCatalyst: { topScore: 0, events: [], riskFlags: [] } });
  const added = recordAiCapexCatalystSnapshot('2026-09-13', [r], file);
  assert.equal(added, 0);
});

test('スコア付き材料があれば記録し、aiCapexImpactScoreとriskFlagCountを両方保存する', () => {
  const file = tmpFile();
  const r = sampleR({
    aiCapexCatalyst: {
      topScore: 88,
      events: [{ eventId: 'e1', theme: 'AI設備投資サイクル', direction: 'positive', score: 88, reason: 'テスト' }],
      riskFlags: [],
    },
  });
  const added = recordAiCapexCatalystSnapshot('2026-09-13', [r], file);
  assert.equal(added, 1);
  const hist = loadAiCapexCatalystBacktest(file);
  const row = hist['2026-09-13']['8035|e1'];
  assert.equal(row.aiCapexImpactScore, 88);
  assert.equal(row.riskFlagCount, 0);
  assert.equal(row.buyScore, 72, '既存BUY SCOREも同じスナップショットに記録する');
});

test('riskFlagsだけ(ai_demand_risk)の銘柄も記録するが、aiCapexImpactScoreはtopScore(=0)のまま', () => {
  const file = tmpFile();
  const r = sampleR({
    aiCapexCatalyst: {
      topScore: 0,
      events: [],
      riskFlags: [{ eventId: 'e2', theme: 'AI投資の資金負担リスク', reason: 'FCF急減' }],
    },
  });
  const added = recordAiCapexCatalystSnapshot('2026-09-13', [r], file);
  assert.equal(added, 1);
  const hist = loadAiCapexCatalystBacktest(file);
  const row = hist['2026-09-13']['8035|risk-only'];
  assert.equal(row.riskFlagCount, 1);
  assert.equal(row.aiCapexImpactScore, 0, 'riskFlagsはスコアに変換しない(0のまま)');
  assert.equal(row.eventId, null);
});

test('同じ日に複数回呼んでも最初の1回だけが残り上書きされない', () => {
  const file = tmpFile();
  const r = sampleR({
    aiCapexCatalyst: { topScore: 88, events: [{ eventId: 'e1', theme: 't', direction: 'positive', score: 88 }], riskFlags: [] },
  });
  recordAiCapexCatalystSnapshot('2026-09-13', [r], file);
  const r2 = sampleR({
    aiCapexCatalyst: { topScore: 20, events: [{ eventId: 'e1', theme: 't', direction: 'positive', score: 20 }], riskFlags: [] },
  });
  const added = recordAiCapexCatalystSnapshot('2026-09-13', [r2], file);
  assert.equal(added, 0);
  const hist = loadAiCapexCatalystBacktest(file);
  assert.equal(hist['2026-09-13']['8035|e1'].aiCapexImpactScore, 88, '最初に記録した値が保たれる');
});

test('同一銘柄が別の政策/イベント(eventId違い)なら別サンプルとして記録される', () => {
  const file = tmpFile();
  const r1 = sampleR({
    aiCapexCatalyst: { topScore: 88, events: [{ eventId: 'e1', theme: 't1', direction: 'positive', score: 88 }], riskFlags: [] },
  });
  const r2 = sampleR({
    aiCapexCatalyst: { topScore: 60, events: [{ eventId: 'e2', theme: 't2', direction: 'positive', score: 60 }], riskFlags: [] },
  });
  recordAiCapexCatalystSnapshot('2026-09-13', [r1], file);
  const added = recordAiCapexCatalystSnapshot('2026-09-13', [r2], file);
  assert.equal(added, 1);
});

test('aiCapexCatalystBacktestStatus: 蓄積日数・件数を正しく集計する', () => {
  const file = tmpFile();
  const r = sampleR({
    aiCapexCatalyst: { topScore: 88, events: [{ eventId: 'e1', theme: 't', direction: 'positive', score: 88 }], riskFlags: [] },
  });
  recordAiCapexCatalystSnapshot('2026-09-13', [r], file);
  const status = aiCapexCatalystBacktestStatus(file);
  assert.equal(status.days, 1);
  assert.equal(status.totalSnapshots, 1);
  assert.equal(status.firstDate, '2026-09-13');
});

test('aiCapexCatalystBacktestStatus: ファイルが無ければ0件で返す(クラッシュしない)', () => {
  const status = aiCapexCatalystBacktestStatus('/nonexistent/file.json');
  assert.equal(status.days, 0);
  assert.equal(status.totalSnapshots, 0);
});
