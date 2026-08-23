// scraper.mjsの「自分ルール」チェックリスト(buyRuleChecklist)の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyRuleChecklist, bottomChips, consensusEvidenceBlock, signalRow, ceilingPriceNote, smartEntryCard, convictionNote } from '../scraper.mjs';
import { VALUATION_CHIP_FIELDS, reboundPatternSignal, laggingPatternSignal } from '../indicators.mjs';

const chipLabels = (html) => [...html.matchAll(/>([^<]+)<\/span>/g)].map((m) => m[1]);

const row = (rows, label) => rows.find((r) => r.label === label);

test('需給: marginOverhangがbadでもsqueezeがgoodならOK扱いにする（OR条件）', () => {
  // 実測バグ: 「信用倍率が過度に高くない、または空売りが積み上がっている」
  // というOR条件のはずが、marginOverhangだけを見ておりsqueezeを無視していた
  // （6966三井ハイテックで両方成立していたのに需給✗と誤表示）。
  const r = {
    marginOverhang: { level: 'bad', note: '信用過多' },
    squeeze: { level: 'good', note: '踏み上げ狙い' },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '需給').ok, true);
  assert.match(row(rows, '需給').note, /踏み上げ/);
});

test('需給: marginOverhang・squeeze両方とも確認済みで両方とも該当しなければ✗', () => {
  const r = {
    marginOverhang: { level: 'bad', note: '信用過多', checked: true },
    squeeze: { level: null, note: null, checked: true },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '需給').ok, false);
});

test('需給: 信用倍率データが無ければ？のまま（未確認と混同しない）', () => {
  // 実測バグ: 石井表記等4銘柄はloanRatio自体が無いのに「✓ 信用過多の
  // 兆候なし」＝確認済みと誤表示していた。
  const r = { marginOverhang: { level: null, note: null, checked: false } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '需給').ok, null);
  assert.match(row(rows, '需給').note, /不足/);
});

test('需給: marginOverhangが確定的にbadでもsqueezeが未確認なら？（ORをfalse確定にしない）', () => {
  // 実測バグ: 3038神戸物産等6銘柄はmarginOverhangが確定的にbadなのに
  // squeeze（週次信用残データ）が単に未取得なだけで、OR条件全体を
  // false確定扱いにして✗を出していた。OR条件は両方とも確認済みで
  // 両方ともfalseの場合しかfalse確定にできない（squeezeが分かれば
  // 結果が変わる可能性が残っているため）。
  const r = {
    marginOverhang: { level: 'bad', note: '信用過多', checked: true },
    squeeze: { level: null, note: null, checked: false },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '需給').ok, null);
  assert.match(row(rows, '需給').note, /未確認/);
});

test('下値: netNet/lowPbr/pbrHistoricalLow全て確認済みで該当しないなら✗（未確認と混同しない）', () => {
  // 実測バグ: PBR・業種平均PBRのデータが完全に揃っていて「割安ではない」
  // と確認できる銘柄（350A等11銘柄）でも、checked flagが無かったため
  // 一律「？（確認できず）」と表示されていた。
  const r = {
    netNet: { level: null, note: null, checked: true },
    lowPbr: { level: null, note: null, checked: true },
    pbrHistoricalLow: { level: null, note: null, checked: true },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, false);
  assert.match(row(rows, '下値').note, /裏付けなし/);
});

test('下値: データ自体が無ければ？のまま', () => {
  const r = {
    netNet: { level: null, note: null, checked: false },
    lowPbr: { level: null, note: null, checked: false },
    pbrHistoricalLow: { level: null, note: null, checked: false },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, null);
});

test('下値: lowPbrがgoodなら✓', () => {
  const r = { lowPbr: { level: 'good', note: '割安', checked: true } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, true);
});

test('下値: pbrHistoricalLowがgoodなら✓（コンセンサス無し銘柄の代用物差し）', () => {
  const r = { pbrHistoricalLow: { level: 'good', note: '歴史的低水準', checked: true } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, true);
});

