import { generateRandomToken, sha256Hex } from "./crypto.js";
import { sendOtpEmail } from "./mailer.js";

const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_HOURLY_LIMIT = 5;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;
export const MAX_BACKUP_BYTES = 512 * 1024;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(raw) {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase();
}

export function isValidEmail(email) {
  return Boolean(email && email.length <= 254 && EMAIL_RE.test(email));
}

export function normalizeInviteCode(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[Ａ-Ｚａ-ｚ０-９－＿]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    )
    .trim()
    .toUpperCase();
}

function normalizeOtpCode(raw) {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  const fullWidthConverted = String(raw)
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, "");
  return /^\d{6}$/.test(fullWidthConverted) ? fullWidthConverted : "";
}

function generateSixDigitOtp() {
  const limit = Math.floor(0x100000000 / 1000000) * 1000000;
  const buf = new Uint32Array(1);
  let val = 0;
  do {
    crypto.getRandomValues(buf);
    val = buf[0];
  } while (val >= limit);
  return String(val % 1000000).padStart(6, "0");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function unwrapJsonBody(request, readJsonBody) {
  const res = await readJsonBody(request);
  if (!res) return null;
  if (typeof res === "object" && "ok" in res && ("data" in res || "error" in res)) {
    return res.ok ? res.data : null;
  }
  return res;
}

function isLicenseExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const ts = Date.parse(expiresAt);
  return Number.isFinite(ts) && ts <= now;
}

async function validateInviteCodeRow(env, rawCode, now, existingUserLicenseCode = null) {
  const code = normalizeInviteCode(rawCode);
  if (!code) {
    return {
      ok: false,
      code: "INVITE_CODE_REQUIRED",
      error: "初回のクラウドバックアップ登録には「解放コード（または教会コード）」が必要です。",
    };
  }

  const row = await env.DB.prepare(
    `SELECT code, plan_type, church_name, max_uses, used_count, expires_at, is_active
     FROM invite_codes
     WHERE code = ?
     LIMIT 1`
  )
    .bind(code)
    .first();

  if (!row || !Number(row.is_active)) {
    return {
      ok: false,
      code: "INVITE_CODE_INVALID",
      error: "入力された解放コードが見つからないか、無効になっています。",
    };
  }

  if (isLicenseExpired(row.expires_at, now)) {
    return {
      ok: false,
      code: "INVITE_CODE_EXPIRED",
      error: "この解放コード（教会ライセンス）は有効期限が切れています。",
    };
  }

  const alreadyHoldingSameCode =
    existingUserLicenseCode && existingUserLicenseCode === row.code;

  if (
    !alreadyHoldingSameCode &&
    Number(row.used_count || 0) >= Number(row.max_uses || 1)
  ) {
    return {
      ok: false,
      code: "INVITE_CODE_EXHAUSTED",
      error: "この解放コードは利用可能な上限人数に達しています。",
    };
  }

  return {
    ok: true,
    invite: {
      code: row.code,
      planType: row.plan_type || "personal",
      churchName: row.church_name || null,
      maxUses: Number(row.max_uses || 1),
      usedCount: Number(row.used_count || 0),
      expiresAt: row.expires_at || null,
    },
  };
}

