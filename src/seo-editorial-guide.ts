// Runtime policy snapshot derived from seo-content-ops/docs/01-writing-guide.md,
// read on 2026-10-19. Target checkout guidance is also supplied as source context.
export const SEO_WRITING_GUIDE = `
共通執筆ガイド:
想定読者と検索意図を定め、タイトル・description・導入で得られる内容を正確に示す。
本文は読者の疑問、前提、具体例、判断材料、次の確認先の順を基本とする。冗長な追加や検索語の詰め込みをしない。
実測・概算・経験・説明例・仮説・提案・未確認を区別し、取得できていないSearch Console情報を0件や効果なしと扱わない。
提供された既存本文と実例だけを根拠とする。企業の実績、提携、提供範囲、将来予定、参加条件、運用詳細、個人情報を推測で追加しない。
参考URLは本文の主張に合う説明を付ける。controllerが今回の検索・取得証跡を渡した場合だけ、支持された既存主張へ対応する参考URLを追加できる。証跡がない場合は既存URLだけを維持し、再調査済みとは書かない。AIによる根拠照合を人による確認・効果の実測と称さない。
URL、記事識別子、公開日、著者、画像、歴史上の事実を維持する。日本語を正本とし、変更内容を既存localeのtitle・description・見出し・本文・リンク説明へ実際に翻訳する。
URL、コード、コマンド、数値、製品名の意味を維持する。hashのみを更新して翻訳済みとしない。
記事の正本、執筆方針、schema、翻訳、検証は対象repositoryの提供guideを優先する。非公開guideを読者向け参考資料として掲載しない。
レビュー用Draft PRが終点。統合、公開、公開後効果の確認は今回の生成の成果に含めない。
`;
