/** A link to an X Article supplies no evidence about its unsaved body. */
export function sourceContentIssue(text: string): string | null {
  const links = text.trim().split(/\s+/);
  return links.length > 0 && links.every(link => /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/\d+(?:[?#].*)?$/i.test(link))
    ? "X Article 正文未保存，无法判断文章是否包含额度事件"
    : null;
}
