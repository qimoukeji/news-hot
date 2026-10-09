// Installed modules expose their public projections here, just as the engine's exits share publication/.
import { serverModules } from "../modules.ts";

export async function modulePublication<T>(module: string, view: string, input: Record<string, unknown> = {}): Promise<T> {
  const read = serverModules().find((m) => m.name === module)?.publications?.[view];
  if (!read) throw new Error(`Unknown module publication: ${module}/${view}`);
  return await read(input) as T;
}
