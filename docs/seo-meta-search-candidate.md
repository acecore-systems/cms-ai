# Meta 検索アダプター候補

この差分は無通信の互換性検査であり、稼働中の検索ルート、予算式、D1 ジョブ、設定を変更しない。v5 への切替は未実装である。

Meta Responses の `web_search` は `max_tool_calls` で built-in tool 呼出しを制限する一方、`tool_choice` は `auto` のみを受け付ける。検索が必ず実行されるとは限らない。`web_search_call.results` は検索結果、`open_page` と `url_citation` は別の証拠として検査する。raw 応答を保存・ハッシュしないまま、検索結果を閲覧済みページやプロバイダー引用に変換してはならない。

2026-11-11 の合成検索では、1 call、`action.query`、`results` 9 件、複数 message、最終 JSON、引用なしを観測した。別の合成取得では、実際の `open_page`、空の results、最終 message の `url_citation` 2 件を観測した。いずれも本番記事の受入を意味しない。

## 予算の未決事項

[Meta の料金表](https://dev.meta.ai/docs/pricing-rate-limits) は検索を query 単位で課金し、[Responses schema](https://dev.meta.ai/docs/api-reference/responses/schemas) は 1 回の search action に複数の queries を認める。`max_tool_calls` と query 数の関係に強制上限は確認できていない。[token counting](https://dev.meta.ai/docs/token-counting) は hosted tool の入力 tokens がモデル反復ごとに累積し、事前の token count では後続 tool 結果の増加を予測できないと説明する。`search_context_size` の数値上限も未確認である。

現在の OpenAI ルートは [検索 context 128k の上限](https://developers.openai.com/api/docs/guides/tools-web-search) と [tool call 単位の料金](https://developers.openai.com/api/docs/pricing) をもとに予約する。これらをそのまま Meta の保証と見なさない。実際の支出管理・provider cap・予約額の扱いは運用判断と確認を要する。モデルへの指示や事後の拒否は課金前の上限ではない。

従来の分割フローは discovery 後、制御側で検索由来 URL・既存 URL・出版社・候補を検証してから取得を許可する。1 回のモデル実行で検索と open を連続させると、この取得前の制御境界が失われるため、同じ安全性とは扱わない。
