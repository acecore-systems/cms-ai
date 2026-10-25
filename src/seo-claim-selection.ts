import { fromMarkdown } from "mdast-util-from-markdown";

// A conservative candidate filter, not proof of truth. Preserve the entire
// paragraph as context; never turn a deployment statement into a product fact.
export function externalClaimCandidate(quote: string, paragraph: string) {
  const plain = (value: string) => {
    const visit = (n: any): string =>
      n.type === "text" || n.type === "inlineCode"
        ? n.value
        : (n.children || []).map(visit).join("");
    return visit(fromMarkdown(value));
  };
  const text = plain(quote),
    context = plain(paragraph);
  if (
    /(?:当社|弊社|私たち|運営|今回|今後|このサイト|当サイト|本サイト|このサーバー|当サーバー|本サーバー)/u.test(
      context,
    ) ||
    /(?:禁止|推奨|ください|ご案内|お知らせ|紹介します|掲載|発信|お伝え|相談|参考資料|参考に|を使った|を採用|導入し|公開し|リニューアル|集約|まとめました|設計しました|整理しました|構成です|事業です|コミュニティです|公開サーバーです)/u.test(
      context,
    ) ||
    /(?:確認できます|確認できる|読み進め|見比べ|進めるように|案内しています|たいときに|参加前に確認)/u.test(
      text,
    ) ||
    /\b(?:we|our)\b|\b(?:this|our) (?:site|server|company)\b/i.test(context)
  )
    return false;
  // Explicit external subject, including a linked document/product name.
  // Unclear subjects are deliberately left for a different editorial workflow.
  return (
    /^\[[^\]]+\]\(https:\/\/[^)]+\)(?:は|では|には)/u.test(quote) ||
    /^(?:[A-Za-z0-9][A-Za-z0-9 .+/#_-]{1,100})(?:は|では|には|の[^。]{0,40}は|を使うと)/u.test(
      text,
    ) ||
    // A named product component can be the grammatical subject with が.
    // Keep the complete sentence/context; this is not a supported-fact verdict.
    /^[A-Za-z0-9][A-Za-z0-9 .+/#_-]{1,100}の[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9 .+/#_ー・-]{1,40}が/u.test(
      text,
    ) ||
    /^[A-Z][A-Za-z0-9 .,+/'()_-]{10,}[.!?]$/u.test(text)
  );
}
