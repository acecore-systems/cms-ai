// Synthetic article shape from the canary: GFM tables, numbered steps,
// Japanese prose, image and preserved code. No stored proposal content.
export const articleBody = `
## Original 接続の確認

Original 接続環境を確認します。**設定**と[資料](https://example.org/guide)を確認します。

| 確認する項目 | 対応する操作 | 注意事項 |
| --- | --- | --- |
| Original 接続方法 | アドレスを確認 | 入力を確認 |
| Original 環境 | 設定画面を確認 | 資料と比較 |

1. Original 設定を確認します。
2. Original 接続先を確認します。

![Original 設定画面](/uploads/story.webp)

| Original 状態 | 操作 |
| :--- | ---: |
| Original 接続待ち | 確認 |

\`\`\`text
server address
\`\`\`

Original \`inline code\` を確認します。  
Original 次の行です。
`;

// Portal's Markdown options (the Astro plugin does not process .md files).
export const portalFormat = {
  parser: "markdown",
  semi: false,
  singleQuote: true,
  trailingComma: "all",
} as const;
