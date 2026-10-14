import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { closeDb } from "@aihot/backend/db";
import { RESET_MONITOR_BACKENDS } from "@aihot/site/reset-monitor-backends";
import { exportPublicV2, previewPublicV2, applyPublicV2 } from "../backend/public-v2-review.ts";

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(`--${name}`); return index >= 0 ? args[index + 1] : undefined; };
const required = (name: string) => { const value = option(name); if (!value || value.startsWith("--")) throw new Error(`Missing --${name}`); return value; };
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const definitions = RESET_MONITOR_BACKENDS;
try {
  if (command === "export") {
    const output = required("output");
    const bundle = await exportPublicV2(definitions);
    await mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await writeFile(output, json(bundle), { flag: "wx" });
    console.log(json({ output, monitors: bundle.monitors.map(part => ({ monitorId: part.monitorId, events: part.reviews.length })) }));
  } else if (command === "preview" || command === "apply") {
    const input = JSON.parse(await readFile(required("input"), "utf8"));
    const output = required("output");
    // Reserve a new destination before application; never overwrite existing review material.
    await mkdir(path.resolve(output), { recursive: false });
    const result = command === "preview" ? await previewPublicV2(input, definitions) : await applyPublicV2(input, definitions, required("reason"), option("actor"));
    await writeFile(path.join(output, "result.json"), json(result));
    for (const snapshot of result.snapshots) await writeFile(path.join(output, `${snapshot.platform}.json`), json(snapshot));
    console.log(json({ output, changes: result.changes.length, gaps: result.gaps.length }));
  } else throw new Error("Usage: public-v2.ts export --output FILE | preview --input FILE --output DIR | apply --input FILE --output DIR --reason TEXT [--actor NAME]");
} catch (error) {
  // Do not print database URLs, query parameters, source bodies or credentials.
  console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database]") : "Public v2 operation failed");
  process.exitCode = 1;
} finally { await closeDb(); }
