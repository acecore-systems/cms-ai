# 取得不能時の限定代替と外部検証候補

検索後に固定した1URLが403になった実失敗と、宣伝・参考先案内しかない記事で計画が不足した実失敗を対象とする。条件を緩めず、新jobに限って検索前の候補確認と同一検索集合内の代替取得を追加する。

## 契約と互換

`0022_seo_research_recovery.sql`は既存jobに`research_recovery=1`を追加し、更新禁止triggerを作る。旧全列・原稿・lock・予算・check・receiptを更新しない。新jobだけ2を明示する。既存jobを再開・再送して新契約へ移さない。

版1の`researchInputs`、claim ID、offset、plan/discovery/retrieval requestと保存結果の再照合は維持する。版2はplan/discovery/researchの入力hashとpreflightへ版を束縛する。異版での再入は追加API前に拒否する。Discoveryは新jobのみ5、表のResearchPlanは3。既存の段落planは1/2のまま。

Evidenceの表候補だけに、原文からcontrollerが組み立てた`tableContext`を追加する。runner・receipt形式・SEO側schemaの変更は不要。SEOの候補照合は従来の`eligible/conflict/ineligible`を使うため、新しい理由`no_external_factual_claim`も順位切詰前に除外できる。各siteのrunner pin更新は不要。

## 生成前の無課金確認

宣言、自己紹介、個別ルール、依頼、採用実績、資料への案内等を事実候補から外す。曖昧な主語を推測せず、明示された製品・文書の主語を持つ文に限定する保守的な構文判定であり、事実性の証明ではない。特に日本語だけの一般主語など、実際は検証可能な文も見送る場合がある。候補の条件・否定は削らず、元段落を全て保持し、最後の選択・外部支持判定は引き続きモデルとAI校閲が担う。

候補ゼロの記事はCMSの候補照合とclaim前の両方で見送り、記事lock・予算予約・有料APIに進まない。個別記事のブラックリストは増やさない。採用実績を外部製品の一般論へ書き換えたり、参考資料から新しい事実文を足したりしない。

GFM表は、明示された製品名/プラグイン名/ツール名と機能/仕様/動作の**2列**だけを対象とする。製品名は安全なHTTPSリンクの単一表示名、機能は12〜800文字の完結した原文で、行全体も800文字以下とする。製品名anchorがURL内にも重複する等、一意性を満たさない行は対象外。表の前後文脈は合計3000文字以下で全量を保持し、超過時は切り詰めず見送る。

表planの`targetQuote`は行原文そのもの、`conditions`は`[featureMarkdown全文]`のexact1要素、`anchors`はリンク表示の製品名exactを必須とする。表の見出しと前後文脈はplanへ固定し、保存結果の再照合でも確認する。旧Wiki由来・現行導入不明という前置きは生成・校閲にも渡す。日本語改訂は対象の見出し・主語・機能・前置きと既存後置条件の保持をサーバーでも検査する。外部資料が裏付けるのは製品機能であり、このサイトの導入実績・現在の利用可能性・旧Wiki記録の正確性ではない。翻訳の意味保持は全原稿との照合とAI校閲で確認する。

## 同一実検索集合内の代替

Discovery5は1回の固定keyword検索から、主資料1件と任意の代替1件を事前に選ぶ。両方ともactual search.sources内のexact URL、新しい外部一次資料で、同じ主張・全条件を独立して支持し得るものに限定する。安全URL、新規性、自サイト・既存資料の除外は従来どおり。選択結果・順序・原本hashは保存し、再読込み時も原本から再構成する。

取得は1つのResponses APIで最大2回のopen。最初が403/404/timeout/空本文等で取得不能のときだけ2件目を開ける。取得できた本文が無関係・反証・不足の場合は代替へ移らずinsufficient。再検索・URL書換え・mirror・同一URL再試行・3件目取得は禁止する。

応答の`retrieval`一覧を実openのURL・順序へ照合し、2open時の先頭は`unavailable`、verified時の末尾は`retrieved`を要求する。採用できるのは最後に開いた1URLだけで、本文説明のAPI url_citationとsource URLも同じものに固定する。別URLの引用、未open、snippetだけ、別claim、余分なtool call、既取得からの乗換は拒否する。資料間で条件やexcerptを混ぜて支持を作らない。

**限界**: provider原本にはopen actionとcitationがあるがHTTP本文や403 statusそのものは返らない。`unavailable/retrieved`は追加のモデル自己申告であり、実HTTP statusの独立証明ではない。自己申告はopen/citationを代替できず、虚偽の取得成否や同一引用先の抜粋内容を機械的に完全検出できるわけでもない。取得本文の全条件支持は研究モデルと後段のAI校閲に依存する。実取得が不明なら採用しない。

