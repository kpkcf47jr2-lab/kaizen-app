// ─────────────────────────────────────────────────────────────────────
//  Waitlist store — append-only JSONL. No SQLite dep for one column.
//  Landing page POSTs { email, source } → we deduplicate + write a line.
//  Reads use fs.readFile so a bad file doesn't crash the server.
// ─────────────────────────────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.KAIZEN_DATA_DIR
  ? path.resolve(process.env.KAIZEN_DATA_DIR)
  : path.resolve(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "waitlist.jsonl");

export type WaitlistEntry = {
  email: string;
  source: string;
  ts: number;
  ip?: string;
  ua?: string;
};

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, "", "utf8");
}

export function isValidEmail(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

export function loadEmails(): Set<string> {
  ensureFile();
  const raw = fs.readFileSync(FILE, "utf8");
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as WaitlistEntry;
      if (entry.email) seen.add(entry.email.toLowerCase());
    } catch { /* ignore garbage lines */ }
  }
  return seen;
}

export function appendEntry(entry: WaitlistEntry): void {
  ensureFile();
  fs.appendFileSync(FILE, JSON.stringify(entry) + "\n", "utf8");
}

export function count(): number {
  return loadEmails().size;
}
