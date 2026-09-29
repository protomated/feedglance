/**
 * Flatten an item description into plain text for a short preview.
 *
 * Both providers store Markdown (YouTrack may still hold legacy wiki markup on
 * old issues, Nifty adds `<@userId>` mentions). A preview only needs the words,
 * so this strips syntax rather than rendering it: code blocks and images carry
 * no readable gist and are dropped, links keep their label, and all whitespace
 * collapses so line clamping measures real sentences, not blank lines.
 */
export function toPlainSnippet(source: string): string {
  return (
    source
      // Fenced and legacy-wiki code blocks.
      .replace(/```[\s\S]*?(```|$)/g, " ")
      .replace(/\{code\}[\s\S]*?(\{code\}|$)/g, " ")
      // Images before links, since `![alt](src)` also matches the link pattern.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // HTML tags and Nifty `<@id>` mentions.
      .replace(/<[^>]+>/g, " ")
      // Line-leading headings, quotes and list markers.
      .replace(/^[ \t]*(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, "")
      // Inline emphasis and code markers. The word-boundary guards keep
      // identifiers like `snake_case_name` intact.
      .replace(/(^|[^\w])(\*\*|__|~~|`|\*|_)(?=\S)([^\n]*?\S)\2(?!\w)/g, "$1$3")
      .replace(/\s+/g, " ")
      .trim()
  );
}
