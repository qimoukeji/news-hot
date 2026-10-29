import type { SourcePostRow } from "../actions.ts";

export interface ThreadGroup {
  targets: SourcePostRow[];
  context: SourcePostRow[];
  issues: string[];
}
const authorKey = (value: string) => value.replace(/^@/, "").toLowerCase();
const at = (post: SourcePostRow) => new Date(post.published_at).getTime();
const chronological = (left: SourcePostRow, right: SourcePostRow) => at(left) - at(right) || left.id.localeCompare(right.id);

/** Group official posts through explicit edges; a shared external quotation is never a bridge. */
export function buildThreadGroups(posts: SourcePostRow[], officialAuthorHandles?: readonly string[]): ThreadGroup[] {
  const saved = new Map(posts.map(post => [post.id, post]));
  const officialAuthors = new Set((officialAuthorHandles ?? posts.filter(post => !post.context_only).map(post => post.author)).map(authorKey));
  const targets = posts.filter(post => !post.context_only && post.processing_status === "pending" && officialAuthors.has(authorKey(post.author)));
  const parent = new Map(posts.map(post => [post.id, post.id]));
  const issues = new Map<string, Set<string>>();
  const edges = new Map<string, string[]>();
  const note = (id: string, message: string) => {
    const list = issues.get(id) ?? new Set<string>(); list.add(message); issues.set(id, list);
  };
  function root(id: string): string {
    let next = id;
    while (parent.get(next) !== next) next = parent.get(next)!;
    while (parent.get(id) !== id) { const previous = parent.get(id)!; parent.set(id, next); id = previous; }
    return next;
  }
  function join(left: string, right: string) { parent.set(root(left), root(right)); }
  for (const post of posts) {
    const links: string[] = [];
    if (!post.text?.trim()) note(post.id, `帖子 ${post.id} 缺少可读正文`);
    if (!Number.isFinite(at(post))) note(post.id, `帖子 ${post.id} 发布时间无效`);
    const references = [
      ...(post.reply_to ? [{ id: post.reply_to.postId, author: post.reply_to.author, time: null as string | null, kind: "父帖" }] : []),
      ...(post.quoted_post ? [{ id: post.quoted_post.id, author: post.quoted_post.author, time: post.quoted_post.publishedAt, kind: "引用" }] : []),
    ];
    for (const reference of references) {
      if (!reference.id) { note(post.id, `帖子 ${post.id} 缺少${reference.kind} ID`); continue; }
      const ancestor = saved.get(reference.id);
      if (!ancestor) { note(post.id, `帖子 ${post.id} 的${reference.kind} ${reference.id} 上下文不可用`); continue; }
      if (ancestor.id === post.id || !Number.isFinite(at(ancestor)) || at(ancestor) > at(post)) {
        note(post.id, `帖子 ${post.id} 的${reference.kind} ${reference.id} 时间或关系无效`); continue;
      }
      if (reference.author && authorKey(reference.author) !== authorKey(ancestor.author)
        || reference.time !== null && Date.parse(reference.time) !== at(ancestor)) {
        note(post.id, `帖子 ${post.id} 的${reference.kind} ${reference.id} 身份或时间冲突`); continue;
      }
      links.push(ancestor.id);
      if (officialAuthors.has(authorKey(post.author)) && officialAuthors.has(authorKey(ancestor.author))) join(post.id, ancestor.id);
    }
    edges.set(post.id, links);
  }
  const grouped = new Map<string, SourcePostRow[]>();
  for (const post of targets.sort(chronological)) {
    const key = root(post.id), group = grouped.get(key) ?? [];
    group.push(post); grouped.set(key, group);
  }
  return [...grouped.values()].map(groupTargets => {
    const targetIds = new Set(groupTargets.map(post => post.id));
    const ancestors = new Set<string>(), messages = new Set<string>();
    function visit(id: string, path: Set<string>) {
      if (path.has(id)) { messages.add(`帖子关系存在循环：${id}`); return; }
      if (ancestors.has(id)) return;
      ancestors.add(id);
      for (const issue of issues.get(id) ?? []) {
        if (officialAuthors.has(authorKey(saved.get(id)!.author)) || /缺少可读正文|发布时间无效/.test(issue)) messages.add(issue);
      }
      const nextPath = new Set(path); nextPath.add(id);
      if (officialAuthors.has(authorKey(saved.get(id)!.author))) for (const reference of edges.get(id) ?? []) visit(reference, nextPath);
    }
    for (const post of groupTargets) visit(post.id, new Set());
    return { targets: groupTargets, context: [...ancestors].filter(id => !targetIds.has(id)).map(id => saved.get(id)!).sort(chronological), issues: [...messages] };
  }).sort((left, right) => chronological(left.targets[0], right.targets[0]));
}
