// scraper.mjsの「自分ルール」チェックリスト(buyRuleChecklist)の回帰テスト。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyRuleChecklist, bottomChips, consensusEvidenceBlock, signalRow, ceilingPriceNote, smartEntryCard, convictionNote, beginnerGuide, entryTimingNote, passesPriceBand, byTenbaggerRank, buildReasons, checkReasonConsistency, exitPlanBlock, ceilingPrice, precursorCard, smartEntryExitPlanBlock, tenbaggerExitPlanBlock, tenbaggerFinancialBlock } from '../scraper.mjs';
import { hasPrecursor } from '../indicators.mjs';
import { WINDOW } from '../screener.mjs';
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

test('convictionNote: retailExpectationのbad/warnも減点として表示に反映する（実スコアとの不一致の再発防止）', () => {
  // ambushConvictionはAMBUSH_PENALTY_FIELDS(retailExpectation)で減点する
  // ようになったが、convictionNote（画面の順位内訳表示）が加点分しか
  // 見ていないと、実際のスコアより有利な内訳が表示され続けてしまう
  // （institutionalShort/majorShareholderの過去の抜けと同種のバグ）。
  const badOnly = convictionNote({ score: 50, retailExpectation: { level: 'bad', note: 'x' } });
  assert.match(badOnly, /順位40pt\(-10\)/); // 50-10=40
  assert.match(badOnly, /class="conviction-note neg"/);

  const bonusAndPenalty = convictionNote({
    score: 50,
    netNet: { level: 'good', note: 'x' }, // +5
    retailExpectation: { level: 'bad', note: 'x' }, // -10
  });
  assert.match(bonusAndPenalty, /順位45pt\(-5\)/); // 50+5-10=45
});

test('convictionNote: SCORE（素点）だけでなく順位に使う合計値を暗算不要で示す（実測の違和感の再発防止）', () => {
  // 実測: SCOREリング（素点）だけを見ると、素点が低い銘柄が素点の高い
  // 銘柄より上位に来ているように見え、順位がおかしいと誤解されやすかった
  // （例: SCORE73の銘柄がSCORE83の銘柄より上位——実際はconviction98 vs 83
  // で正しい）。以前は差分（+25pt）だけを表示しており、素点への加算を
  // 暗算しないと実際の順位用の値が分からなかった。合計値を前面に出す。
  const r = { score: 73, netNet: { level: 'good' }, lowPbr: { level: 'good' }, divFloor: { level: 'good' }, squeeze: { level: 'good' }, sectorRotation: { level: 'good' } };
  const html = convictionNote(r);
  assert.match(html, /順位98pt\(\+25\)/); // 73 + 5*5 = 98
});

test('convictionNote: 加点も減点も無ければ何も出さない', () => {
  assert.equal(convictionNote({ score: 50 }), '');
});

test('beginnerGuide: 主要な専門用語（乖離率・RSI・信用残・PBR・PER・SCORE・自分ルールの5項目）を説明する', () => {
  // ユーザー要望: 「初心者にとって視覚情報・説明文章が分かりにくい所を
  // 分かりやすくして」。カード上で説明なしに出てくる専門用語が、
  // 常時アクセスできるガイドとして解説されていることを固定する。
  const html = beginnerGuide();
  for (const term of ['乖離率', 'RSI', '信用残', 'PBR', 'PER', 'SCORE', '需給', '下値', '期待値', 'タイミング', '財務']) {
    assert.match(html, new RegExp(term), `${term}の説明がbeginnerGuideに含まれていません`);
  }
  // 色・記号の凡例も含む
  assert.match(html, /プラス材料/);
  assert.match(html, /データ不足で未確認/);
});

test('entryTimingNote: 決算T+30日以内（AMBUSHの狙い目ゾーン）なら「決算をまたぐ新規エントリーは避け」と促す', () => {
  // ユーザー要望: 「いつまでに仕込むべきとかあれば追記してほしい」。
  const r = { daysLeft: 20, earningsDate: '2026-09-30' };
  const html = entryTimingNote(r);
  assert.match(html, /9月30日/);
  assert.match(html, /あと20日/);
  assert.match(html, /決算をまたぐ新規エントリーは避け/);
});

test('entryTimingNote: 決算T+31日以降（まだ様子見期間）なら狙い目ゾーンに入るまでの日数を示す', () => {
  const r = { daysLeft: 40, earningsDate: '2026-09-30' };
  const html = entryTimingNote(r);
  assert.match(html, new RegExp(`あと${40 - WINDOW.nowMax}日ほどで`));
  assert.match(html, /それまでは様子見期間です/);
});