test('下値: lowPbrだけ確認済みで該当なし・netNet/pbrHistoricalLowが未確認なら？（ORをfalse確定にしない）', () => {
  // 需給行と同じ3値OR論理のバグ。1つだけ確認済みで該当しない場合、
  // 残りが未確認のままではOR全体をfalse確定にできない。
  const r = {
    lowPbr: { level: null, note: null, checked: true },
    netNet: { level: null, note: null, checked: false },
    pbrHistoricalLow: { level: null, note: null, checked: false },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, null);
});

test('下値: netNet/lowPbrは確認済みで該当なしでも、pbrHistoricalLowだけ未確認（IR Bank取得失敗等）なら？のまま', () => {
  // pbrHistoricalLowは追加した3つ目のOR候補。IR Bank取得失敗等で
  // 未確認のままの場合、他の2つが確認済みで該当なしでも全体をfalse
  // 確定にはできない（3値OR論理を厳密に保つ）。
  const r = {
    netNet: { level: null, note: null, checked: true },
    lowPbr: { level: null, note: null, checked: true },
    pbrHistoricalLow: { level: null, note: null, checked: false },
  };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '下値').ok, null);
});

test('タイミング: 決算日が不明ならok:null（「確認できて問題なし」と混同しない）', () => {
  // 実測バグ: SMART ENTRY銘柄（決算日不明）でも常に✓が出ていた
  // （earningsWarningはdaysLeftが無ければ常にlevel:nullになるため）。
  const r = { earningsDaysLeft: null, earningsWarning: { level: null } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, 'タイミング').ok, null);
});

test('タイミング: 決算日がわかっていて間近でなければ✓', () => {
  const r = { earningsDaysLeft: 20, earningsWarning: { level: null } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, 'タイミング').ok, true);
});

test('期待値: 会社予想だけ無い場合とコンセンサスだけ無い場合を文言で区別する', () => {
  // 実測バグ: 原因を区別せず一律「コンセンサスN/A」と表示していた
  // （4716日本オラクルは実際にはコンセンサスがあり会社予想だけ無かった）。
  const onlyConsensus = buyRuleChecklist({ estimateProfit: null, consensusProfit: 100 });
  assert.match(row(onlyConsensus, '期待値').note, /会社予想N\/A/);

  const onlyEstimate = buyRuleChecklist({ estimateProfit: 100, consensusProfit: null });
  assert.equal(row(onlyEstimate, '期待値').note, 'コンセンサスN/A');

  const neither = buyRuleChecklist({ estimateProfit: null, consensusProfit: null });
  assert.match(row(neither, '期待値').note, /共にN\/A/);
});

test('財務: warn判定は✓にしない（異常ありなのに問題なしと表示しない）', () => {
  // 実測バグ: level==='warn'でも✓が出ていた（'bad'しか除外していなかった）。
  const r = { receivablesAnomaly: { level: 'warn', note: 'x', checked: true } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '財務').ok, false);
});

test('財務: 未確認（checked:false）は✓でも✗でもなくnull', () => {
  const r = { receivablesAnomaly: { level: null, note: null, checked: false } };
  const rows = buyRuleChecklist(r);
  assert.equal(row(rows, '財務').ok, null);
});

test('構造チェック: データが完全に空(r={})なら、期待値以外の全行がok:null（勝手に✓を出さない）', () => {
  // 「未確認」と「確認済みで問題なし/該当なし」の混同は、需給・下値・
  // 財務・タイミングの4行で実際に見つかったバグだった（期待値は
  // estimateProfit/consensusProfitを直接見るため対象外）。データが
  // 一切無い状態でどれか1行でも勝手にok:trueを出したら、同じバグの
  // 再発とみなす。
  const rows = buyRuleChecklist({});
  for (const label of ['需給', '下値', 'タイミング', '財務']) {
    assert.equal(row(rows, label).ok, null, `${label}行がデータ0件なのにok:nullになっていません`);
  }
});

