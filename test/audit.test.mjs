// scraper.mjsの出力前自己監査（auditGeneratedHtml）のテスト。
// これは「新しい赤旗シグナルの配線忘れ」をscraper.mjs実行のたびに
// 自動検出する恒久的な仕組みそのものが正しく働くかを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditGeneratedHtml, auditSignalShapes, entryTimingNote } from '../scraper.mjs';

const cardWith = (bodyExtra) => `<article class="card">
  <span class="code">1234</span><h2 class="name">テスト銘柄</h2>
  ${bodyExtra}
</article>`;

test('買い推奨のみ・赤チップ無し: 矛盾なし', () => {
  const html = cardWith('<div class="verdict v-buy"><span class="verdict-label">🟢 買い候補</span></div>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('赤チップのみ・見送り: 矛盾なし', () => {
  const html = cardWith('<div class="verdict v-avoid"><span class="verdict-label">🔴 見送り</span></div><footer class="c-foot"><span class="chip red">信用過多</span></footer>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('買い推奨とfooter内の赤チップ（bottomChips等の実際の警告）が同居: 矛盾として検出する', () => {
  const html = cardWith('<div class="verdict v-buy"><span class="verdict-label">🟢 買い候補</span></div><footer class="c-foot"><span class="chip red">信用過多</span></footer>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /1234/);
});

test('strong_buyとfooter内の赤チップが同居: 矛盾として検出する（v-buyだけでなくv-strong_buyも見る）', () => {
  const html = cardWith('<div class="verdict v-strong_buy"><span class="verdict-label">🔥 強い買い候補</span></div><footer class="c-foot"><span class="chip red">信用過多</span></footer>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
});

test('SMART ENTRYの.signals内の🔴（sig1〜3が「非該当」）は警告ではないため、買い推奨と同居しても矛盾にしない', () => {
  // 実測バグ: composePatternにlevel:'none'を導入し🔴が初めて実際に出る
  // ようになった際、sig1が非該当(🔴)・sig2が該当で「買い推奨」という
  // 正常なSMART ENTRYカードを、footer外の🔴まで拾って誤検知していた。
  const html = cardWith(`
    <div class="verdict v-buy"><span class="verdict-label">🟢 買い候補</span></div>
    <div class="signals">
      <div class="sig"><div class="sig-head"><span class="sig-e">🔴</span><span class="chip red">非該当</span></div></div>
      <div class="sig"><div class="sig-head"><span class="sig-e">🟢</span><span class="chip mint">該当</span></div></div>
    </div>
    <footer class="c-foot"></footer>
  `);
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

// 実測バグ（3日ぶりの本番再稼働後の監査で発覚）: VERDICT_LABELは実際
// には「🟢 買い候補」「🔥 強い買い候補」で、「買い推奨」という文字列を
// 一度も出力しない。一方「買い推奨」はDISPLAY_CATEGORY.WATCHのtitle
// （strong_buy/buy/holdのどれでも出る固定文言）やMINIMUM_BUY_GATEの
// hold降格理由文（「買い推奨の最低条件…を満たしません」）にも現れる。
// 旧実装は`c.includes('買い推奨')`という部分文字列一致だったため、
// verdict:'hold'の銘柄がWATCHバッジを持つだけで誤検知していた（実測:
// 本番index.htmlでverdict:'hold'の3087含む3銘柄が誤検知されていた）。
test('auditGeneratedHtml: hold（様子見）銘柄がWATCHバッジ（titleに「買い推奨」を含む固定文言）と赤チップを両方持っていても矛盾にしない（部分文字列一致による誤検知の再発防止）', () => {
  const html = cardWith(`
    <div class="verdict v-hold"><span class="verdict-label">🟡 様子見</span>
      <span class="chip flat" title="監視候補（買い推奨または様子見だが、TOP PICKほどの決め手は無い）">👀 WATCH</span>
    </div>
    <footer class="c-foot"><span class="chip red">信用過多</span></footer>
  `);
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('auditGeneratedHtml: hold銘柄のentryTimingNoteが「様子見期間です」でも、WATCHバッジのtitleに「買い推奨」があるだけで矛盾にしない（同じ誤検知の再発防止）', () => {
  const html = cardWith(`
    <div class="verdict v-hold"><span class="verdict-label">🟡 様子見</span>
      <span class="chip flat" title="監視候補（買い推奨または様子見だが、TOP PICKほどの決め手は無い）">👀 WATCH</span>
    </div>
    <div class="timing-note">決算まで40日。あと10日ほどで狙い目ゾーンに入ります。それまでは様子見期間です</div>
  `);
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('自分ルールの✓/✗表示なのにtitleが未確認を示唆している: 矛盾として検出する', () => {
  // 実測バグ: 需給・下値で「データが不足しています」なのに✓が表示され、
  // 「未確認」と「確認済みで問題なし」が混同されていた。
  const html = cardWith('<span class="rule mint" title="信用倍率データが不足しています">✓ 需給</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /未確認/);
});

test('？(gray)表示でtitleが未確認を示唆していても矛盾ではない（正しい状態）', () => {
  const html = cardWith('<span class="rule gray" title="信用倍率データが不足しています">？ 需給</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('✓表示でtitleが確定的な内容（未確認を示唆しない）: 矛盾ではない', () => {
  const html = cardWith('<span class="rule mint" title="信用過多の兆候なし">✓ 需給</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('auditSignalShapes: checked flagが無い古い形のキャッシュを検出する', () => {
  // 実測バグ: netNet/lowPbrにchecked flagを追加した後、AMBUSHキャッシュ
  // だけ再計算してSMART ENTRYキャッシュを更新し忘れた（矛盾は起きないが
  // 「？」を出し続ける形で見えにくいバグだった）。checked flagが無い
  // 古い形のシグナルオブジェクトが残っていないかを検証する。
  const staleResults = [{ code: '1234', name: 'テスト銘柄', netNet: { level: null, label: null, note: null } }];
  const issues = auditSignalShapes(staleResults, 'TEST');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /netNet/);
});

test('auditSignalShapes: checked flagがある新しい形なら検出しない', () => {
  const freshResults = [{ code: '1234', name: 'テスト銘柄', netNet: { level: null, label: null, note: null, checked: true } }];
  const issues = auditSignalShapes(freshResults, 'TEST');
  assert.equal(issues.length, 0);
});

test('auditSignalShapes: フィールド自体が無い（未対応銘柄）場合は問題にしない', () => {
  const issues = auditSignalShapes([{ code: '1234', name: 'テスト銘柄' }], 'TEST');
  assert.equal(issues.length, 0);
});

test('auditSignalShapes: pbrHistoricalLow（netNet/lowPbrと同じchecked flagパターンで追加した信号）もCHECKED_AWARE_FIELDS対象', () => {
  // 実測バグの再発防止: pbrHistoricalLowSignalにchecked flagを追加した際、
  // CHECKED_AWARE_FIELDSへの追加を最初は忘れていた（この監査自体が
  // 「checked flag無しの古いキャッシュ」を検出できなくなっていた）。
  const stale = [{ code: '1234', name: 'テスト銘柄', pbrHistoricalLow: { level: null, label: null, note: null } }];
  const issues = auditSignalShapes(stale, 'TEST');
  assert.equal(issues.length, 1);
  assert.match(issues[0], /pbrHistoricalLow/);
});

// v7.5改修（再発防止策の横断監査で発覚）: pbrHistoricalLowと全く同じ
// 「CHECKED_AWARE_FIELDSへの追加忘れ」がgrowthAcceleration/themeMatch/
// diamondでも再発していた（3つとも{level,label,note,checked}の同じ形で
// 実装したのに、この監査対象への追加を忘れていた）。
test('auditSignalShapes: growthAcceleration/themeMatch/diamond（v7.5で追加したchecked flagパターンの信号）もCHECKED_AWARE_FIELDS対象', () => {
  for (const key of ['growthAcceleration', 'themeMatch', 'diamond', 'deficitGrowth', 'growthAnomalyCaution']) {
    const stale = [{ code: '1234', name: 'テスト銘柄', [key]: { level: null, label: null, note: null } }];
    const issues = auditSignalShapes(stale, 'TEST');
    assert.equal(issues.length, 1, `${key}がCHECKED_AWARE_FIELDSに含まれていません`);
    assert.match(issues[0], new RegExp(key));
  }
});

test('auditGeneratedHtml: 「買い推奨」と「様子見期間です」（entryTimingNoteの矛盾したメッセージ）が同居していれば検出する', () => {
  // 実測バグの芽: daysLeftが31〜45（bucket=WATCH）でもambushVerdictが
  // 「買い推奨」を返しうるのに、entryTimingNoteがverdictを見ずに呼ばれる
  // （wiring忘れ）と日数だけで「様子見期間です」と言い切ってしまい矛盾する。
  // entryTimingNote自身にverdictを渡さずに呼ぶことで、この配線忘れを再現する。
  const timingHtml = entryTimingNote({ daysLeft: 40, earningsDate: '2026-09-30' });
  const html = cardWith(`<div class="verdict v-buy"><span class="verdict-label">🟢 買い候補</span></div>${timingHtml}`);
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /entryTimingNote/);
});

test('auditGeneratedHtml: 「買い推奨」でentryTimingNoteにverdictを正しく渡していれば（WATCH帯でも狙い目メッセージになり）矛盾なし', () => {
  const timingHtml = entryTimingNote({ daysLeft: 40, earningsDate: '2026-09-30' }, { level: 'buy', label: '🟢 買い候補', reason: 'x' });
  const html = cardWith(`<div class="verdict v-buy"><span class="verdict-label">🟢 買い候補</span></div>${timingHtml}`);
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

// 実測バグ（本番index.htmlでの再検証で発覚）: PRE-AMBUSH帯（daysLeft
// 46〜60）はentryTimingNote自身の設計により、verdictが'buy'でも意図的
// に「様子見期間です」を返す（まだ狙い目ゾーンに入っていないため）。
// 監査側がdaysLeftを見ずに「isBuyVerdict×様子見期間です」だけで矛盾と
// 決めつけていたため、本番で実際にBHF/ASTH/ECVT/ANIP/ECG/BROS/BHE/
// CAVA/PTRN/VSH（いずれもdaysLeft54〜57）の10銘柄を誤検知していた。
test('auditGeneratedHtml: PRE-AMBUSH帯（daysLeft46〜60）のverdict:buyでentryTimingNoteが「様子見期間です」でも矛盾にしない（意図的な設計。実測10銘柄の誤検知の再発防止）', () => {
  const timingHtml = entryTimingNote({ daysLeft: 56, earningsDate: '2026-11-04' }, { level: 'buy', label: '🟢 買い候補', reason: 'x' });
  const html = cardWith(`<div class="verdict v-buy"><span class="verdict-label">🟢 買い候補</span></div>${timingHtml}`);
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

// A指示 項目25「自動生成説明文の矛盾を完全修正」（「売上-5%、利益-57%と
// 業績側は改善」という文章は禁止）の再発防止策。performanceDirectionText
// の実装ミスや将来の別の文章生成箇所での再発を、生成後のHTML自体からも
// 独立に検知できるようにする。
test('auditGeneratedHtml: 売上高・利益成長率が両方マイナスなのに「業績改善」系の文言があれば検出する（禁止された実例の再発防止）', () => {
  const html = cardWith('<div class="repricing-why">売上高-5%・利益-57%と業績側は改善が見られる一方、株価はまだ反応が乏しく</div>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /両方マイナスなのに/);
});

test('auditGeneratedHtml: 売上高・利益成長率が両方マイナスで「業績悪化」と表示していれば矛盾なし', () => {
  const html = cardWith('<div class="repricing-why">売上高-5%・利益-57%（業績悪化）に対し、株価はまだ反応が乏しく</div>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('auditGeneratedHtml: 増収増益で「業績改善」なら矛盾なし', () => {
  const html = cardWith('<div class="repricing-why">売上高+30%・利益+20%（業績改善）に対し</div>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});