test('entryTimingNote: 決算日・残日数が無ければ何も出さない（AMBUSH以外や未確定日への誤爆防止）', () => {
  assert.equal(entryTimingNote({}), '');
  assert.equal(entryTimingNote({ daysLeft: 20 }), ''); // earningsDateが無い
  assert.equal(entryTimingNote({ earningsDate: '2026-09-30' }), ''); // daysLeftが無い
});

test('entryTimingNote: 決算日が未確定（estimated）でもearningsDateRawを目安として表示する（実測: 23銘柄中10銘柄がこのケース）', () => {
  // 実測バグ: r.earningsDateのみを見ていたため、決算日が取引所未確定
  // （前年同期を置き換えた参考値）の銘柄では一切表示されなかった。
  const r = { daysLeft: 38, earningsDate: null, earningsDateRaw: '2026/09 下旬' };
  const html = entryTimingNote(r);
  assert.match(html, /2026\/09 下旬ごろ/);
  assert.match(html, /参考値・未確定/);
  assert.match(html, /あと38日/);
});

test('entryTimingNote: 決算日・目安のどちらも無ければ何も出さない', () => {
  assert.equal(entryTimingNote({ daysLeft: 20 }), '');
});

test('entryTimingNote: bucket=WATCH（決算T+31〜45日）でもverdictが「買い推奨」なら「様子見期間」と矛盾させない', () => {
  // 実測バグの芽: bucket分け（daysLeft<=30か否か）とambushVerdictの
  // 「買い推奨」判定（rank S/A・evidence）は別々の条件式で計算される
  // ため、daysLeftが31〜45でもスコア70以上・先行カタリストありなら
  // 「買い推奨」になりうる。日数だけを見て「まだ様子見期間です」と
  // 言い切ると、カード上部の「買い推奨」バッジと直接矛盾する。
  const r = { daysLeft: 40, earningsDate: '2026-09-30' };
  const buyVerdict = { level: 'buy', label: '買い推奨', reason: 'x' };
  const html = entryTimingNote(r, buyVerdict);
  assert.doesNotMatch(html, /様子見期間/);
  assert.match(html, /決算をまたぐ新規エントリーは避け/);
});

test('entryTimingNote: 決算まで46〜60日（PRE-AMBUSH帯）はverdictが「買い候補」でも「決算をまたぐ新規エントリーは避け」にはしない（実測バグ: CSTM/ECVT/BOOT等の米国株で決算まで53〜59日なのに差し迫った文言になっていた再発防止）', () => {
  const r = { daysLeft: 53, earningsDate: '2026-10-27' };
  const buyVerdict = { level: 'buy', label: '🟢 買い候補', reason: 'x' };
  const html = entryTimingNote(r, buyVerdict);
  assert.doesNotMatch(html, /決算をまたぐ新規エントリーは避け/);
  assert.match(html, /様子見期間/);
});

test('entryTimingNote: verdictが買い推奨でなければ、従来通りdaysLeftだけで様子見期間かどうかを判定する', () => {
  const r = { daysLeft: 40, earningsDate: '2026-09-30' };
  const holdVerdict = { level: 'hold', label: '様子見', reason: 'x' };
  assert.match(entryTimingNote(r, holdVerdict), /様子見期間/);
  assert.match(entryTimingNote(r), /様子見期間/); // verdict省略時も従来通り動く
});

test('hasPrecursor: progressStreak/dividendPotential/hiddenAssetのいずれか1つでもgoodならtrue', () => {
  assert.equal(hasPrecursor({ progressStreak: { level: 'good' } }), true);
  assert.equal(hasPrecursor({ dividendPotential: { level: 'good' } }), true);
  assert.equal(hasPrecursor({ hiddenAsset: { level: 'good' } }), true);
  assert.equal(hasPrecursor({ progressStreak: { level: null } }), false);
  assert.equal(hasPrecursor({}), false);
});

test('hasPrecursor: creditFloatのgoodだけでは掲載しない（実測で需給が軽いだけの銘柄が大半を占めた反省。バッジ表示のみに留める）', () => {
  assert.equal(hasPrecursor({ creditFloat: { level: 'good' } }), false);
  assert.equal(hasPrecursor({ creditFloat: { level: 'bad' } }), false);
});

test('hasPrecursor: receivablesAnomaly（warn/bad）やprogressStreakのwarn枝（進捗率加速も減益）も注意予兆として拾う', () => {
  assert.equal(hasPrecursor({ receivablesAnomaly: { level: 'bad' } }), true);
  assert.equal(hasPrecursor({ receivablesAnomaly: { level: 'warn' } }), true);
  assert.equal(hasPrecursor({ progressStreak: { level: 'warn' } }), true);
  assert.equal(hasPrecursor({ receivablesAnomaly: { level: null } }), false);
});

