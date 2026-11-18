import { DEFAULT_TIMEZONE } from "./lib/time.js";
import {
  DEFAULT_SLOTS,
  SAFETY_MAX_SLOTS_PER_DEVICE,
  serializeSlot,
  sortSlotsByTime,
  validateCreateSlot,
  validateRegisterPayload,
  validateUpdateSlot,
} from "./lib/validation.js";
import {
  deriveVapidPublicKey,
  generateRandomToken,
  sha256Hex,
} from "./lib/crypto.js";
import { buildTestNotificationPayload, sendWebPush } from "./lib/push.js";
import { runScheduledNotifications } from "./lib/scheduler.js";

function isAllowedOrigin(origin, env) {
  if (!origin) return false;
  const configured = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.includes(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isAllowedOrigin(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function jsonResponse(request, env, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(request, env),
    },
  });
}

function extractBearerToken(request) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

async function authenticateDevice(request, env) {
  const token = extractBearerToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const device = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth, timezone, created_at, updated_at
     FROM devices
     WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first();
  return device || null;
}

async function fetchDeviceSlots(env, deviceId) {
  const res = await env.DB.prepare(
    `SELECT id, name, time_hhmm, enabled, created_at, updated_at
     FROM notification_slots
     WHERE device_id = ?
     ORDER BY time_hhmm ASC, created_at ASC, id ASC`
  )
    .bind(deviceId)
    .all();
  return sortSlotsByTime((res.results || []).map(serializeSlot));
}

async function readJsonBody(request) {
  try {
    return { ok: true, data: await request.json() };
  } catch {
    return { ok: false, error: "JSON形式のリクエストボディが必要です。" };
  }
}

