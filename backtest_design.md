# バックテスト基盤 設計メモ（v7.3 項目18・設計のみ、未実装）

STEALTH SCOREおよびBUY SCOREが、その後の実際の株価パフォーマンスと
相関しているかを検証する仕組みの設計。ユーザー承認済みの方針により
**今回は設計のみで実装しない**（過去のスコア履歴が1件も無い状態から
始まるため、意味のある検証には数ヶ月分のデータ蓄積が必要）。

## 1. データモデル: 日次スコア履歴の蓄積

新規ファイル `score_history.jsonl`（1行1レコードのJSON Lines形式）。
`sector_history.mjs`が既に使っている「日次追記型」パターン
（`appendSectorHistory`）を踏襲する。

```jsonl
{"date":"2026-09-03","code":"9692","market":"JP","section":"AMBUSH","bucket":"NOW","score":95,"buyScore":64,"expectationScore":39,"earningsSurpriseScore":46,"confidenceTier":"HIGH","verdictLevel":"priced_in_caution","price":1583,"daysLeft":10,"earningsDate":"2026-09-13"}
{"date":"2026-09-03","code":"RYZ","market":"US","section":"AMBUSH","bucket":"WATCH","score":80,"buyScore":58,...}
```

- `scraper.mjs`のmain()末尾（既存の`appendSectorHistory(today, ...)`と
  同じタイミング）で、その日のAMBUSH NOW/WATCH/PRE候補・SMART ENTRY
  該当銘柄について1行ずつ追記する。
- テンバガー候補は投資期間が3〜5年と長く、20/60営業日リターンでの検証
  に馴染まないため対象外（別途、年単位の検証が必要になったら再検討）。

## 2. 後日リターンの計測（別バッチ、月次想定）

`score_history.jsonl`の各レコードについて、記録日から一定期間後の
株価を取得し、以下を追記する:

- `outcome20d`: 記録日から20営業日後の終値 / 記録日の終値 - 1
- `outcome60d`: 同様に60営業日後
- `outcomeEarnings`: 決算発表翌営業日の終値 / 発表前日の終値 - 1
  （`earningsDate`が確定している場合のみ）
- `maxDrawdown`: 記録日から60営業日後までの日次終値の最大下落率

JP株は`kabutan.mjs:fetchIntradayExtended`、US株は`us_yahoo.mjs:
fetchDailyBars`を再利用すれば新規のデータ取得手段は不要。ただし
「記録日から60営業日後」の株価を取るには記録日から60日以上経過して
初めて計測可能なため、このバッチは日次ではなく月次（過去分をまとめて
処理）で十分。

## 3. 集計・レポート

新規スクリプト（例: `scripts/backtest_report.mjs`）で、BUY SCORE帯
（80以上 / 70〜79 / 60〜69 / 60未満）ごとに次を集計する:

- `outcome20d`/`outcome60d`/`outcomeEarnings`の平均・中央値
- 勝率（プラスリターンの割合）
- `maxDrawdown`の平均

verdict（🔥強い買い候補〜🔴見送り）別の集計も同様に行い、「verdictが
良いほど実際のリターンも良いか」を検証できるようにする。これは
BUY SCOREの重み付け（期待リターン30・未織り込み度25・サプライズ
期待20・タイミング15・企業クオリティ10）が妥当かどうかの検証にも
使え、将来的な重み再調整の根拠になる。

## 4. 今回実装しない理由（再掲）

- スコア履歴を蓄積する仕組み自体が無いため、まずこの記録を開始する
  必要がある（今回のPhase 2でも未着手）。
- 60営業日後のリターンを検証するには、記録開始から最低60営業日
  （約3ヶ月）の経過が必要で、実装してすぐに使える機能ではない。
- 月次バッチという新しい実行系統（現在はscraper.mjsの日次実行のみ）
  を追加する必要があり、既存のlaunchdジョブ構成にも影響する。

## 5. 次にやること（実装する場合の最初の一歩）

1. `sector_history.mjs`と同じパターンで`score_history.mjs`を新設し、
   `appendScoreHistory(today, results)`をscraper.mjsのmain()末尾に
   追加する（これだけなら数十行、リスクも小さい）。
2. まず記録だけ開始し、3ヶ月ほど蓄積してから集計バッチに着手する。