// passesPriceBand: テンバガー候補セクション限定の株価帯フィルター
// （ユーザー要望「株価が高いものはやはり除外して」で警告バッジ方式から
// 除外方式に変更）。100〜700円(JP)/$1〜$7(US)が理想帯、材料十分なら
// 1500円(JP)/$15(US)まで許容、それ以外は除外する。
test('passesPriceBand: 理想帯以内(JP<=700円/US<=$7)は常に通す', () => {
  assert.equal(passesPriceBand(700, false, false), true);
  assert.equal(passesPriceBand(347, false, false), true);
  assert.equal(passesPriceBand(7, false, true), true);
  assert.equal(passesPriceBand(5.83, false, true), true);
});

test('passesPriceBand: 理想帯超〜許容上限以内(JP701-1500円/US$7.01-$15)は先行材料(hasCatalyst)があれば通す', () => {
  assert.equal(passesPriceBand(1200, true, false), true);
  assert.equal(passesPriceBand(1200, false, false), false);
  assert.equal(passesPriceBand(10, true, true), true);
  assert.equal(passesPriceBand(10, false, true), false);
});

test('passesPriceBand: 許容上限超(JP>1500円/US>$15)はhasCatalystの有無に関わらず除外する（実例: IONQ株価$39.2は除外対象）', () => {
  assert.equal(passesPriceBand(1501, true, false), false);
  assert.equal(passesPriceBand(4445, true, false), false);
  assert.equal(passesPriceBand(39.2, true, true), false);
});

test('passesPriceBand: 株価データが無ければ除外の判断材料が無いため通す（誤って有望な候補を消さない）', () => {
  assert.equal(passesPriceBand(null, false, false), true);
  assert.equal(passesPriceBand(undefined, false, true), true);
});

// byTenbaggerRank: テンバガー候補の並び順（ユーザー報告: Tier A 1位の
// G-MFS(196A)がzone:'priced_in'（🔴織り込み済み）なのに1位に居座り続け、
// 「今すぐ検討できる銘柄が1位に来るべき」という目的に反していた再発防止）。
// zone:'priced_in'の銘柄を、他に非priced_inの候補があるうちは下位に
// 沈める。growthPct降順という既存の設計は維持する。
test('byTenbaggerRank: zone:priced_inの銘柄は、成長率が高くても非priced_inの銘柄より下位に来る', () => {
  const pricedIn = { revenueGrowthPct: 200, repricingLag: { checked: true, zone: 'priced_in' } };
  const notPricedIn = { revenueGrowthPct: 30, repricingLag: { checked: true, zone: 're_rating' } };
  const sorted = [pricedIn, notPricedIn].sort(byTenbaggerRank);
  assert.deepEqual(sorted, [notPricedIn, pricedIn], 'growthPctが低くてもpriced_inでない候補が1位に来るべき');
});

test('byTenbaggerRank: 同じpriced_in状態どうしはrevenueGrowthPct降順', () => {
  const low = { revenueGrowthPct: 30, repricingLag: { checked: true, zone: 're_rating' } };
  const high = { revenueGrowthPct: 150, repricingLag: { checked: true, zone: 're_rating' } };
  const sorted = [low, high].sort(byTenbaggerRank);
  assert.deepEqual(sorted, [high, low]);
});

test('byTenbaggerRank: repricingLag未確定（checked:false）はpriced_inとして扱わない（確定していない判定で不利益を与えない）', () => {
  const uncheckedPricedIn = { revenueGrowthPct: 30, repricingLag: { checked: false, zone: 'priced_in' } };
  const confirmedReRating = { revenueGrowthPct: 20, repricingLag: { checked: true, zone: 're_rating' } };
  const sorted = [confirmedReRating, uncheckedPricedIn].sort(byTenbaggerRank);
  assert.deepEqual(sorted, [uncheckedPricedIn, confirmedReRating], 'growthPctが高い方が1位に来るべき（priced_inによる沈み込みは発生しない）');
});

test('byTenbaggerRank: explosionScore（成長加速・ブレイクアウト・浮動株薄の該当件数）が同groupならgrowthPctより優先する（ユーザー提案: 「爆発の3条件」が重なる候補を上位に押し上げる）', () => {
  const highGrowthNoExplosion = { revenueGrowthPct: 100, repricingLag: { checked: true, zone: 're_rating' } };
  const lowGrowthTwoExplosion = {
    revenueGrowthPct: 26,
    repricingLag: { checked: true, zone: 're_rating' },
    growthAcceleration: { level: 'good' },
    breakoutVolume: { level: 'good' },
  };
  const sorted = [highGrowthNoExplosion, lowGrowthTwoExplosion].sort(byTenbaggerRank);
  assert.deepEqual(sorted, [lowGrowthTwoExplosion, highGrowthNoExplosion], 'growthPctが低くてもexplosionScoreが高い候補が1位に来るべき');
});

