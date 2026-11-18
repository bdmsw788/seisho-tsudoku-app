import { evaluateSlotDelivery, DEFAULT_TIMEZONE } from "./time.js";
import { buildSlotNotificationPayload, sendWebPush } from "./push.js";

/**
 * 登録されているすべての有効な通知枠を動的に取得し、
 * 現在時刻が配信ウィンドウ内の未送信枠に対して Web Push を送信する。
 */
export async function runScheduledNotifications(env, nowDate = new Date(), fetchImpl = fetch) {
  const defaultTz = env.DEFAULT_TIMEZONE || DEFAULT_TIMEZONE;
  const appUrl = env.APP_URL || "https://seisho-tsudoku-app.vercel.app/";

  const queryResult = await env.DB.prepare(
    `SELECT
       s.id AS slot_id,
       s.device_id AS device_id,
       s.name AS slot_name,
       s.time_hhmm AS time_hhmm,
       s.enabled AS enabled,
       s.created_at AS slot_created_at,
       s.updated_at AS slot_updated_at,
       d.endpoint AS endpoint,
       d.p256dh AS p256dh,
       d.auth AS auth,
       d.timezone AS timezone
     FROM notification_slots s
     INNER JOIN devices d ON d.id = s.device_id
     WHERE s.enabled = 1
     ORDER BY s.time_hhmm ASC, s.created_at ASC`
  ).all();

  const rows = queryResult.results || [];
  const goneDeviceIds = new Set();

  const summary = {
    checked: rows.length,
    due: 0,
    sent: 0,
    skippedAlreadySent: 0,
    failed: 0,
    removedGoneDevices: 0,
  };

  for (const row of rows) {
    if (goneDeviceIds.has(row.device_id)) {
      continue;
    }

    const slot = {
      id: row.slot_id,
      device_id: row.device_id,
      name: row.slot_name,
      time_hhmm: row.time_hhmm,
      enabled: Boolean(row.enabled),
      created_at: row.slot_created_at,
      updated_at: row.slot_updated_at,
    };

    const tz = row.timezone || defaultTz;
    const evaluation = evaluateSlotDelivery(slot, nowDate, tz);
    if (!evaluation.due || !evaluation.sentDate) {
      continue;
    }

    summary.due += 1;

    // 同じ通知枠・同じ日の重複送信を UNIQUE(slot_id, sent_date) で原子的に防止
    const logId = crypto.randomUUID();
    const nowIso = nowDate.toISOString();
    const reserve = await env.DB.prepare(
      `INSERT OR IGNORE INTO notification_logs
         (id, device_id, slot_id, sent_date, scheduled_time, status, sent_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(logId, row.device_id, row.slot_id, evaluation.sentDate, row.time_hhmm, nowIso)
      .run();

    const inserted = (reserve.meta && typeof reserve.meta.changes === "number") ? reserve.meta.changes : 0;
    if (inserted === 0) {
      summary.skippedAlreadySent += 1;
      continue;
    }

    const payload = buildSlotNotificationPayload(slot, evaluation.sentDate, appUrl);
    let pushResult;
    try {
      pushResult = await sendWebPush({
        env,
        device: {
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
        },
        payload,
        fetchImpl,
      });
    } catch (err) {
      pushResult = {
        ok: false,
        gone: false,
        statusCode: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    if (pushResult.ok) {
      await env.DB.prepare(
        `UPDATE notification_logs
         SET status = 'sent', status_code = ?, sent_at = ?
         WHERE id = ?`
      )
        .bind(pushResult.statusCode, new Date().toISOString(), logId)
        .run();
      summary.sent += 1;
    } else if (pushResult.gone) {
      // Push購読が失効（404/410）している端末は安全にクリーンアップ
      goneDeviceIds.add(row.device_id);
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM notification_logs WHERE device_id = ?`).bind(row.device_id),
        env.DB.prepare(`DELETE FROM notification_slots WHERE device_id = ?`).bind(row.device_id),
        env.DB.prepare(`DELETE FROM devices WHERE id = ?`).bind(row.device_id),
      ]);
      summary.removedGoneDevices += 1;
    } else {
      await env.DB.prepare(
        `UPDATE notification_logs
         SET status = 'failed', status_code = ?, error_message = ?, sent_at = ?
         WHERE id = ?`
      )
        .bind(pushResult.statusCode || null, pushResult.errorMessage || "Unknown error", new Date().toISOString(), logId)
        .run();
      summary.failed += 1;
    }
  }

  return summary;
}
