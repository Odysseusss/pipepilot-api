import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

if (process.env.VERCEL_ENV !== "production") {
  console.log("Skipping production database migrations outside Vercel production.");
  process.exit(0);
}

const databaseUrl = process.env.STORAGE_DATABASE_URL_UNPOOLED;
if (!databaseUrl) {
  throw new Error("STORAGE_DATABASE_URL_UNPOOLED is required for production migrations.");
}

const migrationSource = readFileSync(
  new URL("../migrations/003_speech_to_pipe_beta.sql", import.meta.url),
  "utf8",
)
  .replace(/^\s*BEGIN\s*;?/i, "")
  .replace(/COMMIT\s*;?\s*$/i, "");

const statements = migrationSource
  .split(/;\s*(?:\r?\n|$)/)
  .map((statement) => statement.trim())
  .filter(Boolean);

if (statements.length === 0) {
  throw new Error("Migration 003 contains no executable statements.");
}

const sql = neon(databaseUrl);
await sql.transaction(statements.map((statement) => sql(statement)));
console.log(`Applied migration 003 (${statements.length} statements).`);
