export const DEFAULT_TIMEZONE = "Asia/Tokyo";
export const DELIVERY_WINDOW_MINUTES = 5;

const TIME_HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTimeHHMM(value) {
  return typeof value === "string" && TIME_HHMM_RE.test(value);
}

export function timeToMinutes(hhmm) {
  const m = TIME_HHMM_RE.exec(hhmm);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

export function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(tz, fallback = DEFAULT_TIMEZONE) {
  if (isValidTimeZone(tz)) return tz.trim();
  return isValidTimeZone(fallback) ? fallback : DEFAULT_TIMEZONE;
}

function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function subtractOneDayYmd(ymd) {
  const [y, m, d] = ymd.split("-").map((v) => parseInt(v, 10));
  const prev = new Date(Date.UTC(y, m - 1, d - 1));
  return `${prev.getUTCFullYear()}-${pad2(prev.getUTCMonth() + 1)}-${pad2(prev.getUTCDate())}`;
}

export function getZonedNow(nowDate = new Date(), timeZone = DEFAULT_TIMEZONE) {
  const tz = normalizeTimeZone(timeZone);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const part of formatter.formatToParts(nowDate)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  const hour = parseInt(parts.hour, 10);
  const minute = parseInt(parts.minute, 10);
  const dateYmd = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    timeZone: tz,
    dateYmd,
    prevDateYmd: subtractOneDayYmd(dateYmd),
    timeHHMM: `${pad2(hour)}:${pad2(minute)}`,
    minutesOfDay: hour * 60 + minute,
  };
}

/**
 * 指定された通知枠が現在時刻に配信対象かを判定する。
 * - 有効な通知枠のみ対象
 * - 設定時刻から DELIVERY_WINDOW_MINUTES 分以内を配信対象とする（Cronの数分遅延にも対応）
 * - 作成・更新直後にすでに過ぎた過去時刻で誤爆送信しないよう制御する
 */
export function evaluateSlotDelivery(slot, nowDate = new Date(), timeZone = DEFAULT_TIMEZONE, windowMinutes = DELIVERY_WINDOW_MINUTES) {
  if (!slot || !slot.enabled) {
    return { due: false, sentDate: null };
  }
  const slotMin = timeToMinutes(slot.time_hhmm);
  if (slotMin === null) {
    return { due: false, sentDate: null };
  }

  const zoned = getZonedNow(nowDate, timeZone);
  const nowMin = zoned.minutesOfDay;

  let delta = null;
  let sentDate = null;

  if (slotMin <= nowMin && nowMin < slotMin + windowMinutes) {
    delta = nowMin - slotMin;
    sentDate = zoned.dateYmd;
  } else if (nowMin < windowMinutes && slotMin >= 1440 - windowMinutes) {
    const crossDelta = 1440 - slotMin + nowMin;
    if (crossDelta < windowMinutes) {
      delta = crossDelta;
      sentDate = zoned.prevDateYmd;
    }
  }

  if (delta === null || !sentDate) {
    return { due: false, sentDate: null };
  }

  // 設定・更新時刻より過去の配信枠に対して誤爆しないようにする
  const updatedMs = slot.updated_at ? Date.parse(slot.updated_at) : NaN;
  if (!Number.isNaN(updatedMs)) {
    const scheduledMs = nowDate.getTime() - delta * 60_000;
    if (updatedMs > scheduledMs + 60_000) {
      return { due: false, sentDate: null };
    }
  }

  return { due: true, sentDate };
}