test('bottomChips: コンセンサスが無い銘柄は「過去の事実」系チップ（お宝候補・解散価値・PBR・配当）を先頭に並べる', () => {
  // コンセンサス（アナリスト予想）が無い銘柄は「未来の期待値」との比較が
  // そもそもできないため、代わりに過去の実績に基づくチップを優先表示する。
  const r = {
    consensusProfit: null, // コンセンサスN/A
    climax: { level: 'good', label: '底打ち観測', note: 'x' },
    hiddenGem: { level: 'good', label: 'お宝候補', note: 'x' },
    netNet: { level: 'good', label: '解散価値割れ', note: 'x' },
    divFloor: { level: 'good', label: '配当下限', note: 'x' },
  };
  const labels = chipLabels(bottomChips(r));
  // climax/divFloorはCHIP_SIGNAL_FIELDSの通常順で残るが、非コンセンサス
  // 優先チップ（hiddenGem・netNet）より後ろに回る。
  assert.deepEqual(labels, ['お宝候補', '解散価値割れ', '底打ち観測', '配当下限']);
});

test('bottomChips: コンセンサスがある銘柄は通常のCHIP_SIGNAL_FIELDS順（並び替えない）', () => {
  const r = {
    consensusProfit: 500, // コンセンサスあり
    climax: { level: 'good', label: '底打ち観測', note: 'x' },
    hiddenGem: { level: 'good', label: 'お宝候補', note: 'x' },
    netNet: { level: 'good', label: '解散価値割れ', note: 'x' },
  };
  const labels = chipLabels(bottomChips(r));
  assert.deepEqual(labels, ['底打ち観測', '解散価値割れ', 'お宝候補']);
});

test('consensusEvidenceBlock: コンセンサス無し＋代替根拠ありなら、ホバー無しで読める形で根拠の中身をそのまま出す', () => {
  // ユーザー要望: 「コンセンサス差N/A」自体は消さなくて良いが、代わりの
  // 根拠（お宝候補・PBR歴史的低水準等）がchipのtitle属性（ホバー/長押し
  // 頼み）に隠れていて見落としやすいので、常時見える形でも出してほしい。
  const r = {
    consensusProfit: null, // コンセンサスN/A
    hiddenGem: { level: 'good', label: 'お宝候補', note: 'アナリスト未カバーながら割安×増配中' },
    pbrHistoricalLow: { level: 'good', label: 'PBR歴史的最低水準', note: '現在PBR0.7倍は過去最低0.72倍に並ぶ水準です', checked: true },
  };
  const html = consensusEvidenceBlock(r);
  assert.match(html, /コンセンサス非公開/);
  assert.match(html, /お宝候補/);
  assert.match(html, /アナリスト未カバーながら割安×増配中/);
  assert.match(html, /PBR歴史的最低水準/);
  assert.match(html, /現在PBR0\.7倍は過去最低0\.72倍に並ぶ水準です/);
});

test('consensusEvidenceBlock: コンセンサスがある銘柄では何も出さない（そもそも代替根拠が不要）', () => {
  const r = {
    consensusProfit: 500,
    hiddenGem: { level: 'good', label: 'お宝候補', note: 'x' },
  };
  assert.equal(consensusEvidenceBlock(r), '');
});

test('consensusEvidenceBlock: コンセンサス無しでも代替根拠が1つも無ければ何も出さない（無い根拠を捏造しない）', () => {
  const r = { consensusProfit: null, netNet: { level: null }, lowPbr: { level: null } };
  assert.equal(consensusEvidenceBlock(r), '');
});