// v7.3改修 項目15/16: 「なぜこの銘柄が上位に来たのか」の理由文自動生成。
test('buildReasons: 先行材料・進捗率連続上振れ・妙味スコア・決算までの日数・リスクを5カテゴリに振り分ける', () => {
  const r = {
    catalystTier: 'S', catalysts: [{ label: '上方修正' }],
    progressStreak: { level: 'good' },
    repricingLag: { checked: true, zone: 'pre_move', score: 80 },
    daysLeft: 21,
    earningsDate: '2026-10-01',
    netNet: { level: 'bad', note: '解散価値割れの逆（要注意）' },
  };
  const verdict = { level: 'buy', label: '🟢 買い候補' };
  const reasons = buildReasons(r, verdict);
  assert.equal(reasons.up.length, 2); // catalystTier + progressStreak（scoreは未指定のため該当なし）
  assert.equal(reasons.unpriced.length, 1);
  assert.equal(reasons.timing.length, 1);
  assert.equal(reasons.risks.length, 1);
  assert.equal(reasons.nextEvents.length, 1);
});

test('buildReasons: 未織り込み要因はrepricingLagのzoneがpre_move/early_moveの時だけ載る（priced_inは載せない）', () => {
  const pre = buildReasons({ repricingLag: { checked: true, zone: 'pre_move', score: 80 } }, {});
  const priced = buildReasons({ repricingLag: { checked: true, zone: 'priced_in', score: 10 } }, {});
  assert.equal(pre.unpriced.length, 1);
  assert.equal(priced.unpriced.length, 0);
});

test('buildReasons: リスクはbadChipSignals（CHIP_SIGNAL_FIELDSでlevel:bad）をそのまま使う', () => {
  const r = { netNet: { level: 'bad', note: 'テスト用の悪材料' } };
  const reasons = buildReasons(r, {});
  assert.equal(reasons.risks.length, 1);
  assert.equal(reasons.risks[0].text, 'テスト用の悪材料');
});

// v7.3改修 項目17: 生成した理由文と数値の整合性チェック。
test('checkReasonConsistency: 「業績改善」系の上昇要因があるのに利益成長率がマイナスなら警告する（ユーザー例そのまま）', () => {
  const r = { progressStreak: { level: 'good' }, earningsTrend: { netIncomeGrowthPct: -19 } };
  const verdict = { level: 'buy', label: '🟢 買い候補' };
  const reasons = buildReasons(r, verdict);
  const warnings = checkReasonConsistency(r, verdict, reasons);
  assert.ok(warnings.some((w) => w.includes('マイナス')));
});

test('checkReasonConsistency: verdictが買い候補系なのにconsensusTrapが期待過剰(bad)なら警告する', () => {
  const r = { consensusTrap: { level: 'bad' } };
  const verdict = { level: 'strong_buy', label: '🔥 強い買い候補' };
  const warnings = checkReasonConsistency(r, verdict, buildReasons(r, verdict));
  assert.ok(warnings.some((w) => w.includes('期待過剰')));
});

test('checkReasonConsistency: verdictが買い候補系なのにリスクが2件以上あれば警告する（worsen()配線漏れのセーフティネット。通常のverdict計算では起こらないはずの組み合わせ）', () => {
  const r = { netNet: { level: 'bad', note: 'risk1' }, lowPbr: { level: 'bad', note: 'risk2' } };
  const verdict = { level: 'buy', label: '🟢 買い候補' };
  const warnings = checkReasonConsistency(r, verdict, buildReasons(r, verdict));
  assert.ok(warnings.some((w) => w.includes('配線漏れ')));
});

test('checkReasonConsistency: 矛盾が無ければ警告0件', () => {
  const r = { progressStreak: { level: 'good' }, earningsTrend: { netIncomeGrowthPct: 15 } };
  const verdict = { level: 'buy', label: '🟢 買い候補' };
  const warnings = checkReasonConsistency(r, verdict, buildReasons(r, verdict));
  assert.equal(warnings.length, 0);
});

