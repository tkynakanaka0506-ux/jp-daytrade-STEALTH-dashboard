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

// v7.3改修 項目6: 「先行材料あり/なし」の2値からS/A/B/Cランクへ強弱化。
test('evaluate: 上方修正はSランク・100点換算スコアも返す（項目6: カタリストの強弱化）', () => {
  const ev = evaluate([{ date: '2026-08-01', title: '業績の上方修正に関するお知らせ' }]);
  assert.equal(ev.tier, 'S');
  assert.equal(ev.score100, 100); // score30(上限)/30*100
});

test('evaluate: 複数の好材料があれば最も強いtierを採用する（開示の時系列順ではなく重大度順）', () => {
  const ev = evaluate([
    { date: '2026-08-01', title: '新製品の発売に関するお知らせ' }, // Aランク・先
    { date: '2026-08-02', title: '業績の上方修正に関するお知らせ' }, // Sランク・後
  ]);
  assert.equal(ev.tier, 'S', '時系列では後から出てきたSランクを見落とさない');
});

test('evaluate: 好材料が無く方向不明の業績予想修正だけあればCランク（弱い材料）', () => {
  const ev = evaluate([{ date: '2026-08-01', title: '業績予想の修正に関するお知らせ' }]);
  assert.equal(ev.tier, 'C');
});

test('evaluate: 開示が1件も無ければtier:null（score:nullと同じ扱い）', () => {
  const ev = evaluate([]);
  assert.equal(ev.tier, null);
  assert.equal(ev.score100, null);
});

test('evaluate: 好材料(tier)と正味スコア(score100)は別の意味を持つ（実測: 「契約締結」(Aランク・+10)と「中止」(-14)が同時に開示され、tier=Aなのにscore100=0になるケース。矛盾ではなく「見つかった最強の好材料」と「悪材料相殺後の正味点」という別軸である）', () => {
  const ev = evaluate([
    { date: '2026-08-24', title: '（開示事項の変更）自己株式の消却中止に関するお知らせ' },
    { date: '2026-08-31', title: 'コミットメントライン契約締結に関するお知らせ' },
  ]);
  assert.equal(ev.tier, 'A'); // 見つかった好材料自体はAランク
  assert.equal(ev.score, 0); // raw=10-14=-4はMath.max(0,...)で0にクランプ
  assert.equal(ev.score100, 0);
});

test('evaluate: 実測で0件だった追加キーワード（規制緩和・大型案件・KPI急改善）はマッチしない（意図的に未実装。「認可」が「承認可決」に誤マッチする実測トラップも回避する）', () => {
  const ev = evaluate([{ date: '2026-08-01', title: '株式交換契約に係る定時株主総会の承認可決に関するお知らせ' }]);
  assert.equal(ev.tier, null);
  assert.equal(ev.positives.length, 0);
});

// v7.3改修 項目8: 減点ではなくハード除外すべき「重大リスク」の検出。
test('evaluate: 株式等売渡請求（スクイーズアウト）はsevereRiskHitsに入る（screener.mjs側で候補一覧からハード除外する対象）', () => {
  const ev = evaluate([{ date: '2026-08-10', title: '当社株券等に対する株式等売渡請求を行うことの決定に関するお知らせ' }]);
  assert.equal(ev.severeRiskHits.length, 1);
  assert.equal(ev.severeRiskHits[0].label, '上場廃止（スクイーズアウト）');
});

test('evaluate: 大量行使・大量転換（希薄化が進行中の実測タイトル）もsevereRiskHitsに入る', () => {
  const ev1 = evaluate([{ date: '2026-08-01', title: '第三者割当により発行された第７回新株予約権（行使価額修正条項付）の大量行使に関するお知らせ' }]);
  assert.equal(ev1.severeRiskHits.length, 1);
  assert.equal(ev1.severeRiskHits[0].label, '大規模希薄化（大量行使）');

  const ev2 = evaluate([{ date: '2026-08-01', title: '第三者割当により発行された第１回無担保転換社債型新株予約権付社債（転換価額修正条項付）の大量転換に関するお知らせ' }]);
  assert.equal(ev2.severeRiskHits.length, 1);
  assert.equal(ev2.severeRiskHits[0].label, '大規模希薄化（大量転換）');
});

test('evaluate: severeなkw以外の悪材料（下方修正・無配など）はsevereRiskHitsに入らない（除外ではなく減点のまま）', () => {
  const ev = evaluate([{ date: '2026-08-01', title: '無配に関するお知らせ' }]);
  assert.equal(ev.negatives.length, 1);
  assert.equal(ev.severeRiskHits.length, 0);
});

test('evaluate: 悪材料が無ければsevereRiskHitsは空配列（nullではない）', () => {
  const ev = evaluate([{ date: '2026-08-01', title: '業務提携に関するお知らせ' }]);
  assert.deepEqual(ev.severeRiskHits, []);
});