## 予算と検証

新契約だけ調査入力を16000から8000 bytesへ制限し、短い専用promptを使用する。plan32000、review500000、9言語generation pool525000、出力上限、全原稿は維持する。最終serialized requestを各capまで埋めて現行cost builderで計算した最大は**1,249,533 microUSD**。1.25 USD/run以下、13 API、30分を維持し、追加のAPI予約はない。2open分は使わなくても全額保守的予約とし、失敗・未確認でも返金しない。月額・10月26日用の確保枠・旧台帳は変更しない。既存料金期限の再確認要件も維持する。

ローカル回帰には旧契約、実失敗形状、表の主語/条件/履歴改変、後置条件、unsafe/self/existing/非検索URL、別URL引用・snippet・余分なopen、保存再読込み、無課金見送り、全9言語の上限証明を含める。旧HEADのbuilder/parserとの74通り比較は完全一致。ローカルfixture成功と実API成功を区別する。

## 配備の引継ぎ

運用担当がコード配備より先に0022を適用し、全旧行・列・trigger・lock・予算の保持、default1とimmutableを独立確認する。その後CMSだけを配備する。この変更の担当範囲はDraft PRまでで、merge・migration適用・本番配備・有料試行は行わない。

自然候補の規則・公開告知・活動案内は無課金対象外になり、旧Wikiのプラグイン表には候補が残ることを実原稿で確認した。新しい一次資料の取得・支持、生成→AI校閲→Draft PRの実成功は未検証であり保証しない。

## Discovery候補選定の指示版（0023）

trial8では、PageSpeedのスコアに関する固定主張を検索し、Lighthouseの資料URLが実検索集合に含まれたが、モデルは「snippetでは主張の支持を検証できない」という理由でdiscoveryをinsufficientにした。これは本文検証に進む前の実失敗として保持する。

新ジョブだけ`discovery_instructions=2`を明示して作成する。0023は同列をdefault1で追加し、変更禁止triggerを設ける。既存ジョブは元のDiscovery5要求文と入力hashを維持する。新しい指示版はdiscoveryの入力hashとeligibility-preflightへ束縛し、propose時も照合する。Discovery応答形式・parser・plan・retrieval・receipt・runnerの契約は変えない。SEO側・各siteのrunner更新は不要。

選定時は二つの条件を独立して確認する。

- 同じ実検索集合内のexact URLで、安全・新規・外部一次資料であること。
- 固定主張全体と全条件について、本文確認に進む関連性があること。

検索結果のtitle/snippet/contextが全条件を扱い得る候補を示す場合、本文が未取得・snippetが支持証明にならないという理由だけで候補無しにしない。無関係・条件違い・既存資料・自己サイト等で全候補が不適切ならinsufficientを維持する。候補選定は支持の認定ではない。取得本文に支持がない場合は従来どおり停止し、別URLへ支持を探し直さない。URL書換え・案内先への追加取得・旧版資料の条件拡張も許可しない。人が別途閲覧したページはworkerの検索・取得証拠に含めない。

今回の無課金検証は465tests、旧HEAD e370d659との45比較一致、trial8原本のinsufficient維持を確認した。保存済み原稿を本番builderへ通したserialized bytesは次のとおり。選定を進める応答は合成であり、本文取得や実モデル成功の証拠ではない。

| 入力                 |   plan | discovery（新版） |    retrieval |
| -------------------- | -----: | ----------------: | -----------: |
| trial8原稿と保存plan | 15,651 |             4,876 |        4,428 |
| 旧Wikiの9表候補      | 16,896 |      6,381〜6,811 | 5,993〜6,423 |

調査requestは全件8,000 bytes以内。9表候補の検索query・URLはサイズ検証用の合成値であり、将来の実選定も最終requestのcap検査を通る必要がある。最大全予約額1,249,533 microUSD、13API、9言語generation pool525,000 bytes、30分、月額は変更しない。capまで埋めた新旧builderによる上限回帰も成功した。有料APIは0回、実際の生成→AI校閲→Draft初成功は未達。trial7の自己実施候補除外は今回の範囲外。

配備担当が0023を先に適用して旧全列・行・trigger保持とdefault1/immutableを確認し、その後CMSを配備する。本修正担当はcommit/push/Draft PR/CIまでを扱う。指示改善でモデルが正しく候補を選ぶことは無課金テストだけでは保証できず、今回の有料再試行は行わない。