async function authenticateSession(request, env, extractBearerToken, nowMs) {
  const token = extractBearerToken(request);
  if (!token) return null;

  const tokenHash = await sha256Hex("session:" + token);
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.user_id, s.expires_at,
            u.email, u.license_code, u.license_type, u.church_name, u.license_expires_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?
     LIMIT 1`
  )
    .bind(tokenHash)
    .first();

  if (!row) return null;

  const now = nowMs();
  if (Date.parse(row.expires_at) <= now) {
    await env.DB.prepare("DELETE FROM user_sessions WHERE id = ?")
      .bind(row.session_id)
      .run();
    return null;
  }

  await env.DB.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?")
    .bind(new Date(now).toISOString(), row.session_id)
    .run();

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email,
    licenseCode: row.license_code || null,
    licenseType: row.license_type || null,
    churchName: row.church_name || null,
    licenseExpiresAt: row.license_expires_at || null,
    tokenHash,
  };
}

async function handleCheckLicense(request, env, helpers) {
  const { jsonResponse, nowMs } = helpers;
  const url = new URL(request.url);
  const rawCode = url.searchParams.get("code") || "";
  const check = await validateInviteCodeRow(env, rawCode, nowMs());
  if (!check.ok) {
    return jsonResponse(
      request,
      env,
      { valid: false, code: check.code, error: check.error },
      404
    );
  }
  return jsonResponse(request, env, {
    valid: true,
    planType: check.invite.planType,
    churchName: check.invite.churchName,
    expiresAt: check.invite.expiresAt,
  });
}

async function handleRequestCode(request, env, helpers) {
  const { jsonResponse, readJsonBody, fetchImpl, nowMs } = helpers;
  const body = await unwrapJsonBody(request, readJsonBody);
  if (!body) {
    return jsonResponse(request, env, { error: "JSONリクエストが必要です。" }, 400);
  }

  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) {
    return jsonResponse(
      request,
      env,
      { error: "正しいメールアドレスを入力してください。" },
      400
    );
  }

  const now = nowMs();

  // 既存ユーザーで有効なライセンスを保持しているか確認（機種変更時はコード再入力不要）
  const existingUser = await env.DB.prepare(
    `SELECT id, license_code, license_type, church_name, license_expires_at
     FROM users
     WHERE email = ?
     LIMIT 1`
  )
    .bind(email)
    .first();

  const rawInviteCode = normalizeInviteCode(body.inviteCode || "");
  const hasValidExistingLicense =
    existingUser &&
    existingUser.license_code &&
    !isLicenseExpired(existingUser.license_expires_at, now);

  const requireInvite = String(env.REQUIRE_INVITE_CODE || "true").toLowerCase() !== "false";
  let verifiedInviteCode = null;

  if (rawInviteCode) {
    const check = await validateInviteCodeRow(
      env,
      rawInviteCode,
      now,
      existingUser?.license_code || null
    );
    if (!check.ok) {
      return jsonResponse(
        request,
        env,
        { error: check.error, code: check.code },
        403
      );
    }
    verifiedInviteCode = check.invite.code;
  } else if (!hasValidExistingLicense && requireInvite) {
    return jsonResponse(
      request,
      env,
      {
        error:
          existingUser && isLicenseExpired(existingUser.license_expires_at, now)
            ? "ライセンスの有効期限が切れています。更新用の解放コードを入力してください。"
            : "初回のクラウド登録には「解放コード（または教会コード）」の入力が必要です。（機種変更の方は登録済みメールアドレスをご確認のうえ入力してください）",
        code: "INVITE_CODE_REQUIRED",
      },
      403
    );
  }

  const latest = await env.DB.prepare(
    "SELECT created_at FROM auth_codes WHERE email = ? ORDER BY created_at DESC LIMIT 1"
  )
    .bind(email)
    .first();

  if (latest) {
    const elapsedMs = now - Date.parse(latest.created_at);
    if (elapsedMs < OTP_COOLDOWN_MS) {
      const retryAfterSec = Math.max(1, Math.ceil((OTP_COOLDOWN_MS - elapsedMs) / 1000));
      return jsonResponse(
        request,
        env,
        {
          error: "連続送信を防ぐため、" + retryAfterSec + "秒ほど待ってからもう一度お試しください。",
          retryAfterSec,
        },
        429
      );
    }
  }

  const oneHourAgoIso = new Date(now - 60 * 60 * 1000).toISOString();
  const hourly = await env.DB.prepare(
    "SELECT COUNT(*) AS cnt FROM auth_codes WHERE email = ? AND created_at >= ?"
  )
    .bind(email, oneHourAgoIso)
    .first();

  if (Number(hourly?.cnt || 0) >= OTP_HOURLY_LIMIT) {
    return jsonResponse(
      request,
      env,
      { error: "認証コードの送信回数が上限に達しました。1時間ほど経ってから再度お試しください。" },
      429
    );
  }

  const code = generateSixDigitOtp();
  const codeHash = await sha256Hex("otp:" + email + ":" + code);
  const sendRes = await sendOtpEmail(env, { to: email, code, fetchImpl });

  if (!sendRes.ok) {
    const status = sendRes.code === "MAIL_NOT_CONFIGURED" ? 503 : 502;
    return jsonResponse(
      request,
      env,
      { error: sendRes.message, code: sendRes.code },
      status
    );
  }

  const nowIso = new Date(now).toISOString();
  const expiresAtIso = new Date(now + OTP_TTL_MS).toISOString();

  await env.DB.prepare(
    "UPDATE auth_codes SET used_at = ? WHERE email = ? AND used_at IS NULL"
  )
    .bind(nowIso, email)
    .run();

  await env.DB.prepare(
    `INSERT INTO auth_codes (id, email, code_hash, pending_invite_code, expires_at, attempts, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, 0, NULL, ?)`
  )
    .bind(crypto.randomUUID(), email, codeHash, verifiedInviteCode, expiresAtIso, nowIso)
    .run();

  return jsonResponse(request, env, {
    ok: true,
    email,
    isExistingUser: Boolean(existingUser),
    expiresInSec: OTP_TTL_MS / 1000,
    cooldownSec: OTP_COOLDOWN_MS / 1000,
  });
}

async function handleVerifyCode(request, env, helpers) {
  const { jsonResponse, readJsonBody, nowMs } = helpers;
  const body = await unwrapJsonBody(request, readJsonBody);
  if (!body) {
    return jsonResponse(request, env, { error: "JSONリクエストが必要です。" }, 400);
  }

  const email = normalizeEmail(body.email);
  const code = normalizeOtpCode(body.code);
  if (!isValidEmail(email) || !code) {
    return jsonResponse(
      request,
      env,
      { error: "メールアドレスと6桁の認証コードを入力してください。" },
      400
    );
  }

  const now = nowMs();
  const nowIso = new Date(now).toISOString();

  const record = await env.DB.prepare(
    `SELECT id, code_hash, pending_invite_code, expires_at, attempts, used_at
     FROM auth_codes
     WHERE email = ?
     ORDER BY created_at DESC
     LIMIT 1`
  )
    .bind(email)
    .first();

  if (!record || record.used_at) {
    return jsonResponse(
      request,
      env,
      { error: "有効な認証コードが見つかりません。コードを再送信してください。" },
      401
    );
  }

  if (Date.parse(record.expires_at) <= now) {
    return jsonResponse(
      request,
      env,
      { error: "認証コードの有効期限（10分）が切れています。コードを再送信してください。" },
      401
    );
  }

  const currentAttempts = Number(record.attempts || 0);
  if (currentAttempts >= OTP_MAX_ATTEMPTS) {
    return jsonResponse(
      request,
      env,
      { error: "入力ミスの回数が上限（5回）に達しました。コードを再送信してください。" },
      429
    );
  }

  const candidateHash = await sha256Hex("otp:" + email + ":" + code);
  if (!constantTimeEqual(candidateHash, record.code_hash)) {
    const nextAttempts = currentAttempts + 1;
    await env.DB.prepare("UPDATE auth_codes SET attempts = ? WHERE id = ?")
      .bind(nextAttempts, record.id)
      .run();

    if (nextAttempts >= OTP_MAX_ATTEMPTS) {
      return jsonResponse(
        request,
        env,
        { error: "認証コードが一致しません。試行上限（5回）に達したため、コードを再送信してください。" },
        429
      );
    }

    const remaining = OTP_MAX_ATTEMPTS - nextAttempts;
    return jsonResponse(
      request,
      env,
      { error: "認証コードが正しくありません（残り " + remaining + " 回）。" },
      401
    );
  }

  let existingUser = await env.DB.prepare(
    `SELECT id, email, license_code, license_type, church_name, license_expires_at
     FROM users
     WHERE email = ?
     LIMIT 1`
  )
    .bind(email)
    .first();

  const inviteCodeToApply =
    normalizeInviteCode(body.inviteCode || "") || record.pending_invite_code || null;

  let appliedLicense = {
    code: existingUser?.license_code || null,
    planType: existingUser?.license_type || null,
    churchName: existingUser?.church_name || null,
    expiresAt: existingUser?.license_expires_at || null,
  };

  if (inviteCodeToApply) {
    const check = await validateInviteCodeRow(
      env,
      inviteCodeToApply,
      now,
      existingUser?.license_code || null
    );
    if (!check.ok) {
      return jsonResponse(request, env, { error: check.error, code: check.code }, 403);
    }
    const isNewConsumption =
      !existingUser || existingUser.license_code !== check.invite.code;
    if (isNewConsumption) {
      const incRes = await env.DB.prepare(
        `UPDATE invite_codes
         SET used_count = used_count + 1
         WHERE code = ? AND is_active = 1 AND used_count < max_uses`
      )
        .bind(check.invite.code)
        .run();
      if (!incRes?.meta?.changes) {
        return jsonResponse(
          request,
          env,
          { error: "この解放コードは利用上限に達しました。", code: "INVITE_CODE_EXHAUSTED" },
          403
        );
      }
    }
    appliedLicense = {
      code: check.invite.code,
      planType: check.invite.planType,
      churchName: check.invite.churchName,
      expiresAt: check.invite.expiresAt,
    };
  }

  const consumeRes = await env.DB.prepare(
    "UPDATE auth_codes SET used_at = ? WHERE id = ? AND used_at IS NULL"
  )
    .bind(nowIso, record.id)
    .run();

  if (!consumeRes?.meta?.changes) {
    return jsonResponse(
      request,
      env,
      { error: "この認証コードはすでに使用されています。新しいコードを取得してください。" },
      401
    );
  }

  let userId;
  if (!existingUser) {
    userId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO users (id, email, license_code, license_type, church_name, license_expires_at, created_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        userId,
        email,
        appliedLicense.code,
        appliedLicense.planType,
        appliedLicense.churchName,
        appliedLicense.expiresAt,
        nowIso,
        nowIso
      )
      .run();
  } else {
    userId = existingUser.id;
    await env.DB.prepare(
      `UPDATE users
       SET license_code = ?, license_type = ?, church_name = ?, license_expires_at = ?, last_login_at = ?
       WHERE id = ?`
    )
      .bind(
        appliedLicense.code,
        appliedLicense.planType,
        appliedLicense.churchName,
        appliedLicense.expiresAt,
        nowIso,
        userId
      )
      .run();
  }

  const sessionToken = generateRandomToken(32);
  const tokenHash = await sha256Hex("session:" + sessionToken);
  const sessionExpiresAt = new Date(now + SESSION_TTL_MS).toISOString();

  await env.DB.prepare(
    `INSERT INTO user_sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(crypto.randomUUID(), userId, tokenHash, sessionExpiresAt, nowIso, nowIso)
    .run();

  const backupRow = await env.DB.prepare(
    "SELECT data_version, updated_at FROM user_backups WHERE user_id = ? LIMIT 1"
  )
    .bind(userId)
    .first();

  return jsonResponse(request, env, {
    ok: true,
    sessionToken,
    expiresAt: sessionExpiresAt,
    user: {
      id: userId,
      email,
      licenseCode: appliedLicense.code,
      licenseType: appliedLicense.planType,
      churchName: appliedLicense.churchName,
      licenseExpiresAt: appliedLicense.expiresAt,
    },
    hasBackup: Boolean(backupRow),
    dataVersion: backupRow ? Number(backupRow.data_version) : 0,
    backupUpdatedAt: backupRow ? backupRow.updated_at : null,
  });
}

