# 静的候補選定の日本語主語判定と入力計測

2026-10-25の候補0件のうち、CMS側で実本文から確認できた偽陰性だけを修正する。lock再選定、本番適用、AI実試行は親担当で、この変更に含めない。

## 変更

- `製品名 の 機能名が〜`という日本語の主語構文を候補として認識する。製品名・記事名・サイト名の例外を追加しない。機能名は漢字・カタカナ・英数字等の限定された名詞形とし、不明な主語を一律に許可しない。
- 原文の完結文・段落・否定・バージョン・requiredConditionsを保持する。候補であることと外部資料による裏付けは別であり、unknown/insufficientをsupportedへ変えない。
- 新規eligibilityの`currentInputPreflightOptions`にmodel_version=2を明示する。呼出し側での上書きはなく、従来はResponses形式で計測していた。実際のDeepSeek payloadとplan24000/generation48000の形式に合わせる。入力上限、費用計算、期限、既存job契約は変更しない。

## 実本文の無課金replay

Systems snapshot commit `b367fd13ca80257178c9ac0397fdbb2caa60c1ab`の`astro-i18n-blog-translation.md`で、製品のglob loaderと再帰patternに関する完結文を現行フィルタが認識できないことを確認した。source SHA-256は`5dc1f70ec9b598ef40a2c6ac3bd090cc212f0bc98ea3e2389dfe2caa0fdbc199`。修正前false、修正後true。同じ原稿の修正後入力はplan22,138、review43,510、generation42,215 bytesで、現行上限内。

外部確認対象はglob loaderのpatternによる再帰ファイル検出。主張全文とパターン文字列を維持し、現行ドキュメントの該当API説明を調査する必要がある。別の実装経験文に含まれる「設定変更不要」を一般的製品保証へ読み替えない。この記事の一次資料との一致・生成・校閲・Draft成功は未検証。

Hatt紹介、AI検証の実施報告、参加案内、自社紹介は従来の拒否を維持。Vectorize等の入力超過12URLはDeepSeek形式への修正後もplan上限を超える。今回のmodel_version漏れは計測差の不具合だが、この12URLの直接原因ではなかった。Corporateのcanonical除外10URLはsnapshot上の日本語原稿が存在しなかった。翻訳本文を代用せず拒否を維持する。

## 検証と取扱い

合成fixtureで主語構文、段落保持、否定・原文変更拒否、insufficient拒否、自社導入/指示の拒否、DeepSeek実payload byte一致、翻訳URLから同一日本語canonicalへの対応、原稿不存在時の拒否を検証する。既存のresearch exact claim/source・条件・品質ガードは変更しない。

実記事の全文は保存せず、opt-inテストで固定Git objectをメモリ内だけで読み、hash・判定・サイズを出力する。通常CIへ私的原稿を渡さない。実記事positiveとnegative controlsのreplayは次で再現する。

```powershell
$env:CMS_RESELECTION_REPLAY_ROOT = 'C:/Users/gnish/repos'
npx vitest run tests/seo-candidate-reselection-replay.test.ts
```

Node24を使用し、WindowsのTEMP/TMPはSEO root `.local/candidate-reselection-20261025/tmp`へ設定する。既定sandbox TempではMiniflare R2 fixture保存が失敗した履歴がある。ログ・hash・短い診断は同じ`.local/candidate-reselection-20261025`に保持し、原稿本文をcommitしない。判定改善は実AIの裏付け成功を保証しない。追加AI・merge/deployは親の実台帳/予算/候補別preflight確認後に行う。
