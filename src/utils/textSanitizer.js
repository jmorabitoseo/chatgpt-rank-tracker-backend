/**
 * sanitizeText(input, opts)
 * - Removes common markdown artifacts, excessive punctuation, escapes, and HTML tags/entities.
 * - Converts markdown links [text](url) -> "text (url)"
 * - Normalizes lists to "-" bullets and collapses blank lines.
 */
function sanitizeText(input, opts = {}) {
  const { preserveLists = true, maxConsecutiveBlankLines = 1 } = opts;

  if (!input || typeof input !== "string") return "";

  let s = input;

  // 1) Convert literal "\n" sequences into real newlines (handles strings with escaped newlines)
  s = s.replace(/\\n/g, "\n");

  // 2) Convert markdown links [text](url) -> text (url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, text, url) => `${text} (${url})`
  );

  // 3) Remove code fences ```...``` but keep inner content; remove inline `code`
  s = s.replace(/```[\s\S]*?```/g, (match) => {
    // strip backticks and keep inner
    return match.replace(/```/g, "").trim();
  });
  s = s.replace(/`([^`]+)`/g, "$1");

  // 4) Remove headings markers (#, ##, ###) at start of lines but keep heading text
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, "");

  // 5) Remove emphasis markers but keep text: **bold**, *italic*, __bold__, _italic_
  s = s.replace(/(\*{1,3}|_{1,3})(.*?)\1/g, "$2");

  // 6) Convert ordered list numbers "1. " to "- " and convert leading "- ", "* " to "- "
  if (preserveLists) {
    s = s.replace(/^[ \t]*\d+\.\s+/gm, "- ");
    s = s.replace(/^[ \t]*[*\u2022-]\s+/gm, "- ");
  } else {
    s = s.replace(/^[ \t]*\d+\.\s+/gm, "");
    s = s.replace(/^[ \t]*[*\u2022-]\s+/gm, "");
  }

  // 7) Remove stray asterisks and repeated pound signs that are not part of words
  s = s.replace(/(^|\s)[*#]{2,}(\s|$)/g, " ");

  // 8) Remove backslash escapes (\" -> ", \\ -> \)
  s = s.replace(/\\([\\`*_{}[\]()#+\-!."])/g, "$1");

  // 9) Strip HTML tags (simple)
  s = s.replace(/<\/?[^>]+>/g, "");

  // 10) Decode common HTML entities (basic)
  const entities = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&nbsp;": " ",
  };
  s = s.replace(/&[a-zA-Z#0-9]+;/g, (e) => entities[e] ?? e);

  // 11) Normalize punctuation spacing: ensure single space after .,?!; if followed by non-newline
  s = s.replace(/([.?!;:])([^\s\n])/g, "$1 $2");

  // 12) Collapse multiple spaces into one (but preserve newlines)
  s = s.replace(/[ \t]{2,}/g, " ");

  // 13) Collapse multiple blank lines to maxConsecutiveBlankLines
  const blanks = "\n".repeat(Math.max(1, maxConsecutiveBlankLines));
  s = s.replace(/\n{2,}/g, blanks);

  // 14) Trim each line's trailing/leading spaces
  s = s
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  // 15) Final trim
  return s.trim();
}
module.exports = { sanitizeText };
