# 2026年10月の承認済み月額上限12.48 USD

2026-10-24の利用者承認により、JSTの2026年10月だけ12.10から12.48 USDへ変更する（+0.38 USD）。追加実確認1回は親担当が行う。通常月7 USD、1回1.25 USD、10月26日用1.25 USD留保、全工程30分、48k生成契約と0036の資料復旧契約は変更しない。

`monthBudgetMicros("2026-10")`は12,480,000 microUSD。`newJobMonthLimit`は10月26日00:00 UTCより前は留保を引いた11,230,000、同時刻以後は12,480,000。JSTの11月以降と他年の10月は7,000,000を維持する。

親の取得台帳9,979,519 microUSD / 130 callsに対して留保後の残額は1,250,481、1回上限との差は481 microUSD。候補・予約額が変われば無料preflightと原子的予約判定で再確認し、超過はAI呼出し前に停止する。生成成功や追加回数を保証しない。

## migrationと検証

新規`0037_seo_october_budget_1248.sql`のみを追加し、0035を含む旧migrationは編集しない。変更対象は次の3triggerの金額定数だけ。

- `seo_budget_cap`：12,100,000 → 12,480,000。
- `seo_fallback_first_call_fit`：12,100,000 → 12,480,000。
- `seo_model_reservation`：10月26日00:00 UTC前10,850,000 → 11,230,000。

旧台帳・run/job・未解決予約・lock・receipt・期限・モデルpinを更新/削除しない。保存snapshotの旧371行を保持し、既存180 schema objectのうち上記3triggerの金額以外不変をSQLite replayで確認した。

全テスト723 passed / 1 skipped。skipは既存の非公開候補trial再生用`CMS_CANDIDATE_REPLAY_DIR`未設定によるもの。JST月境界、留保時刻、1 microUSD超過、run上限、fallback全工程fit、実D1の監査必須・競合予約・留保上限を確認した。初回に旧上限用の残額不足fixtureが新上限で受付可能となり1件失敗したため、最新migrationと不足する予約額へ同期して再実行した。

## 本番反映順序

CMSはmainへのGit push buildで自動配備されるため、**親が0037適用・旧行/schema照合を完了してからmerge/deployする**。旧コードは小さい上限で判定するためmigration先行時は保守側となる。CI・正確なmerge SHA・本番versionを照合後、親が承認された1回を新runで実施する。

実装担当は本番write・merge/deploy・AI実呼出しを行わない。今回のローカル検証は本番生成・校閲・Draft成功の実証ではない。前回の承認額の記録は[12.10 USD記録](seo-october-budget-1210.md)に保持する。
