#!/usr/bin/env node
/**
 * みことばの庭 — 買い切り解放コード・教会ライセンス発行＆一覧ツール
 *
 * 使い方（本番D1に対して実行する場合は --remote、ローカル確認は --local）：
 *
 * 1. 個人買い切り用コードを発行（1名用・無期限）：
 *    npm run license:create -- --type personal --note "note購入者様" --remote
 *
 * 2. 教会ライセンスを発行（例：教会員200名・1年間有効・専用スタートリンク付き）：
 *    npm run license:create -- --type church --church "〇〇キリスト教会" --code "MARU-2026" --max 200 --days 365 --remote
 *
 * 3. 発行済みコード一覧を表示：
 *    npm run license:list -- --remote
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";

const DB_NAME = "seisho-tsudoku-notifications";
const APP_BASE_URL = "https://seisho-tsudoku-app.vercel.app/";

function parseArgs(argv) {
  const args = {
    action: "create",
    type: "personal",
    code: "",
    church: "",
    max: null,
    days: null,
    note: "",
    remote: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "list" || a === "--list") args.action = "list";
    else if (a === "create" || a === "--create") args.action = "create";
    else if (a === "--remote") args.remote = true;
    else if (a === "--local") args.remote = false;
    else if (a === "--type" && argv[i + 1]) args.type = argv[++i];
    else if (a === "--code" && argv[i + 1]) args.code = argv[++i];
    else if (a === "--church" && argv[i + 1]) args.church = argv[++i];
    else if (a === "--max" && argv[i + 1]) args.max = Number(argv[++i]);
    else if (a === "--days" && argv[i + 1]) args.days = Number(argv[++i]);
    else if (a === "--note" && argv[i + 1]) args.note = argv[++i];
  }
  return args;
}

function generateReadableCode(prefix = "NIWA") {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let part1 = "";
  let part2 = "";
  for (let i = 0; i < 4; i += 1) {
    part1 += alphabet[bytes[i] % alphabet.length];
    part2 += alphabet[bytes[i + 4] % alphabet.length];
  }
  return `${prefix}-${part1}-${part2}`;
}

function sqlString(val) {
  if (val === null || val === undefined || val === "") return "NULL";
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function runD1Sql(sql, remote) {
  const flag = remote ? "--remote" : "--local";
  return execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, flag, "--command", sql],
    { stdio: "inherit" }
  );
}

const opts = parseArgs(process.argv.slice(2));

if (opts.action === "list") {
  const sql =
    "SELECT code, plan_type, church_name, used_count, max_uses, expires_at, is_active, note FROM invite_codes ORDER BY created_at DESC;";
  runD1Sql(sql, opts.remote);
  process.exit(0);
}

const planType = opts.type === "church" ? "church" : "personal";
const code = (
  opts.code ||
  generateReadableCode(planType === "church" ? "CHURCH" : "NIWA")
)
  .trim()
  .toUpperCase();
const churchName = planType === "church" ? opts.church.trim() : "";
const maxUses =
  Number.isFinite(opts.max) && opts.max > 0
    ? Math.floor(opts.max)
    : planType === "church"
      ? 200
      : 1;
const expiresAt =
  Number.isFinite(opts.days) && opts.days > 0
    ? new Date(Date.now() + opts.days * 86400 * 1000).toISOString()
    : null;
const nowIso = new Date().toISOString();

const insertSql = `INSERT OR REPLACE INTO invite_codes (code, plan_type, church_name, max_uses, used_count, expires_at, note, is_active, created_at) VALUES (${sqlString(code)}, ${sqlString(planType)}, ${sqlString(churchName || null)}, ${maxUses}, COALESCE((SELECT used_count FROM invite_codes WHERE code = ${sqlString(code)}), 0), ${sqlString(expiresAt)}, ${sqlString(opts.note || null)}, 1, ${sqlString(nowIso)});`;

runD1Sql(insertSql, opts.remote);

const url = new URL(APP_BASE_URL);
if (churchName) url.searchParams.set("church", churchName);
url.searchParams.set("invite", code);

console.log("\n========================================");
console.log("✨ ライセンスコードを発行しました！");
console.log("----------------------------------------");
console.log("種別        :", planType === "church" ? "教会ライセンス" : "個人買い切り");
console.log("解放コード  :", code);
if (churchName) console.log("教会名      :", churchName);
console.log("上限人数    :", maxUses + " 名");
console.log("有効期限    :", expiresAt ? expiresAt.slice(0, 10) : "無期限（買い切り）");
console.log("専用リンク  :", url.toString());
console.log("========================================\n");
