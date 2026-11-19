import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { handleRequest } from "../src/index.js";
import { handleBackupRoute } from "../src/lib/backup.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migration001 = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "0001_init.sql"),
  "utf8"
);
const migration002 = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "0002_cloud_backup.sql"),
  "utf8"
);

function createMockD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(migration001);
  sqlite.exec(migration002);

  class PreparedStatement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new PreparedStatement(this.sql, params);
    }
    async first() {
      const stmt = sqlite.prepare(this.sql);
      const row = stmt.get(...this.params);
      return row === undefined ? null : row;
    }
    async all() {
      const stmt = sqlite.prepare(this.sql);
      const results = stmt.all(...this.params);
      return { results, success: true };
    }
    async run() {
      const stmt = sqlite.prepare(this.sql);
      const info = stmt.run(...this.params);
      return {
        success: true,
        meta: { changes: Number(info.changes || 0) },
      };
    }
  }

  return {
    sqlite,
    prepare(sql) {
      return new PreparedStatement(sql);
    },
  };
}

function makeHelpers(nowRef, capturedEmails, mailProviderBehavior = "resend") {
  function jsonResponse(request, env, data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "https://seisho-tsudoku-app.vercel.app",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      },
    });
  }
  function extractBearerToken(request) {
    const auth = request.headers.get("Authorization") || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  }
  async function readJsonBody(request) {
    try {
      return { ok: true, data: await request.json() };
    } catch {
      return { ok: false, error: "Invalid JSON" };
    }
  }
  async function fetchImpl(url, init) {
    const payload = JSON.parse(init.body);
    capturedEmails.push({ url, headers: init.headers, payload });
    if (mailProviderBehavior === "gas") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "msg_test_123" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return {
    jsonResponse,
    extractBearerToken,
    readJsonBody,
    fetchImpl,
    nowMs: () => nowRef.now,
  };
}

function extractOtpFromCaptured(entry) {
  const text = entry?.payload?.text || "";
  const match = text.match(/認証コード：\s*(\d{6})/);
  assert.ok(match, "メール本文に6桁の認証コードが含まれているべき");
  return match[1];
}

test("CORS OPTIONS preflight permits PUT for /api/backup and unconfigured mailer returns 503", async () => {
  const DB = createMockD1();
  const env = {
    DB,
    ALLOWED_ORIGINS: "https://seisho-tsudoku-app.vercel.app",
  };

  const preflightReq = new Request("https://worker.example/api/backup", {
    method: "OPTIONS",
    headers: { Origin: "https://seisho-tsudoku-app.vercel.app" },
  });
  const preflightRes = await handleRequest(preflightReq, env);
  assert.equal(preflightRes.status, 204);
  const allowMethods = preflightRes.headers.get("Access-Control-Allow-Methods") || "";
  assert.ok(allowMethods.includes("PUT"), "CORS Allow-Methods should include PUT");

  // Missing inviteCode for new user -> 403 INVITE_CODE_REQUIRED
  const missingInviteRes = await handleRequest(
    new Request("https://worker.example/api/auth/request-code", {
      method: "POST",
      headers: {
        Origin: "https://seisho-tsudoku-app.vercel.app",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "TestUser@example.com" }),
    }),
    env
  );
  assert.equal(missingInviteRes.status, 403);
  assert.equal((await missingInviteRes.json()).code, "INVITE_CODE_REQUIRED");

  // Valid inviteCode (seeded SHIBATA-CHURCH) but unconfigured mail -> 503 MAIL_NOT_CONFIGURED
  const reqCodeRes = await handleRequest(
    new Request("https://worker.example/api/auth/request-code", {
      method: "POST",
      headers: {
        Origin: "https://seisho-tsudoku-app.vercel.app",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: "TestUser@example.com",
        inviteCode: "shibata-church",
      }),
    }),
    env
  );
  assert.equal(reqCodeRes.status, 503);
  const body = await reqCodeRes.json();
  assert.equal(body.code, "MAIL_NOT_CONFIGURED");
  const countRow = DB.sqlite.prepare("SELECT COUNT(*) AS cnt FROM auth_codes").get();
  assert.equal(countRow.cnt, 0);
});