// v7.4改修（ユーザー要望）: 「いつまでに仕込むべきか」「いつ手放すべきか」
test('exitPlanBlock: 決算まで14〜30日（狙い目ゾーン）なら「前営業日まで」を仕込み期限とする', () => {
  const r = { daysLeft: 20, earningsDate: '2026-09-30', kairi: 3 };
  const html = exitPlanBlock(r, { level: 'hold' });
  assert.match(html, /前営業日までが仕込み期限の目安/);
  assert.match(html, /あと20日/);
});

test('exitPlanBlock: 決算まで7〜13日（sweetMinの外側）かつverdictが買い候補系でなければ新規の仕込みを推奨しない', () => {
  const r = { daysLeft: 10, earningsDate: '2026-09-14' };
  const html = exitPlanBlock(r, { level: 'hold' });
  assert.match(html, /新規の仕込みは推奨しません/);
});

test('exitPlanBlock: 決算まで7〜13日でもverdictが買い候補系なら仕込み期限を優先する（entryTimingNoteと同じ矛盾防止ロジック）', () => {
  const r = { daysLeft: 10, earningsDate: '2026-09-14' };
  const html = exitPlanBlock(r, { level: 'buy' });
  assert.match(html, /前営業日までが仕込み期限の目安/);
});

test('exitPlanBlock: 決算まで31日以上ならまだ早いと案内する', () => {
  const r = { daysLeft: 40, earningsDate: '2026-10-14' };
  const html = exitPlanBlock(r, { level: 'hold' });
  assert.match(html, /仕込みはまだ早めです/);
  assert.match(html, new RegExp(`あと${40 - WINDOW.nowMax}日でAMBUSHの狙い目ゾーン`));
});

// 実測バグ（ユーザー指摘）: PRE-AMBUSH（決算まで46〜60日、v7.3で新設した
// 早期監視帯）の米国株が、rank/scoreだけでverdict='buy'になった途端
// 「決算発表の前営業日までが仕込み期限」という差し迫った文言になって
// いた（実測: CSTM/ECVT/BOOT等で決算まで53〜59日なのに発生）。
// isBuyLikeの上書きはWATCH帯(31〜45日)まででPRE-AMBUSH帯には効かせない。
test('exitPlanBlock: 決算まで46〜60日（PRE-AMBUSH帯）はverdictが買い候補系でも「まだ早め」のまま（実測バグの再発防止）', () => {
  const r = { daysLeft: 53, earningsDate: '2026-10-27' };
  const html = exitPlanBlock(r, { level: 'buy' });
  assert.match(html, /仕込みはまだ早めです/);
  assert.doesNotMatch(html, /前営業日までが仕込み期限の目安/);
});

test('exitPlanBlock: 決算まで31〜45日（WATCH帯）でverdictが買い候補系なら従来通り仕込み期限を優先する', () => {
  const r = { daysLeft: 40, earningsDate: '2026-10-14' };
  const html = exitPlanBlock(r, { level: 'buy' });
  assert.match(html, /前営業日までが仕込み期限の目安/);
});

test('exitPlanBlock: 乖離率の過熱閾値を手放すタイミングとして明記する', () => {
  const r = { daysLeft: 20, earningsDate: '2026-09-30', kairi: 5 };
  const html = exitPlanBlock(r, { level: 'hold' });
  assert.match(html, /乖離率が\+15%を超えたら手放す（現在\+5%）/);
});

test('exitPlanBlock: repricingLagがchecked済みなら「織り込み済み」になったら手放す旨を含める', () => {
  const r = { daysLeft: 20, earningsDate: '2026-09-30', repricingLag: { checked: true, zone: 'pre_move' } };
  const html = exitPlanBlock(r, { level: 'hold' });
  assert.match(html, /妙味ゾーンが「織り込み済み」になったら手放す/);
});

test('exitPlanBlock: 業種平均PBR到達の目安株価が計算できれば利益確定の目安として含める', () => {
  const r = { daysLeft: 20, earningsDate: '2026-09-30', price: 1000, pbr: 1, sectorPbr: 2 };
  const html = exitPlanBlock(r, { level: 'hold' });
  assert.match(html, /業種平均PBR到達の目安株価（約¥2,000）に近づいたら利益確定を検討/);
});

test('exitPlanBlock: 決算日・残日数のどちらも無ければ何も出さない', () => {
  assert.equal(exitPlanBlock({}, {}), '');
  assert.equal(exitPlanBlock({ daysLeft: 20 }, {}), '');
});

test('ceilingPrice: 業種平均PBRに到達する株価を計算する（ceilingPriceNoteと同じロジックを再利用）', () => {
  assert.equal(ceilingPrice({ price: 1000, pbr: 1, sectorPbr: 2 }), 2000);
});

