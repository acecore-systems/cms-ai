# 検索前の計画指示 v2

検索前の計画成立と、検索後の資料による裏付けを分離する指示改善。実モデルの成功率改善は未測定であり、追加の有料検証は実施していない。

## 確認した事実と限界

旧計画schemaの成功値は `ready` だが、instructionsでは失敗値 `insufficient` だけが明示されていた。保存済み応答は空の通信応答ではなく、finish_reason=stopの正常なJSONでinsufficientと空の計画フィールドを返していた。final JSONにはその選択理由がないため、プロンプトの欠落が当該応答の直接原因だったとは断定しない。推論本文は診断出力・文書・fixtureに転載しない。

旧記事の履歴注記と製品機能の表は既存の抽出器で扱える。保存済み原稿の無課金再現ではtable候補9件、CoreProtectの独立機能は選択可能であり、手組ready計画が既存parsePlanを通った。これは実モデルの選択成功でも、新規資料取得のreceiptでもない。親の調査URLや手組planを自動処理の根拠へ注入しない。

## 新規jobだけの変更

0033は `seo_plan_contracts` を追加する。登録をjob作成より先に同一batchで行い、遅延FKで孤立行を拒否する。既存jobへの後付け、登録の更新・削除・置換、jobのidentity変更を禁止する。登録がない旧jobはv1であり、旧schema・台帳・receiptを変更しない。

v2は成功 `ready` と失敗 `insufficient` の両方と完全なJSON schemaをsystem指示にも明示する。検索可能な原文の独立した事実を選ぶ段階で、資料本文の取得・URL発見・裏付け済みを要求しない。候補を特定できない場合や条件を保ったqueryを作れない場合は引き続き停止する。table候補では行全体をexact指定し、機能セル全文をconditions、製品名をanchorにする。履歴注記を保持し、自サイトの導入実績を外部製品資料で証明したとは扱わない。

schema、原文exact、条件・否定・時点の保持、query形式、外部性、新規URL、取得本文の根拠、生成・校閲の品質ゲートは変更しない。モデルpin、reasoning high、store:false、予約・期限・無再試行・usage確認も維持する。

v2はeligibility-preflightとplanチェックの入力hashにも保存する。旧jobは保存済み版からpayloadを作り、現在の無料候補検査presetで再解釈しない。無料検査と実送信は同じbuildPlanRequestとDeepSeek adapterを使う。実原稿のChat payloadは旧16,880→新17,249 bytesで、計画上限32,000 bytesを維持する。最大費用の上限、月・run・週次留保は増額しない。

## schema伝達と段階境界

[DeepSeekモデル仕様](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/)にはresponse_formatが定義される。[JSON Mode仕様](https://developers.cloudflare.com/workers-ai/features/json-mode/)にはschema応答の限界が記載される。今回のmockではChatのresponse_formatとsystemに同じschemaが届くことを確認するが、プロバイダー内部での強制方法は未検証。schema形式を推測で変更せず、既存adapterとローカル厳格検証を維持する。

現行discovery_instructions=2は既に「snippetは関連性の手掛かりであり、未取得の本文による支持判定は次段階」と明示している。今回はその経路を回帰検査し、検索契約を変更しない。既存URL・不適切URLの除外は緩めない。取得不能と取得済み本文の支持不足を完全に区別する新ワークフローは追加しない。

## 配備と検証

0033を先に適用してからWorkerを配置する。実D1互換で先行登録batch成功・孤立行rollback・旧job v1を検査。SQLiteでは保存済み旧行と既存schema定義の不変を照合する。モデルmockの回帰は原文table選択、条件破損拒否、schema伝達、送信量、旧payload維持を対象とし、実品質改善や本番生成成功を証明するものではない。