async function handleGetMe(request, env, helpers) {
  const { jsonResponse, extractBearerToken, nowMs } = helpers;
  const auth = await authenticateSession(request, env, extractBearerToken, nowMs);
  if (!auth) {
    return jsonResponse(request, env, { error: "認証が必要です。" }, 401);
  }

  const backupRow = await env.DB.prepare(
    "SELECT data_version, updated_at FROM user_backups WHERE user_id = ? LIMIT 1"
  )
    .bind(auth.userId)
    .first();

  return jsonResponse(request, env, {
    user: {
      id: auth.userId,
      email: auth.email,
      licenseCode: auth.licenseCode,
      licenseType: auth.licenseType,
      churchName: auth.churchName,
      licenseExpiresAt: auth.licenseExpiresAt,
    },
    hasBackup: Boolean(backupRow),
    dataVersion: backupRow ? Number(backupRow.data_version) : 0,
    updatedAt: backupRow ? backupRow.updated_at : null,
  });
}

async function handleLogout(request, env, helpers) {
  const { jsonResponse, extractBearerToken } = helpers;
  const token = extractBearerToken(request);
  if (token) {
    const tokenHash = await sha256Hex("session:" + token);
    await env.DB.prepare("DELETE FROM user_sessions WHERE token_hash = ?")
      .bind(tokenHash)
      .run();
  }
  return jsonResponse(request, env, { ok: true });
}

