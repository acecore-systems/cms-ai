# SEO v5 の検索と証拠

新規 v5 ジョブは既存の検索計画から Parallel Search MCP の匿名 `web_search` を一度呼びます。検索結果の URL は既存の出版社 allowlist と既出 URL 除外で選別し、Muse Ember / medium が選択します。選択された URL のみを既存の時間・サイズ・ホスト制限付き HTTP 取得で読みます。リダイレクトや未検索の親 URL への移動は許可しません。検索失敗、取得失敗、本文の不一致、利用上限や検証失敗時は unresolved となり Luna にフォールバックしません。匿名サービスはレート制限や可用性の保証がなく、許可出版社の結果が得られない場合も停止します。

原文 HTML を静的に解析し、head、script、style、明示的に隠された要素を除き、テキストを正規化します。外部 CSS や JavaScript は実行しないため、ブラウザー表示との差はありえます。Muse は最大 2000 文字の抜粋について、対象・条件・否定を保持するよう指示されます。検証は実取得した本文に引用が実在することを証明しますが、意味的な支持を機械的に保証するものではありません。既存の生成後チェックと校閲を維持します。

検索要求・応答、取得本文、モデル応答と proof を非公開 R2 に保存し、D1 の不変行にハッシュを記録します。proof は取得 URL・時刻・本文バイト列の SHA-256、正規化本文の SHA-256 と引用位置を保持します。生成前に検索から本文とモデル応答まで再検証し、取得済み引用のみを既存 runner の v1 共通形式に投影します。provider の citation と偽装しません。過去の v4 proof は v5 として再解釈しません。

予算は既存の実行あたり $1.25・月 $7 の上限を維持し、入力バイト数と出力上限を事前予約します。v5 の最大予約計算は従来の保守的な検索枠も含むため、実際の無料検索に対して過大に見積もります。2026-11-11 の 1000 バイト入力・翻訳 2 件の例では最大 568,763 µUSD です。実際の上限判定は各ジョブの入力と配分で行います。

## 適用と検証

1. 先行 migration を確認した後、`0048_seo_parallel_models.sql` を適用します。旧行の変更・削除や旧トリガーの置換はありません。新テーブルおよび新トリガーは追加され、不変証跡を書き始めた後の破棄は監査履歴の損失を伴います。
2. `SEO_AI_MODEL=muse-ember-1.0`、`SEO_SEARCH_PROVIDER=parallel-free` と既存 Meta Secrets Store binding を確認し、隔離環境で合成入力の検索・本文取得・検査を行います。実検索は外部サービスへクエリを送信し、Muse の実呼出しは課金対象です。
3. 限定 canary で新規 v5 の証拠・費用・unresolved を確認してから段階展開します。`tests/seo-editorial.test.ts` の `parallel-wiki-pass` は無通信の全経路 fixture です。`tests/seo-parallel-search.test.ts`、`tests/seo-parallel-evidence.test.ts`、`tests/seo-v5-contract.test.ts` は個別契約を検証します。

実サービスの隔離検証では、`parallelSearch(queries, callId, deadline)` に URL を含まない合成クエリ 1〜2 件、`seo-` + UUID の callId、将来のミリ秒期限を渡します。戻り値の `value` を `parallelCandidates(value, source, scope, referencePolicy)` に渡し、許可候補から 1 URL を既存 `recoverSources` の v5 経路で取得します。本文・plan・scope・各 SHA-256・取得時刻・期限と Muse の実応答を `parallelEvidence` に渡し、実本文に存在する引用が受け入れられることを確認します。全経路は `parallelResearch` と `verifyParallelResearch` が結合します。実運用データや本番 D1 は使わず、失敗時の監査データも隔離先で確認してください。

切替後は v1〜v4 の新規有料呼出しを拒否し、旧証跡の参照は保持します。途中の旧ジョブは再開できないため、切替直前に稼働中 v4 を確認してください。障害時は新規受付を止め、必要に応じて旧 Worker と `SEO_SEARCH_PROVIDER=luna-legacy` に戻します。この明示的な復旧では旧 Luna 呼出しが再び可能になるため、モデル退役方針との関係を運用者が判断します。v5 が進行中なら新 Worker と binding を保持して安全に終端させてから戻します。0048 は残し、旧データを削除しません。
