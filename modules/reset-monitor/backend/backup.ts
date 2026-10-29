import { open, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import postgres from "postgres";
import { config } from "@aihot/backend/config";
import { sql } from "@aihot/backend/db";
import { sha256 } from "@aihot/backend/lib/ids";

function pgRestore(args: string[], capture = false, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("pg_restore", args, { env, windowsHide: true, stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"] });
    let output = "";
    child.stdout?.on("data", chunk => { output += String(chunk); });
    child.on("error", () => reject(new Error("pg_restore is required to verify the complete backup")));
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`Backup verification failed (pg_restore exit ${code}); backup is not usable`)));
  });
}
export async function verifyActionBackup(path: string) {
  path = resolve(path);
  if (!(await stat(path)).isFile()) throw new Error("Backup must be a regular custom-format dump file");
  const file = await open(path, "r");
  try { const header = Buffer.alloc(5); await file.read(header, 0, 5, 0); if (header.toString() !== "PGDMP") throw new Error("Backup is not a PostgreSQL custom-format dump"); }
  finally { await file.close(); }
  const toc = await pgRestore(["--list", path], true);
  const tables = await sql<{ schema: string; name: string }[]>`SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind='r'
    ORDER BY n.nspname,c.relname`;
  const required = new Map([...tables, ...["monitor_state", "audit_log", "receipts"].map(name => ({ schema: "public", name }))]
    .map(table => [`${table.schema}.${table.name}`, table]));
  for (const [name, table] of required) {
    const escaped = `${table.schema} ${table.name}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const kind of ["TABLE", "TABLE DATA"]) {
      if (!new RegExp(`^\\d+; \\d+ \\d+ ${kind} ${escaped} `, "m").test(toc)) throw new Error(`Complete backup is missing ${kind}: ${name}`);
    }
  }
  const target = new URL(config.databaseUrl);
  const [current] = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  const name = `backup_verify_${sha256(current!.name).slice(0, 12)}_${randomUUID().replaceAll("-", "").slice(0, 16)}_test`;
  target.pathname = "/postgres";
  const admin = postgres(target.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
  let created = false;
  try {
    // A readable archive can still contain invalid constraints or omit schema. Restore it for real
    // before destructive maintenance; a role without CREATEDB must refuse the maintenance.
    await admin`CREATE DATABASE ${admin(name)} TEMPLATE template0`;
    created = true;
    target.pathname = `/${name}`;
    const env = { ...process.env, ...(target.password ? { PGPASSWORD: decodeURIComponent(target.password) } : {}) };
    target.password = "";
    await pgRestore(["--exit-on-error", "--no-owner", "--no-privileges", "--dbname", target.toString(), path], false, env);
  } finally {
    try { if (created) await admin`DROP DATABASE ${admin(name)} WITH (FORCE)`; }
    finally { await admin.end({ timeout: 5 }); }
  }
}