async function handleGetBackup(request, env, helpers) {
  const { jsonResponse, extractBearerToken, nowMs } = helpers;
  const auth = await authenticateSession(request, env, extractBearerToken, nowMs);
  if (!auth) {
    return jsonResponse(request, env, { error: "認証が必要です。" }, 401);
  }

  const row = await env.DB.prepare(
    "SELECT payload_json, data_version, updated_at FROM user_backups WHERE user_id = ? LIMIT 1"
  )
    .bind(auth.userId)
    .first();

  if (!row) {
    return jsonResponse(request, env, {
      exists: false,
      data: null,
      dataVersion: 0,
      updatedAt: null,
    });
  }

  let parsedData = null;
  try {
    parsedData = JSON.parse(row.payload_json);
  } catch (err) {
    console.error("Corrupted backup JSON for user:", auth.userId, err);
    return jsonResponse(
      request,
      env,
      { error: "クラウド上のバックアップデータが破損しています。" },
      500
    );
  }

  return jsonResponse(request, env, {
    exists: true,
    data: parsedData,
    dataVersion: Number(row.data_version),
    updatedAt: row.updated_at,
  });
}

async function handlePutBackup(request, env, helpers) {
  const { jsonResponse, extractBearerToken, readJsonBody, nowMs } = helpers;
  const now = nowMs();
  const auth = await authenticateSession(request, env, extractBearerToken, nowMs);
  if (!auth) {
    return jsonResponse(request, env, { error: "認証が必要です。" }, 401);
  }

  if (isLicenseExpired(auth.licenseExpiresAt, now)) {
    return jsonResponse(
      request,
      env,
      {
        error: "ライセンスの有効期限が切れています。更新コードで再認証してください。（既存のバックアップ復元は引き続きご利用いただけます）",
        code: "LICENSE_EXPIRED",
      },
      403
    );
  }

  const body = await unwrapJsonBody(request, readJsonBody);
  if (
    !body ||
    !body.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data)
  ) {
    return jsonResponse(
      request,
      env,
      { error: "バックアップデータ形式が不正です。" },
      400
    );
  }

  const payloadJson = JSON.stringify(body.data);
  const byteLength = new TextEncoder().encode(payloadJson).byteLength;
  if (byteLength > MAX_BACKUP_BYTES) {
    return jsonResponse(
      request,
      env,
      { error: "バックアップデータの上限サイズ（512KB）を超えています。" },
      413
    );
  }

  const nowIso = new Date(now).toISOString();

  await env.DB.prepare(
    `INSERT INTO user_backups (user_id, payload_json, data_version, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       payload_json = excluded.payload_json,
       data_version = user_backups.data_version + 1,
       updated_at = excluded.updated_at`
  )
    .bind(auth.userId, payloadJson, nowIso)
    .run();

  const updated = await env.DB.prepare(
    "SELECT data_version, updated_at FROM user_backups WHERE user_id = ? LIMIT 1"
  )
    .bind(auth.userId)
    .first();

  return jsonResponse(request, env, {
    ok: true,
    dataVersion: Number(updated?.data_version || 1),
    updatedAt: updated?.updated_at || nowIso,
  });
}

export async function handleBackupRoute(request, env, pathname, method, helpers) {
  const normalizedHelpers = {
    fetchImpl: fetch,
    nowMs: () => Date.now(),
    ...helpers,
  };

  if (method === "GET" && pathname === "/api/license/check") {
    return handleCheckLicense(request, env, normalizedHelpers);
  }
  if (method === "POST" && pathname === "/api/auth/request-code") {
    return handleRequestCode(request, env, normalizedHelpers);
  }
  if (method === "POST" && pathname === "/api/auth/verify-code") {
    return handleVerifyCode(request, env, normalizedHelpers);
  }
  if (method === "GET" && pathname === "/api/auth/me") {
    return handleGetMe(request, env, normalizedHelpers);
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    return handleLogout(request, env, normalizedHelpers);
  }
  if (method === "GET" && pathname === "/api/backup") {
    return handleGetBackup(request, env, normalizedHelpers);
  }
  if (method === "PUT" && pathname === "/api/backup") {
    return handlePutBackup(request, env, normalizedHelpers);
  }

  return null;
}