test('ceilingPrice: 既に業種平均以上のPBRならnull（「割安の上限」という概念が成立しない）', () => {
  assert.equal(ceilingPrice({ price: 1000, pbr: 2, sectorPbr: 2 }), null);
});

// 実測バグ（ユーザー報告）: 8200リンガーハットのカタリスト予兆カード
// （precursorCard）に🚪仕込み期限・手放すタイミングブロックが表示
// されていなかった。exitPlanBlockはcard()/usCard()にしか配線しておらず、
// precursorCardには一度も追加していなかった（entryTimingNoteは元々
// 配線済みだったが、verdictを渡していなかった）。
test('precursorCard: AMBUSH由来（precursorSource==="ambush"）の銘柄には🚪仕込み期限・手放すタイミングブロックを表示する（実測: 8200リンガーハットに表示が無かった不具合の再発防止）', () => {
  const r = {
    code: '8200', name: 'リンガーハット', precursorSource: 'ambush',
    rank: 'B', evidence: false, catalysts: [],
    daysLeft: 36, earningsDate: '2026-10-10',
  };
  const html = precursorCard(r, 0);
  assert.match(html, /🚪 仕込み期限・手放すタイミング/);
});

test('precursorCard: 成長株予兆（precursorSource==="growth"）はAMBUSH専用フィールド（rank等）を持たないためverdictを計算せず、ブロックも出さない', () => {
  const r = { code: '1234', name: 'テスト', precursorSource: 'growth' };
  const html = precursorCard(r, 0);
  assert.doesNotMatch(html, /🚪 仕込み期限・手放すタイミング/);
});

