// scraper.mjsの出力前自己監査（auditGeneratedHtml）のテスト。
// これは「新しい赤旗シグナルの配線忘れ」をscraper.mjs実行のたびに
// 自動検出する恒久的な仕組みそのものが正しく働くかを確認する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditGeneratedHtml, auditSignalShapes } from '../scraper.mjs';

const cardWith = (bodyExtra) => `<article class="card">
  <span class="code">1234</span><h2 class="name">テスト銘柄</h2>
  ${bodyExtra}
</article>`;

test('買い推奨のみ・赤チップ無し: 矛盾なし', () => {
  const html = cardWith('<span class="verdict-label">買い推奨</span>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('赤チップのみ・見送り: 矛盾なし', () => {
  const html = cardWith('<span class="verdict-label">見送り</span><footer class="c-foot"><span class="chip red">信用過多</span></footer>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 0);
});

test('買い推奨とfooter内の赤チップ（bottomChips等の実際の警告）が同居: 矛盾として検出する', () => {
  const html = cardWith('<span class="verdict-label">買い推奨</span><footer class="c-foot"><span class="chip red">信用過多</span></footer>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /1234/);
});

test('SMART ENTRYの.signals内の🔴（sig1〜3が「非該当」）は警告ではないため、買い推奨と同居しても矛盾にしない', () => {
  // 実測バグ: composePatternにlevel:'none'を導入し🔴が初めて実際に出る
  // ようになった際、sig1が非該当(🔴)・sig2が該当で「買い推奨」という
  // 正常なSMART ENTRYカードを、footer外の🔴まで拾って誤検知していた。
  const html = cardWith(`
    <span class="verdict-label">買い推奨</span>
    <div class="signals">
      <div class="sig"><div class="sig-head"><span class="sig-e">🔴</span><span class="chip red">非該当</span></div></div>
      <div class="sig"><div class="sig-head"><span class="sig-e">🟢</span><span class="chip mint">該当</span></div></div>
    </div>
    <footer class="c-foot"></footer>
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
  // 「買い推奨」を返しうるのに、entryTimingNoteがverdictを見ずに日数
  // だけで「様子見期間です」と言い切ると矛盾する。
  const html = cardWith('<span class="verdict-label">買い推奨</span><div class="timing-note">決算まで40日。あと10日ほどで狙い目ゾーンに入ります。それまでは様子見期間です</div>');
  const { issues } = auditGeneratedHtml(html);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /entryTimingNote/);
});

test('auditGeneratedHtml: 「買い推奨」でentryTimingNoteが狙い目メッセージなら矛盾なし', () => {
  const html = cardWith('<span class="verdict-label">買い推奨</span><div class="timing-note">決算まで40日。決算をまたぐ新規エントリーは避け、発表前には手仕舞いを検討してください</div>');
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