// ■ 再発防止（この5テストのために）
// 「新しい代替根拠シグナルを追加したのに、チップのラベルだけ増えて
// note本文がホバー/長押し頼みのまま常時表示に出てこない」という、
// 今回ユーザーから指摘された種類の抜けを構造的に防ぐ。
// VALUATION_CHIP_FIELDS（indicators.mjs）に何を足しても、この配列を
// そのままimportして回すテストが自動的に「本文が常時表示ブロックに
// 出るか」を検証する。ambushConviction/smartEntryConviction向けに
// 導入した「単一の情報源をimportして回す」再発防止パターンと同じ設計。
test('consensusEvidenceBlock: VALUATION_CHIP_FIELDSの各シグナルは、goodなら常時表示ブロックの本文にも出る（チップのホバーだけに留まらない）', () => {
  for (const key of VALUATION_CHIP_FIELDS) {
    const r = { consensusProfit: null, [key]: { level: 'good', label: 'テストラベル', note: 'テスト根拠の本文XYZ' } };
    const html = consensusEvidenceBlock(r);
    assert.match(html, /テスト根拠の本文XYZ/, `${key}がgoodでもconsensusEvidenceBlockの本文に出ません（VALUATION_CHIP_FIELDSへの追加漏れ、またはconsensusEvidenceBlockの配線忘れの疑い）`);
    assert.match(html, /テストラベル/, `${key}のラベルがconsensusEvidenceBlockに出ません`);
  }
});

test('consensusEvidenceBlock: warnレベルの代替根拠も本文に出す（goodだけに限らない）', () => {
  for (const key of VALUATION_CHIP_FIELDS) {
    const r = { consensusProfit: null, [key]: { level: 'warn', label: 'テスト警戒', note: 'テスト根拠の本文ABC' } };
    const html = consensusEvidenceBlock(r);
    assert.match(html, /テスト根拠の本文ABC/, `${key}がwarnでもconsensusEvidenceBlockの本文に出ません`);
  }
});

test('signalRow: composePatternの4状態（該当/一部該当/非該当/N/A）がそれぞれ別の絵文字・色になる', () => {
  // 実測バグ（ユーザー報告）: 「信号の赤色と黄色が機能していない気がする」。
  // SIG_EMOJI/SIG_CLASSにbad:'🔴'/'red'は定義されていたが、composePattern
  // （sig1〜3を作る唯一の関数）は'good'/'partial'/level:null(非該当・N/A
  // 両方)しか返さないため、🔴は定義上ずっと到達不能なデッドコードだった。
  // 「非該当」（確定的な不一致）にlevel:'none'を新設し🔴に対応させた。
  // このテストは実際のcomposePattern経由の値でsignalRowをレンダリングし、
  // 4状態が本当に別々の絵文字になることを固定する（🔴が再びデッドコードに
  // 戻っていないかを機械的に検知する）。
  const good = reboundPatternSignal({ kairi: -12, rsi: 25, creditTrendPct: -5 });
  const partial = laggingPatternSignal({ creditLevelPct: 10, estimateProfit: null, consensusProfit: null, kairi: 2 });
  const none = laggingPatternSignal({ creditLevelPct: 100, estimateProfit: null, consensusProfit: null, kairi: 2 });
  const na = laggingPatternSignal({ creditLevelPct: null, estimateProfit: null, consensusProfit: null, kairi: null });

  const emojiOf = (sig) => signalRow('t', sig).match(/<span class="sig-e">([^<]+)<\/span>/)[1];
  const [eGood, ePartial, eNone, eNa] = [good, partial, none, na].map(emojiOf);

  assert.equal(eGood, '🟢');
  assert.equal(ePartial, '🟡');
  assert.equal(eNone, '🔴');
  assert.equal(eNa, '⚪');
  assert.equal(new Set([eGood, ePartial, eNone, eNa]).size, 4, '4状態が絵文字を使い回さず、それぞれ別々に区別できていません');
});

test('ceilingPriceNote: 業種平均PBRに追いつく株価を「割安の上限目安」として計算する', () => {
  // ユーザー指摘: 9052山陽電鉄の実例で検証（現在PBR0.7倍・業種平均1.26倍・
  // 株価2031円）。追いつく株価 = 2031 * (1.26/0.7) ≈ 3656円。
  const r = { pbr: 0.7, sectorPbr: 1.26, price: 2031 };
  const html = ceilingPriceNote(r);
  assert.match(html, /約3,656円/);
  assert.match(html, /バリュエーション上の目安/);
});