// 実測バグ（ユーザー指摘「反映していないところがある」を受けた自己監査で
// 発覚）: precursorCardはverdictを計算していたのに、verdictBlock自体を
// 一度も描画していなかった（entryTimingNote/exitPlanBlockが「判定が
// 悪化したら手放す」と案内しているのに、その判定自体が画面のどこにも
// 表示されていないという矛盾した状態）。
test('precursorCard: AMBUSH由来の銘柄はverdictBlock（判定ランプ）・scoreTrio（BUY/EXPECTATION/SURPRISE）も表示する（実測バグ: 判定を計算していたのに表示していなかった）', () => {
  const r = {
    code: '8200', name: 'リンガーハット', precursorSource: 'ambush',
    rank: 'B', evidence: false, catalysts: [],
    daysLeft: 36, earningsDate: '2026-10-10',
    score: 70, buyScore: { score: 60, confidence: 100, detail: {} }, expectationScore: { score: 40 }, earningsSurpriseScore: { score: 50 }, confidenceTier: 'HIGH', effectiveScore: 60,
  };
  const html = precursorCard(r, 0);
  assert.match(html, /class="verdict /);
  assert.match(html, /score-trio/);
});

// 改修指示書 項目15（最終ランキング画面のモックアップ）: BUY/EXPECTATION/
// SURPRISEだけでなく、UNPRICED・TIMING（BUY SCOREの内訳）・RISK（LOW/MED/
// HIGH）も1銘柄ごとの独立した数値として表示する設計だった。UNPRICED/
// TIMINGはBUY SCORE計算のために既に算出済みなのに単独表示が無く、RISKは
// 表示自体が存在しなかった（実測バグ、指示書の生テキストまで遡った
// 再監査で発覚）。
test('scoreTrio（precursorCard経由）: UNPRICED・TIMING・RISKも表示する', () => {
  const r = {
    code: '8200', name: 'リンガーハット', precursorSource: 'ambush',
    rank: 'B', evidence: false, catalysts: [],
    daysLeft: 20, earningsDate: '2026-10-10',
    score: 70,
    buyScore: { score: 60, confidence: 100, detail: { unpriced: { value: 72 }, timing: { value: 100 } } },
    expectationScore: { score: 40 }, earningsSurpriseScore: { score: 50 }, confidenceTier: 'HIGH', effectiveScore: 60,
  };
  const html = precursorCard(r, 0);
  assert.match(html, /UNPRICED 72/);
  assert.match(html, /TIMING 100/);
  assert.match(html, /RISK LOW/); // badレベルのシグナルを持たないためLOW
});

test('scoreTrio（precursorCard経由）: bad級のリスクシグナルが2件以上あればRISK HIGHにする', () => {
  const r = {
    code: '9999', name: 'テスト', precursorSource: 'ambush',
    rank: 'B', evidence: false, catalysts: [],
    daysLeft: 20, earningsDate: '2026-10-10',
    score: 70, buyScore: { score: 60, confidence: 100, detail: {} },
    expectationScore: { score: 40 }, earningsSurpriseScore: { score: 50 }, confidenceTier: 'HIGH', effectiveScore: 60,
    netNet: { level: 'bad' }, receivablesAnomaly: { level: 'bad' },
  };
  const html = precursorCard(r, 0);
  assert.match(html, /RISK HIGH/);
});

// 実測バグ（同じ自己監査で発覚）: v7.3項目13/14の投資期間ラベル
// （⏱SHORT/⏱SWING）がcard()/usCard()/smartEntryCard()には配線されて
// いたのに、precursorCardにだけ無かった。AMBUSH由来はAMBUSH本体と同じ
// SHORT、成長株由来はSMART ENTRYと同じSWING（決算スケジュールに依存
// しない中期の仕込みという性質が近い）を表示する。
test('precursorCard: AMBUSH由来は⏱SHORT、成長株由来は⏱SWINGの投資期間バッジを表示する', () => {
  const ambush = precursorCard({ code: '8200', name: 'リンガーハット', precursorSource: 'ambush', rank: 'B', evidence: false, catalysts: [], daysLeft: 36, earningsDate: '2026-10-10' }, 0);
  assert.match(ambush, /⏱ SHORT/);
  assert.doesNotMatch(ambush, /⏱ SWING/);

  const growth = precursorCard({ code: '1234', name: 'テスト', precursorSource: 'growth' }, 0);
  assert.match(growth, /⏱ SWING/);
  assert.doesNotMatch(growth, /⏱ SHORT/);
});

// v7.4改修（ユーザー要望）: テンバガー候補にも「見直す・手放すタイミング」
// を明示する。AMBUSHと違い決算スケジュールにもverdictにも依存しない
// 長期（3〜5年）のテーマのため、既存のrepricingLagのzone・Tier区分を
// そのまま再構成する。
test('tenbaggerExitPlanBlock: 妙味ゾーンが既に「織り込み済み」なら一部利益確定を促す', () => {
  const html = tenbaggerExitPlanBlock({ tier: 'A', repricingLag: { checked: true, zone: 'priced_in' } });
  assert.match(html, /既に「織り込み済み」です。一部利益確定を検討してください/);
});

test('tenbaggerExitPlanBlock: 妙味ゾーンがまだ織り込み済みでなければ「変わったら」という条件文にする', () => {
  const html = tenbaggerExitPlanBlock({ tier: 'A', repricingLag: { checked: true, zone: 'pre_move' } });
  assert.match(html, /「織り込み済み」に変わったら一部利益確定を検討/);
});

test('tenbaggerExitPlanBlock: Tier Bは2倍・3倍の目安、Tier Aは時価総額超過時の注意を出し分ける', () => {
  const b = tenbaggerExitPlanBlock({ tier: 'B' });
  const a = tenbaggerExitPlanBlock({ tier: 'A' });
  assert.match(b, /2倍・3倍の目安株価に達したら/);
  assert.match(a, /中型成長株候補\(Tier B\)の上限を超えたら/);
});

// 改修指示書 項目13（TENBAGGER SCOREの「財務」「株主構成」軸）: 成長性
// （売上高成長率）だけでなく、営業CF・現金・有利子負債・大株主の動きも
// 参考情報として表示する（除外条件にはしない。実データで裏付けの無い
// 閾値は作らない方針のため）。
test('tenbaggerFinancialBlock: 現金が有利子負債を上回れば「実質無借金」、下回れば要確認の注意文を出す', () => {
  const netCash = tenbaggerFinancialBlock({ cash: 1000, interestBearingDebt: 300 });
  assert.match(netCash, /実質無借金/);
  const netDebt = tenbaggerFinancialBlock({ cash: 300, interestBearingDebt: 1000 });
  assert.match(netDebt, /有利子負債1,000円が現金300円を上回っています/);
});

test('tenbaggerFinancialBlock: 営業CFの黒字・赤字を出し分ける', () => {
  const positive = tenbaggerFinancialBlock({ operatingCf: 5000000 });
  assert.match(positive, /営業CFは黒字/);
  const negative = tenbaggerFinancialBlock({ operatingCf: -5000000 });
  assert.match(negative, /営業CFが赤字/);
});

test('tenbaggerFinancialBlock: 大株主の買い増しシグナルがgoodなら表示する', () => {
  const html = tenbaggerFinancialBlock({ majorShareholder: { checked: true, level: 'good', note: '大株主が持株を積み増しています' } });
  assert.match(html, /大株主が持株を積み増しています/);
});

test('tenbaggerFinancialBlock: 財務・株主構成のいずれのデータも無ければ空文字（米国株テンバガーはこれらのフィールドを持たない）', () => {
  assert.equal(tenbaggerFinancialBlock({}), '');
});

// v7.4改修（ユーザー要望「SMART ENTRYにもない」）: SMART ENTRYは決算
// スケジュールを見ないため「仕込み期限」の概念は無いが、「手放すタイミング」
// はAMBUSHと同じ考え方で明示できる。
test('smartEntryExitPlanBlock: 「🚪 手放すタイミング」ブロックを表示する（仕込み期限は無い＝AMBUSHと違い決算スケジュールを見ないため）', () => {
  const r = { kairi: 3, pbr: 1, sectorPbr: 2, price: 1000 };
  const html = smartEntryExitPlanBlock(r, { level: 'buy' }, { level: null }, { level: null }, false);
  assert.match(html, /🚪 手放すタイミング/);
  assert.doesNotMatch(html, /仕込み期限/);
  assert.match(html, /乖離率が\+15%を超えたら手放す（現在\+3%）/);
  assert.match(html, /業種平均PBR到達の目安株価（約¥2,000）に近づいたら利益確定を検討/);
});

test('smartEntryExitPlanBlock: patternExpired（選定時のパターンにもう該当しない）状態を反映する', () => {
  const html = smartEntryExitPlanBlock({}, { level: 'avoid' }, { level: null }, { level: null }, true);
  assert.match(html, /現在: 該当なし/);
});

test('smartEntryExitPlanBlock: 急騰グロース(bad)なら過熱の手放し検討を含める', () => {
  const html = smartEntryExitPlanBlock({}, { level: 'hold' }, { level: null }, { level: 'bad' }, false);
  assert.match(html, /急騰グロース（直近1ヶ月\+50%超）は既に過熱/);
});

// 実測バグ（ユーザー指摘）: PRE-AMBUSHセクションに割り当てたid="p"が、
// 既存の🔮カタリスト予兆セクション（section('p', ...)）と重複していた。
// HUDの「#p」ジャンプリンクが常に先に出現するカタリスト予兆セクションに
// 飛んでしまい、AMBUSHカード（🚪仕込み期限・手放すタイミングブロック
// 付き）ではなくprecursorCard（別物、exitPlanBlock無し）が表示されて
// いたため、ユーザーには「ブロックが無い」ように見えていた。
// scraper.mjsのソース内で使われているセクションid（section('x', ...)の
// 第1引数、および手書きの<details class="sec" id="x">）が重複していない
// ことを機械的に検証し、同じ型のバグの再発を防ぐ。
test('セクションのid（section()呼び出し・手書きのdetails要素とも）が重複していない（実測バグ: PRE-AMBUSHのid="p"がカタリスト予兆と衝突しHUDのジャンプリンクが誤爆していた再発防止）', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(__dirname, '..', 'scraper.mjs'), 'utf-8');

  const ids = [];
  for (const m of src.matchAll(/section\('([a-z])'/g)) ids.push(m[1]);
  for (const m of src.matchAll(/<details class="sec" id="(?:\$\{id\}|([a-z]))"/g)) {
    if (m[1]) ids.push(m[1]);
  }
  assert.ok(ids.length >= 6, `セクションidが${ids.length}件しか抽出できていません（正規表現が壊れている疑い）`);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dupes)], [], `セクションidが重複しています: ${dupes.join(', ')}`);
});

