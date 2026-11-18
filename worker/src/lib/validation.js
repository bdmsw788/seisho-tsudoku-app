import { isValidTimeHHMM, normalizeTimeZone, DEFAULT_TIMEZONE } from "./time.js";

export const DEFAULT_SLOTS = [
  { name: "朝", time_hhmm: "07:00", enabled: true },
  { name: "昼", time_hhmm: "12:00", enabled: true },
  { name: "夜", time_hhmm: "21:00", enabled: true },
];

export const DEFAULT_NEW_SLOT_NAME = "追加通知";
export const MAX_SLOT_NAME_LENGTH = 30;
// 固定上限（3件・6件等）は設けず自由に増減可能とする（異常な大量リクエスト防止の安全弁のみ）
export const SAFETY_MAX_SLOTS_PER_DEVICE = 100;

export function sortSlotsByTime(slots) {
  return [...slots].sort((a, b) => {
    const tCmp = String(a.time_hhmm).localeCompare(String(b.time_hhmm));
    if (tCmp !== 0) return tCmp;
    const cCmp = String(a.created_at || "").localeCompare(String(b.created_at || ""));
    if (cCmp !== 0) return cCmp;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
}

export function serializeSlot(row) {
  return {
    id: row.id,
    name: row.name,
    time_hhmm: row.time_hhmm,
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function validateSubscription(sub) {
  if (!sub || typeof sub !== "object") {
    return { ok: false, error: "購読情報（subscription）が不正です。" };
  }
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint.trim() : "";
  if (!endpoint.startsWith("https://")) {
    return { ok: false, error: "有効なHTTPSのPushエンドポイントが必要です。" };
  }
  try {
    new URL(endpoint);
  } catch {
    return { ok: false, error: "PushエンドポイントのURL形式が不正です。" };
  }

  const keys = sub.keys && typeof sub.keys === "object" ? sub.keys : {};
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys.auth === "string" ? keys.auth.trim() : "";
  if (!p256dh || !auth) {
    return { ok: false, error: "Push暗号化キー（p256dh, auth）が不足しています。" };
  }

  return {
    ok: true,
    value: {
      endpoint,
      keys: { p256dh, auth },
    },
  };
}

export function validateCreateSlot(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "リクエスト形式が不正です。" };
  }
  const rawName = body.name === undefined || body.name === null ? DEFAULT_NEW_SLOT_NAME : String(body.name);
  const name = rawName.trim() || DEFAULT_NEW_SLOT_NAME;
  if (name.length > MAX_SLOT_NAME_LENGTH) {
    return { ok: false, error: `通知名は${MAX_SLOT_NAME_LENGTH}文字以内で入力してください。` };
  }

  const time = typeof body.time_hhmm === "string" ? body.time_hhmm.trim() : "";
  if (!isValidTimeHHMM(time)) {
    return { ok: false, error: "時刻は HH:mm 形式（00:00〜23:59）で指定してください。" };
  }

  const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
  return {
    ok: true,
    value: { name, time_hhmm: time, enabled },
  };
}

export function validateUpdateSlot(body) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "リクエスト形式が不正です。" };
  }
  const patch = {};

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      return { ok: false, error: "通知名を入力してください。" };
    }
    if (name.length > MAX_SLOT_NAME_LENGTH) {
      return { ok: false, error: `通知名は${MAX_SLOT_NAME_LENGTH}文字以内で入力してください。` };
    }
    patch.name = name;
  }

  if (body.time_hhmm !== undefined) {
    const time = String(body.time_hhmm).trim();
    if (!isValidTimeHHMM(time)) {
      return { ok: false, error: "時刻は HH:mm 形式（00:00〜23:59）で指定してください。" };
    }
    patch.time_hhmm = time;
  }

  if (body.enabled !== undefined) {
    patch.enabled = Boolean(body.enabled);
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "更新項目が指定されていません。" };
  }

  return { ok: true, value: patch };
}

export function validateRegisterPayload(body, defaultTz = DEFAULT_TIMEZONE) {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "リクエスト形式が不正です。" };
  }
  const subCheck = validateSubscription(body.subscription);
  if (!subCheck.ok) return subCheck;

  const timezone = normalizeTimeZone(body.timezone, defaultTz);
  return {
    ok: true,
    value: {
      subscription: subCheck.value,
      timezone,
    },
  };
}
