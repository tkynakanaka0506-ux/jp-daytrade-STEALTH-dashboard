// tdnet.mjsの適時開示ルールベース評価の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../tdnet.mjs';

test('スクイーズアウトによる上場廃止決定はNOISE扱いにならず、最重要の悪材料として拾われる', () => {
  // 実測バグ: NOISE正規表現に「上場廃止に関する」が含まれており、
  // 3480ジェイ・エス・ビーの株式等売渡請求（スクイーズアウト）決定の
  // 開示が無条件で無視され、warningsが空のまま様子見表示が続いていた。
  const disclosures = [{
    date: '2026-08-10',
    title: 'Ｕｒｓａ４株式会社による当社株券等に対する株式等売渡請求を行うことの決定、当該株式等売渡請求に係る承認及び当社株式の上場廃止に関するお知らせ',
  }];
  const ev = evaluate(disclosures);
  assert.equal(ev.negatives.length, 1);
  assert.equal(ev.negatives[0].label, '上場廃止（スクイーズアウト）');
  assert.equal(ev.score, 0); // 最重要の悪材料なのでPRスコアは最低
});

test('通常の訂正（既存開示の一部訂正）は二重加点しない', () => {
  const disclosures = [
    { date: '2026-08-01', title: '業務提携に関するお知らせ' },
    { date: '2026-08-02', title: '（訂正）「業務提携に関するお知らせ」の一部訂正について' },
  ];
  const ev = evaluate(disclosures);
  assert.equal(ev.positives.length, 1); // 訂正側はNOISEで除外され二重加点しない
});

test('好材料と悪材料が同居する場合は悪材料が優先して抑え込む', () => {
  const disclosures = [
    { date: '2026-08-01', title: '業績の下方修正に関するお知らせ' },
    { date: '2026-08-02', title: '新製品の発売に関するお知らせ' },
  ];
  const ev = evaluate(disclosures);
  assert.equal(ev.score, 0);
});