// 実測バグ（ユーザー指摘「システムに反映していないところがある」を受けた
// 再監査で発覚）: 項目15/16/17「なぜこの順位か」ブロックはcard()/usCard()/
// precursorCardには配線済みだったが、smartEntryCard()にだけ無かった。
// SMART ENTRYの結果オブジェクトはAMBUSH専用フィールド（catalystTier・
// repricingLag・score・daysLeft）を持たないため上昇要因/未織り込み/
// タイミング/次イベントは常に空になるが、badChipSignals由来の
// 「⚠️リスク」だけは共通フィールド（netNet・receivablesAnomaly等）から
// 出せるため、reasonBlock自体の追加には意味がある。
test('smartEntryCard: reasonBlockを表示する（bad級のリスクシグナルがあれば「なぜこの順位か」の理由欄に出す）', () => {
  const r = {
    code: '9999', name: 'テスト銘柄', price: 1000, changePct: 0.5, closes: [1000],
    sig1: { level: null, label: 'N/A', note: null },
    sig2: { level: null, label: 'N/A', note: null },
    sig3: { level: null, label: 'N/A', note: null },
    receivablesAnomaly: { level: 'bad', label: '売掛金急増', note: '売上高の伸びを大きく上回る売掛金増加' },
  };
  const html = smartEntryCard(r, 0);
  assert.match(html, /reason-block/);
  assert.match(html, /⚠️ リスク/);
});