export async function handleRequest(request, env, { fetchImpl = fetch } = {}) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request, env),
    });
  }

  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  try {
    // 1. ヘルスチェック
    if (method === "GET" && pathname === "/api/health") {
      return jsonResponse(request, env, {
        ok: true,
        service: "seisho-tsudoku-notifications",
        defaultTimezone: env.DEFAULT_TIMEZONE || DEFAULT_TIMEZONE,
      });
    }

    // 2. VAPID公開鍵取得
    if (method === "GET" && pathname === "/api/vapid-public-key") {
      const publicKey = env.VAPID_PUBLIC_KEY
        ? env.VAPID_PUBLIC_KEY.trim()
        : deriveVapidPublicKey(env.VAPID_PRIVATE_KEY);
      return jsonResponse(request, env, { publicKey });
    }

    // 3. 端末（iPhone）Push購読登録・更新
    if (method === "POST" && pathname === "/api/devices/register") {
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return jsonResponse(request, env, { error: parsed.error }, 400);

      const validated = validateRegisterPayload(parsed.data, env.DEFAULT_TIMEZONE || DEFAULT_TIMEZONE);
      if (!validated.ok) return jsonResponse(request, env, { error: validated.error }, 400);

      const { subscription, timezone } = validated.value;
      const nowIso = new Date().toISOString();

      // すでに認証済み端末からの購読更新か確認
      const authedDevice = await authenticateDevice(request, env);
      if (authedDevice) {
        // 別のレコードが同じendpointを持っていた場合は古い重複レコードを除去
        const dup = await env.DB.prepare(
          `SELECT id FROM devices WHERE endpoint = ? AND id != ?`
        )
          .bind(subscription.endpoint, authedDevice.id)
          .first();
        if (dup) {
          await env.DB.batch([
            env.DB.prepare(`DELETE FROM notification_logs WHERE device_id = ?`).bind(dup.id),
            env.DB.prepare(`DELETE FROM notification_slots WHERE device_id = ?`).bind(dup.id),
            env.DB.prepare(`DELETE FROM devices WHERE id = ?`).bind(dup.id),
          ]);
        }

        await env.DB.prepare(
          `UPDATE devices
           SET endpoint = ?, p256dh = ?, auth = ?, timezone = ?, updated_at = ?
           WHERE id = ?`
        )
          .bind(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, timezone, nowIso, authedDevice.id)
          .run();

        const slots = await fetchDeviceSlots(env, authedDevice.id);
        return jsonResponse(request, env, {
          deviceId: authedDevice.id,
          timezone,
          slots,
          isNew: false,
        });
      }

      // 同じendpointが既に登録済み（キャッシュ消去後の再登録など）なら既存設定を引き継ぐ
      const existingByEndpoint = await env.DB.prepare(
        `SELECT id FROM devices WHERE endpoint = ?`
      )
        .bind(subscription.endpoint)
        .first();

      if (existingByEndpoint) {
        const newToken = generateRandomToken(32);
        const newTokenHash = await sha256Hex(newToken);
        await env.DB.prepare(
          `UPDATE devices
           SET token_hash = ?, p256dh = ?, auth = ?, timezone = ?, updated_at = ?
           WHERE id = ?`
        )
          .bind(newTokenHash, subscription.keys.p256dh, subscription.keys.auth, timezone, nowIso, existingByEndpoint.id)
          .run();

        const slots = await fetchDeviceSlots(env, existingByEndpoint.id);
        return jsonResponse(request, env, {
          deviceId: existingByEndpoint.id,
          authToken: newToken,
          timezone,
          slots,
          isNew: false,
        });
      }

      // 完全新規登録：初期設定の3枠（朝07:00・昼12:00・夜21:00）を自動作成
      const deviceId = crypto.randomUUID();
      const authToken = generateRandomToken(32);
      const tokenHash = await sha256Hex(authToken);

      const statements = [
        env.DB.prepare(
          `INSERT INTO devices (id, token_hash, endpoint, p256dh, auth, timezone, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          deviceId,
          tokenHash,
          subscription.endpoint,
          subscription.keys.p256dh,
          subscription.keys.auth,
          timezone,
          nowIso,
          nowIso
        ),
      ];

      for (const def of DEFAULT_SLOTS) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO notification_slots (id, device_id, name, time_hhmm, enabled, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            crypto.randomUUID(),
            deviceId,
            def.name,
            def.time_hhmm,
            def.enabled ? 1 : 0,
            nowIso,
            nowIso
          )
        );
      }

      await env.DB.batch(statements);
      const slots = await fetchDeviceSlots(env, deviceId);

      return jsonResponse(
        request,
        env,
        {
          deviceId,
          authToken,
          timezone,
          slots,
          isNew: true,
        },
        201
      );
    }

    // 以下はすべて端末認証が必須
    const device = await authenticateDevice(request, env);
    if (!device) {
      return jsonResponse(request, env, { error: "認証情報が無効です。通知設定を再登録してください。" }, 401);
    }

    // 4. 端末登録解除（通知を完全にOFF）
    if (method === "DELETE" && pathname === "/api/devices/me") {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM notification_logs WHERE device_id = ?`).bind(device.id),
        env.DB.prepare(`DELETE FROM notification_slots WHERE device_id = ?`).bind(device.id),
        env.DB.prepare(`DELETE FROM devices WHERE id = ?`).bind(device.id),
      ]);
      return jsonResponse(request, env, { ok: true });
    }

    // 5. 通知枠一覧取得（時刻順）
    if (method === "GET" && pathname === "/api/slots") {
      const slots = await fetchDeviceSlots(env, device.id);
      return jsonResponse(request, env, {
        deviceId: device.id,
        timezone: device.timezone,
        slots,
      });
    }

    // 6. 通知枠の追加（固定上限なし・自由追加）
    if (method === "POST" && pathname === "/api/slots") {
      const parsed = await readJsonBody(request);
      if (!parsed.ok) return jsonResponse(request, env, { error: parsed.error }, 400);

      const validated = validateCreateSlot(parsed.data);
      if (!validated.ok) return jsonResponse(request, env, { error: validated.error }, 400);

      const countRow = await env.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM notification_slots WHERE device_id = ?`
      )
        .bind(device.id)
        .first();
      if (countRow && Number(countRow.cnt) >= SAFETY_MAX_SLOTS_PER_DEVICE) {
        return jsonResponse(request, env, { error: `通知枠は最大${SAFETY_MAX_SLOTS_PER_DEVICE}件まで登録できます。` }, 400);
      }

      const slotId = crypto.randomUUID();
      const nowIso = new Date().toISOString();
      const { name, time_hhmm, enabled } = validated.value;

      await env.DB.prepare(
        `INSERT INTO notification_slots (id, device_id, name, time_hhmm, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(slotId, device.id, name, time_hhmm, enabled ? 1 : 0, nowIso, nowIso)
        .run();

      const slots = await fetchDeviceSlots(env, device.id);
      const created = slots.find((s) => s.id === slotId) || null;
      return jsonResponse(request, env, { slot: created, slots }, 201);
    }

    // 7. 通知枠の更新・削除 (/api/slots/:id)
    const slotMatch = /^\/api\/slots\/([^/]+)$/.exec(pathname);
    if (slotMatch) {
      const slotId = decodeURIComponent(slotMatch[1]);
      const existing = await env.DB.prepare(
        `SELECT id, name, time_hhmm, enabled, created_at, updated_at
         FROM notification_slots
         WHERE id = ? AND device_id = ?`
      )
        .bind(slotId, device.id)
        .first();

      if (!existing) {
        return jsonResponse(request, env, { error: "指定された通知枠が見つかりません。" }, 404);
      }

      if (method === "PATCH") {
        const parsed = await readJsonBody(request);
        if (!parsed.ok) return jsonResponse(request, env, { error: parsed.error }, 400);

        const validated = validateUpdateSlot(parsed.data);
        if (!validated.ok) return jsonResponse(request, env, { error: validated.error }, 400);

        const nextName = validated.value.name !== undefined ? validated.value.name : existing.name;
        const nextTime = validated.value.time_hhmm !== undefined ? validated.value.time_hhmm : existing.time_hhmm;
        const nextEnabled = validated.value.enabled !== undefined ? (validated.value.enabled ? 1 : 0) : existing.enabled;
        const nowIso = new Date().toISOString();

        await env.DB.prepare(
          `UPDATE notification_slots
           SET name = ?, time_hhmm = ?, enabled = ?, updated_at = ?
           WHERE id = ? AND device_id = ?`
        )
          .bind(nextName, nextTime, nextEnabled, nowIso, slotId, device.id)
          .run();

        const slots = await fetchDeviceSlots(env, device.id);
        const updated = slots.find((s) => s.id === slotId) || null;
        return jsonResponse(request, env, { slot: updated, slots });
      }

      if (method === "DELETE") {
        // 削除対象の通知枠と、その枠に紐づく送信履歴だけを正確に削除（他枠には一切影響させない）
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM notification_logs WHERE slot_id = ? AND device_id = ?`).bind(slotId, device.id),
          env.DB.prepare(`DELETE FROM notification_slots WHERE id = ? AND device_id = ?`).bind(slotId, device.id),
        ]);

        const slots = await fetchDeviceSlots(env, device.id);
        return jsonResponse(request, env, { ok: true, deletedId: slotId, slots });
      }
    }

    // 8. テスト通知の即時送信
    if (method === "POST" && pathname === "/api/test-push") {
      const appUrl = env.APP_URL || "https://seisho-tsudoku-app.vercel.app/";
      const payload = buildTestNotificationPayload(appUrl);
      const result = await sendWebPush({
        env,
        device,
        payload,
        ttl: 300,
        urgency: "high",
        fetchImpl,
      });

      if (result.ok) {
        return jsonResponse(request, env, { ok: true, statusCode: result.statusCode });
      }
      if (result.gone) {
        return jsonResponse(
          request,
          env,
          { ok: false, gone: true, error: "通知の購読期限が切れています。一度通知をオフにして再登録してください。" },
          410
        );
      }
      return jsonResponse(
        request,
        env,
        { ok: false, statusCode: result.statusCode, error: result.errorMessage || "テスト通知の送信に失敗しました。" },
        502
      );
    }

    return jsonResponse(request, env, { error: "Not Found" }, 404);
  } catch (err) {
    console.error("Worker error:", err);
    return jsonResponse(
      request,
      env,
      { error: "サーバー内部でエラーが発生しました。" },
      500
    );
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },

  async scheduled(controller, env, ctx) {
    const nowDate = controller && controller.scheduledTime ? new Date(controller.scheduledTime) : new Date();
    ctx.waitUntil(
      runScheduledNotifications(env, nowDate).then((summary) => {
        console.log("Scheduled notifications summary:", JSON.stringify(summary));
      })
    );
  },
};