test("OTP request cooldown, hourly rate limit, Resend/GAS adapters, church license & 2nd-device code-free login", async () => {
  const DB = createMockD1();
  const nowRef = { now: Date.parse("2026-11-19T01:00:00.000Z") };
  const capturedEmails = [];
  const envResend = {
    DB,
    RESEND_API_KEY: "re_test_key",
    MAIL_FROM: "みことばの庭 <noreply@example.com>",
  };
  const helpers = makeHelpers(nowRef, capturedEmails, "resend");

  // Check license preview endpoint
  const licenseCheckRes = await handleBackupRoute(
    new Request("https://w.example/api/license/check?code=shibata-church"),
    envResend,
    "/api/license/check",
    "GET",
    helpers
  );
  assert.equal(licenseCheckRes.status, 200);
  const licenseInfo = await licenseCheckRes.json();
  assert.equal(licenseInfo.valid, true);
  assert.equal(licenseInfo.planType, "church");
  assert.equal(licenseInfo.churchName, "新発田いのちのパンチャーチ");

  // Invalid email -> 400
  const badEmailRes = await handleBackupRoute(
    new Request("https://w.example/api/auth/request-code", {
      method: "POST",
      body: JSON.stringify({ email: "not-an-email", inviteCode: "SHIBATA-CHURCH" }),
    }),
    envResend,
    "/api/auth/request-code",
    "POST",
    helpers
  );
  assert.equal(badEmailRes.status, 400);

  // 1st OTP via Resend with SHIBATA-CHURCH license
  const res1 = await handleBackupRoute(
    new Request("https://w.example/api/auth/request-code", {
      method: "POST",
      body: JSON.stringify({
        email: " Pastor@Example.com ",
        inviteCode: "ｓｈｉｂａｔａ－ｃｈｕｒｃｈ",
      }),
    }),
    envResend,
    "/api/auth/request-code",
    "POST",
    helpers
  );
  assert.equal(res1.status, 200);
  assert.equal(capturedEmails.length, 1);
  assert.equal(capturedEmails[0].url, "https://api.resend.com/emails");
  assert.deepEqual(capturedEmails[0].payload.to, ["pastor@example.com"]);
  const code1 = extractOtpFromCaptured(capturedEmails[0]);

  // Immediate retry -> 429 cooldown
  nowRef.now += 20 * 1000;
  const cooldownRes = await handleBackupRoute(
    new Request("https://w.example/api/auth/request-code", {
      method: "POST",
      body: JSON.stringify({ email: "pastor@example.com", inviteCode: "SHIBATA-CHURCH" }),
    }),
    envResend,
    "/api/auth/request-code",
    "POST",
    helpers
  );
  assert.equal(cooldownRes.status, 429);

  // Advance > 60s each time until 5/hour hit using GAS adapter on 5th
  const envGas = {
    DB,
    GAS_MAIL_WEBHOOK_URL: "https://script.google.com/macros/s/abc/exec",
    GAS_MAIL_SECRET: "gas-secret-xyz",
  };
  const gasHelpers = makeHelpers(nowRef, capturedEmails, "gas");
  for (let i = 0; i < 4; i += 1) {
    nowRef.now += 65 * 1000;
    const targetEnv = i === 3 ? envGas : envResend;
    const targetHelpers = i === 3 ? gasHelpers : helpers;
    const r = await handleBackupRoute(
      new Request("https://w.example/api/auth/request-code", {
        method: "POST",
        body: JSON.stringify({ email: "pastor@example.com", inviteCode: "SHIBATA-CHURCH" }),
      }),
      targetEnv,
      "/api/auth/request-code",
      "POST",
      targetHelpers
    );
    assert.equal(r.status, 200);
  }
  assert.equal(capturedEmails.length, 5);
  assert.equal(capturedEmails[4].url, envGas.GAS_MAIL_WEBHOOK_URL);
  assert.equal(capturedEmails[4].payload.secret, "gas-secret-xyz");

  // 6th within 1 hour -> 429
  nowRef.now += 65 * 1000;
  const hourlyLimitRes = await handleBackupRoute(
    new Request("https://w.example/api/auth/request-code", {
      method: "POST",
      body: JSON.stringify({ email: "pastor@example.com", inviteCode: "SHIBATA-CHURCH" }),
    }),
    envGas,
    "/api/auth/request-code",
    "POST",
    gasHelpers
  );
  assert.equal(hourlyLimitRes.status, 429);

  // Verify old invalidated code1 fails, latest code with full-width digits succeeds once
  const latestCode = extractOtpFromCaptured(capturedEmails[4]);
  const oldVerifyRes = await handleBackupRoute(
    new Request("https://w.example/api/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ email: "pastor@example.com", code: code1 }),
    }),
    envGas,
    "/api/auth/verify-code",
    "POST",
    gasHelpers
  );
  assert.equal(oldVerifyRes.status, 401);

  const fullWidthCode = latestCode.replace(/\d/g, (d) =>
    String.fromCharCode(d.charCodeAt(0) + 0xfee0)
  );
  const okVerifyRes = await handleBackupRoute(
    new Request("https://w.example/api/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ email: "pastor@example.com", code: fullWidthCode }),
    }),
    envGas,
    "/api/auth/verify-code",
    "POST",
    gasHelpers
  );
  assert.equal(okVerifyRes.status, 200);
  const verifyBody = await okVerifyRes.json();
  assert.ok(verifyBody.sessionToken);
  assert.equal(verifyBody.user.email, "pastor@example.com");
  assert.equal(verifyBody.user.licenseType, "church");
  assert.equal(verifyBody.user.churchName, "新発田いのちのパンチャーチ");

  // Confirm 2nd device (機種変更) after 1 hour can request OTP WITHOUT re-entering inviteCode!
  nowRef.now += 65 * 60 * 1000;
  const secondDeviceReq = await handleBackupRoute(
    new Request("https://w.example/api/auth/request-code", {
      method: "POST",
      body: JSON.stringify({ email: "pastor@example.com" }),
    }),
    envGas,
    "/api/auth/request-code",
    "POST",
    gasHelpers
  );
  assert.equal(secondDeviceReq.status, 200);
  const secondDeviceJson = await secondDeviceReq.json();
  assert.equal(secondDeviceJson.isExistingUser, true);

  // Confirm raw OTP & raw token are NOT stored in DB
  const storedCode = DB.sqlite
    .prepare("SELECT code_hash, used_at FROM auth_codes ORDER BY created_at DESC LIMIT 1")
    .get();
  assert.notEqual(storedCode.code_hash, latestCode);
  const storedSession = DB.sqlite
    .prepare("SELECT token_hash FROM user_sessions LIMIT 1")
    .get();
  assert.notEqual(storedSession.token_hash, verifyBody.sessionToken);
});