test('ceilingPriceNote: 既に業種平均以上のPBRなら「割安の上限」という概念が成立しないため何も出さない', () => {
  const r = { pbr: 1.5, sectorPbr: 1.26, price: 2031 };
  assert.equal(ceilingPriceNote(r), '');
});

test('ceilingPriceNote: データ不足ならNaNを出さず何も出さない', () => {
  assert.equal(ceilingPriceNote({ pbr: null, sectorPbr: 1.26, price: 2031 }), '');
  assert.equal(ceilingPriceNote({ pbr: 0.7, sectorPbr: null, price: 2031 }), '');
  assert.equal(ceilingPriceNote({ pbr: 0.7, sectorPbr: 1.26, price: null }), '');
  assert.equal(ceilingPriceNote({ pbr: 0, sectorPbr: 1.26, price: 2031 }), '');
});

test('smartEntryCard: 同業他社比較(peerComparisonBlock)・配当推移(dividendTrendBlock)を含む（AMBUSHのcard()だけに配線されていた抜けの再発防止）', () => {
  // 実測バグ（ユーザー指摘の9052調査で発覚）: peerComparisonBlock/
  // dividendTrendBlockはcard()（AMBUSH）だけから呼ばれており、
  // smartEntryCard()（SMART ENTRY）には元々呼び出し自体が無かった。
  // smart_entry.mjsの結果オブジェクトにもpbr/sectorPbr等が渡って
  // いなかったため、SMART ENTRY全カードで同業他社比較・
  // バリュエーション上限目安(ceilingPriceNote)が一度も表示されて
  // いなかった（実測: 9052含む全6カードでpeerbox 0件）。
  const r = {
    code: '9052', name: 'テスト銘柄', price: 2031, changePct: 0.5, closes: [2000, 2031],
    pbr: 0.7, sectorPbr: 1.26, sectorName: 'テスト業種',
    dividendYield: 2.46, dividendYenHistory: [{ amount: 40 }, { amount: 50 }], dividendStreakYears: 2, dividendStreakDirection: 'up',
    sig1: { level: null, label: 'N/A', note: null },
    sig2: { level: null, label: 'N/A', note: null },
    sig3: { level: null, label: 'N/A', note: null },
  };
  const html = smartEntryCard(r, 0);
  assert.match(html, /peerbox-head/, '同業他社比較ブロックがSMART ENTRYカードに出ていません');
  assert.match(html, /約3,656円/, 'バリュエーション上限目安がSMART ENTRYカードに出ていません');
  assert.match(html, /divtrend/, '配当金推移ブロックがSMART ENTRYカードに出ていません');
});

test('convictionNote: retailExpectationのbad/warnも「-pt」として表示に反映する（実スコアとの不一致の再発防止）', () => {
  // ambushConvictionはAMBUSH_PENALTY_FIELDS(retailExpectation)で減点する
  // ようになったが、convictionNote（画面の「+pt」内訳表示）が加点分しか
  // 見ていないと、実際のスコアより有利な内訳が表示され続けてしまう
  // （institutionalShort/majorShareholderの過去の抜けと同種のバグ）。
  const badOnly = convictionNote({ score: 50, retailExpectation: { level: 'bad', note: 'x' } });
  assert.match(badOnly, /-10pt/);
  assert.match(badOnly, /class="conviction-note neg"/);

  const bonusAndPenalty = convictionNote({
    score: 50,
    netNet: { level: 'good', note: 'x' }, // +5
    retailExpectation: { level: 'bad', note: 'x' }, // -10
  });
  assert.match(bonusAndPenalty, />-5pt</); // 5 - 10 = -5
});

test('convictionNote: 加点も減点も無ければ何も出さない', () => {
  assert.equal(convictionNote({ score: 50 }), '');
});
