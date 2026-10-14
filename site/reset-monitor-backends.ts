// Operations commands use the site's installed monitors; the shared engine does not import peers.
import { backendDefinition as codex } from "../modules/codex-reset/backend-definition.ts";
import { backendDefinition as claude } from "../modules/claude-reset/backend-definition.ts";
import { backendDefinition as grok } from "../modules/grok-reset/backend-definition.ts";

export const RESET_MONITOR_BACKENDS = [codex, claude, grok];