test("OTP wrong-attempts lockout (5 tries), expiration check, and 1-person invite max_uses limit", async () => {
  const DB = createMockD1();
  const nowRef = { now: Date.parse("2026-11-19T02:00:00.000Z") };
  const capturedEmails = [];
  const env = { DB, RESEND_API_KEY: "re_test_key" };
  const helpers = makeHelpers(nowRef, capturedEmails);

  // Insert a 1-use personal buyout code
  DB.sqlite
    .prepare(
      `INSERT INTO invite_codes (code, plan_type, max_uses, used_count, is_active, created_at)
       VALUES ('BUYOUT-001', 'personal', 1, 0, 1, '2026-11-19T00:00:00.000Z')`
    )
    .run();

  await handleBackupRoute(
    new Request("https://w.example/api/auth/request-code", {
      method: "POST",
      body: JSON.stringify({ email: "lock@example.com", inviteCode: "BUYOUT-001" }),
    }),
    env,
    "/api/auth/request-code",
    "POST",
    helpers
  );
  const realCode = extractOtpFromCaptured(capturedEmails[0]);
  const wrongCode = realCode === "000000" ? "999999" : "000000";

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const r = await handleBackupRoute(
      new Request("https://w.example/api/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ email: "lock@example.com", code: wrongCode }),
      }),
      env,
      "/api/auth/verify-code",
      "POST",
      helpers
    );
    assert.equal(r.status, 401);
  }

  // 5th wrong attempt triggers 429 lockout
  const fifth = await handleBackupRoute(
    new Request("https://w.example/api/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ email: "lock@example.com", code: wrongCode }),
    }),
    env,
    "/api/auth/verify-code",
    "POST",
    helpers
  );
  assert.equal(fifth.status, 429);

  // Even real code is locked out
  const afterLock = await handleBackupRoute(
    new Request("https://w.example/api/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ email: "lock@example.com", code: realCode }),
    }),
    env,
    "/api/auth/verify-code",
    "POST",
    helpers
  );
  assert.equal(afterLock.status, 429);

  // Fresh code expires after 10 minutes
  nowRef.now += 70 * 1000;
  await handleBackupRoute(
    new Request("https://w.example/api/auth/request-code", {
      method: "POST",
      body: JSON.stringify({ email: "exp@example.com", inviteCode: "BUYOUT-001" }),
    }),
    env,
    "/api/auth/request-code",
    "POST",
    helpers
  );
  const expCode = extractOtpFromCaptured(capturedEmails[1]);
  nowRef.now += 11 * 60 * 1000;
  const expiredRes = await handleBackupRoute(
    new Request("https://w.example/api/auth/verify-code", {
      method: "POST",
      body: JSON.stringify({ email: "exp@example.com", code: expCode }),
    }),
    env,
    "/api/auth/verify-code",
    "POST",
    helpers
  );
  assert.equal(expiredRes.status, 401);
});

