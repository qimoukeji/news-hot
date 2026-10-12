import type { Proposition } from "@aihot/reset-monitor/backend/recognize";
import { productForAuthor, scopeConflicts as sharedScopeConflicts } from "@aihot/reset-monitor/backend/scope-policy";
import { monitor } from "@aihot/reset-monitor/backend/context";
export { quotaScope } from "@aihot/reset-monitor/backend/scope-policy";

export const defaultProductForAuthor = (author: string, current = monitor()) => productForAuthor(current.authors, author);
export const scopeConflicts = (a: Proposition["scope"], b: Proposition["scope"], current = monitor()) => sharedScopeConflicts(a, b, current.productAliases);
