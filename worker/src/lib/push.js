import { buildPushHTTPRequest } from "@pushforge/builder";
import { parseVapidPrivateJwk } from "./crypto.js";

export function buildSlotNotificationPayload(slot, sentDate, appUrl) {
  return {
    title: "みことばの庭",
    body: `「${slot.name}」の聖書通読の時間です（${slot.time_hhmm}）`,
    tag: `mikotoba-${slot.id}-${sentDate}`,
    data: {
      url: appUrl || "/",
      slotId: slot.id,
      sentDate,
    },
  };
}

export function buildTestNotificationPayload(appUrl) {
  return {
    title: "みことばの庭（テスト通知）",
    body: "通知の受信を確認できました。設定した時刻にお知らせします。",
    tag: "mikotoba-test",
    data: {
      url: appUrl || "/",
      test: true,
    },
  };
}

export async function sendWebPush({
  env,
  device,
  payload,
  ttl = 3600,
  urgency = "normal",
  fetchImpl = fetch,
}) {
  const privateJWK = parseVapidPrivateJwk(env.VAPID_PRIVATE_KEY);
  const adminContact = env.VAPID_SUBJECT || "https://seisho-tsudoku-app.vercel.app";

  const subscription = {
    endpoint: device.endpoint,
    keys: {
      p256dh: device.p256dh,
      auth: device.auth,
    },
  };

  const { endpoint, headers, body } = await buildPushHTTPRequest({
    privateJWK,
    subscription,
    message: {
      payload,
      adminContact,
      options: {
        ttl,
        urgency,
      },
    },
  });

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body,
  });

  const statusCode = response.status;
  if (statusCode >= 200 && statusCode < 300) {
    return { ok: true, gone: false, statusCode, errorMessage: null };
  }

  let errorText = "";
  try {
    errorText = (await response.text()).slice(0, 300);
  } catch {
    errorText = "";
  }

  const gone = statusCode === 404 || statusCode === 410;
  return {
    ok: false,
    gone,
    statusCode,
    errorMessage: errorText || `HTTP ${statusCode}`,
  };
}