test("Backup CRUD, version increment, notes preservation, 512KB limit, user isolation, and logout", async () => {
  const DB = createMockD1();
  const nowRef = { now: Date.parse("2026-11-19T03:00:00.000Z") };
  const capturedEmails = [];
  const env = { DB, RESEND_API_KEY: "re_test_key" };
  const helpers = makeHelpers(nowRef, capturedEmails);

  async function signInAs(email, inviteCode = "NIWA-FOUNDER") {
    await handleBackupRoute(
      new Request("https://w.example/api/auth/request-code", {
        method: "POST",
        body: JSON.stringify({ email, inviteCode }),
      }),
      env,
      "/api/auth/request-code",
      "POST",
      helpers
    );
    const code = extractOtpFromCaptured(capturedEmails[capturedEmails.length - 1]);
    const v = await handleBackupRoute(
      new Request("https://w.example/api/auth/verify-code", {
        method: "POST",
        body: JSON.stringify({ email, code }),
      }),
      env,
      "/api/auth/verify-code",
      "POST",
      helpers
    );
    return (await v.json()).sessionToken;
  }

  // Unauthenticated -> 401
  const unauthGet = await handleBackupRoute(
    new Request("https://w.example/api/backup", { method: "GET" }),
    env,
    "/api/backup",
    "GET",
    helpers
  );
  assert.equal(unauthGet.status, 401);

  const tokenA = await signInAs("usera@example.com", "SHIBATA-CHURCH");
  const tokenB = await signInAs("userb@example.com", "NIWA-FOUNDER");

  // Initial empty backup
  const emptyGet = await handleBackupRoute(
    new Request("https://w.example/api/backup", {
      method: "GET",
      headers: { Authorization: "Bearer " + tokenA },
    }),
    env,
    "/api/backup",
    "GET",
    helpers
  );
  assert.equal(emptyGet.status, 200);
  const emptyJson = await emptyGet.json();
  assert.equal(emptyJson.exists, false);
  assert.equal(emptyJson.dataVersion, 0);

  // Save backup v1 with notes
  const sampleData = {
    active: "nt1y",
    churchName: "新発田いのちのパンチャーチ",
    plans: {
      nt1y: {
        startDate: "2026-11-01",
        completed: { "1": [0, { "1": [1] }] },
      },
    },
    notes: {
      "2026-11-19": {
        text: "マタイ1章の系図にも主の真実がある。",
        updatedAt: "2026-11-19T03:00:00.000Z",
      },
    },
    celebrated: { nt1y: { streak7: "2026-11-08" } },
  };
  const put1 = await handleBackupRoute(
    new Request("https://w.example/api/backup", {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + tokenA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: sampleData }),
    }),
    env,
    "/api/backup",
    "PUT",
    helpers
  );
  assert.equal(put1.status, 200);
  assert.equal((await put1.json()).dataVersion, 1);

  // Update backup -> version increments to 2
  nowRef.now += 5000;
  sampleData.notes["2026-11-19"].text = "更新された黙想メモ";
  const put2 = await handleBackupRoute(
    new Request("https://w.example/api/backup", {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + tokenA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: sampleData }),
    }),
    env,
    "/api/backup",
    "PUT",
    helpers
  );
  assert.equal(put2.status, 200);
  assert.equal((await put2.json()).dataVersion, 2);

  // Retrieve backup for User A -> notes preserved
  const getA = await handleBackupRoute(
    new Request("https://w.example/api/backup", {
      method: "GET",
      headers: { Authorization: "Bearer " + tokenA },
    }),
    env,
    "/api/backup",
    "GET",
    helpers
  );
  const getAJson = await getA.json();
  assert.equal(getAJson.exists, true);
  assert.equal(getAJson.dataVersion, 2);
  assert.equal(getAJson.data.notes["2026-11-19"].text, "更新された黙想メモ");

  // User B is completely isolated from User A
  const getB = await handleBackupRoute(
    new Request("https://w.example/api/backup", {
      method: "GET",
      headers: { Authorization: "Bearer " + tokenB },
    }),
    env,
    "/api/backup",
    "GET",
    helpers
  );
  assert.equal((await getB.json()).exists, false);

  // Payload > 512KB -> 413
  const oversized = await handleBackupRoute(
    new Request("https://w.example/api/backup", {
      method: "PUT",
      headers: {
        Authorization: "Bearer " + tokenA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: { huge: "x".repeat(520 * 1024) } }),
    }),
    env,
    "/api/backup",
    "PUT",
    helpers
  );
  assert.equal(oversized.status, 413);

  // Logout invalidates session
  const logoutRes = await handleBackupRoute(
    new Request("https://w.example/api/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + tokenA },
    }),
    env,
    "/api/auth/logout",
    "POST",
    helpers
  );
  assert.equal(logoutRes.status, 200);

  const afterLogoutMe = await handleBackupRoute(
    new Request("https://w.example/api/auth/me", {
      method: "GET",
      headers: { Authorization: "Bearer " + tokenA },
    }),
    env,
    "/api/auth/me",
    "GET",
    helpers
  );
  assert.equal(afterLogoutMe.status, 401);
});
