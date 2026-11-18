import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { handleRequest } from "../src/index.js";
import { runScheduledNotifications } from "../src/lib/scheduler.js";
import { bytesToBase64Url, deriveVapidPublicKey } from "../src/lib/crypto.js";
import { evaluateSlotDelivery } from "../src/lib/time.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationSql = fs.readFileSync(
  path.join(__dirname, "..", "migrations", "0001_init.sql"),
  "utf8"
);

/**
 * Cloudflare D1 互換ラッパー（node:sqlite の本物の SQLite エンジン上で実行）
 */
function createMockD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(migrationSql);

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
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements) {
          results.push(await s.run());
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

async function generateTestVapidKeys() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const publicKey = deriveVapidPublicKey(privateJwk);
  return { privateJwk, publicKey };
}

async function generateTestSubscription(endpoint = "https://web.push.apple.com/test-device-1") {
  const clientPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", clientPair.publicKey));
  const auth = new Uint8Array(16);
  crypto.getRandomValues(auth);
  return {
    endpoint,
    keys: {
      p256dh: bytesToBase64Url(rawPub),
      auth: bytesToBase64Url(auth),
    },
  };
}

async function createTestEnv() {
  const DB = createMockD1();
  const { privateJwk, publicKey } = await generateTestVapidKeys();
  return {
    DB,
    VAPID_PRIVATE_KEY: JSON.stringify(privateJwk),
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_SUBJECT: "https://seisho-tsudoku-app.vercel.app",
    DEFAULT_TIMEZONE: "Asia/Tokyo",
    ALLOWED_ORIGINS: "https://seisho-tsudoku-app.vercel.app,https://bdmsw788.github.io",
    APP_URL: "https://seisho-tsudoku-app.vercel.app/",
  };
}

async function api(env, method, pathname, { body, token, origin = "https://seisho-tsudoku-app.vercel.app", fetchImpl } = {}) {
  const headers = { Origin: origin };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const req = new Request(`https://worker.example.com${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleRequest(req, env, { fetchImpl });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, headers: res.headers, data };
}

test("初回登録で朝07:00・昼12:00・夜21:00の3枠が作成され、自由に追加・編集・時刻順整理・全削除(0件)できる", async () => {
  const env = await createTestEnv();
  const sub = await generateTestSubscription();

  // VAPID公開鍵取得 & CORS検証
  const keyRes = await api(env, "GET", "/api/vapid-public-key");
  assert.equal(keyRes.status, 200);
  assert.equal(keyRes.data.publicKey, env.VAPID_PUBLIC_KEY);
  assert.equal(keyRes.headers.get("Access-Control-Allow-Origin"), "https://seisho-tsudoku-app.vercel.app");

  // 1. 初回登録
  const reg = await api(env, "POST", "/api/devices/register", {
    body: { subscription: sub },
  });
  assert.equal(reg.status, 201);
  assert.equal(reg.data.timezone, "Asia/Tokyo");
  assert.equal(reg.data.isNew, true);
  assert.ok(reg.data.authToken);
  assert.deepEqual(
    reg.data.slots.map((s) => [s.name, s.time_hhmm, s.enabled]),
    [
      ["朝", "07:00", true],
      ["昼", "12:00", true],
      ["夜", "21:00", true],
    ]
  );
  for (const s of reg.data.slots) {
    assert.ok(s.id);
    assert.ok(s.created_at);
    assert.ok(s.updated_at);
  }

  const token = reg.data.authToken;

  // 2. 名前未指定で追加 → 初期名「追加通知」になり、時刻順に自動整理される
  const add1 = await api(env, "POST", "/api/slots", {
    token,
    body: { time_hhmm: "17:00" },
  });
  assert.equal(add1.status, 201);
  assert.equal(add1.data.slot.name, "追加通知");
  assert.deepEqual(
    add1.data.slots.map((s) => [s.name, s.time_hhmm]),
    [
      ["朝", "07:00"],
      ["昼", "12:00"],
      ["追加通知", "17:00"],
      ["夜", "21:00"],
    ]
  );

  // 3. 名前と時刻とON/OFFを編集 → 時刻順に再整列
  const edit1 = await api(env, "PATCH", `/api/slots/${add1.data.slot.id}`, {
    token,
    body: { name: "早朝祈り", time_hhmm: "05:30", enabled: false },
  });
  assert.equal(edit1.status, 200);
  assert.equal(edit1.data.slot.name, "早朝祈り");
  assert.equal(edit1.data.slot.time_hhmm, "05:30");
  assert.equal(edit1.data.slot.enabled, false);
  assert.deepEqual(
    edit1.data.slots.map((s) => [s.name, s.time_hhmm]),
    [
      ["早朝祈り", "05:30"],
      ["朝", "07:00"],
      ["昼", "12:00"],
      ["夜", "21:00"],
    ]
  );

  // 4. 固定上限（3件や6件）なしで7件まで増やせること
  for (const [name, time] of [
    ["午前", "09:30"],
    ["午後", "15:00"],
    ["夕方", "18:30"],
  ]) {
    const r = await api(env, "POST", "/api/slots", { token, body: { name, time_hhmm: time } });
    assert.equal(r.status, 201);
  }
  const list7 = await api(env, "GET", "/api/slots", { token });
  assert.equal(list7.data.slots.length, 7);
  assert.deepEqual(
    list7.data.slots.map((s) => s.time_hhmm),
    ["05:30", "07:00", "09:30", "12:00", "15:00", "18:30", "21:00"]
  );

  // 5. 初期枠（朝・昼・夜）も含めてすべて削除し、0件になっても問題ないこと
  for (const s of list7.data.slots) {
    const del = await api(env, "DELETE", `/api/slots/${s.id}`, { token });
    assert.equal(del.status, 200);
  }
  const list0 = await api(env, "GET", "/api/slots", { token });
  assert.equal(list0.status, 200);
  assert.deepEqual(list0.data.slots, []);

  // 6. 0件の状態で再同期（register）しても初期3件が勝手に復活しないこと
  const reReg = await api(env, "POST", "/api/devices/register", {
    token,
    body: { subscription: sub },
  });
  assert.equal(reReg.status, 200);
  assert.equal(reReg.data.isNew, false);
  assert.deepEqual(reReg.data.slots, []);

  // 7. 0件の状態から再び追加できること
  const addAgain = await api(env, "POST", "/api/slots", {
    token,
    body: { name: "就寝前", time_hhmm: "22:30" },
  });
  assert.equal(addAgain.status, 201);
  assert.equal(addAgain.data.slots.length, 1);
  assert.equal(addAgain.data.slots[0].name, "就寝前");
});

test("動的Cron配信・同日重複送信防止・OFF枠除外・削除枠の履歴管理(他枠無影響)・時刻変更反映", async () => {
  const env = await createTestEnv();
  const sub = await generateTestSubscription();

  const reg = await api(env, "POST", "/api/devices/register", {
    body: { subscription: sub, timezone: "Asia/Tokyo" },
  });
  const token = reg.data.authToken;
  const [morning, noon, night] = reg.data.slots;

  // 作成日時を過去日にしておいて、テスト対象日（2026-11-20）での配信を検証
  env.DB.sqlite.exec(`UPDATE notification_slots SET created_at = '2026-11-19T00:00:00.000Z', updated_at = '2026-11-19T00:00:00.000Z'`);

  // 夜枠はOFFにしておく
  await api(env, "PATCH", `/api/slots/${night.id}`, { token, body: { enabled: false } });
  env.DB.sqlite.exec(`UPDATE notification_slots SET updated_at = '2026-11-19T00:00:00.000Z'`);

  const pushedRequests = [];
  const mockFetch = async (endpoint, init) => {
    pushedRequests.push({ endpoint, headers: init.headers, bodyLength: init.body.byteLength });
    return new Response("", { status: 201 });
  };

  // JST 2026-11-20 07:00 (= UTC 2026-11-19 22:00)
  const jstMorning = new Date("2026-11-19T22:00:00.000Z");
  const sum1 = await runScheduledNotifications(env, jstMorning, mockFetch);
  assert.equal(sum1.sent, 1);
  assert.equal(pushedRequests.length, 1);
  assert.equal(pushedRequests[0].endpoint, sub.endpoint);
  assert.ok(pushedRequests[0].bodyLength > 0);

  // 同日 07:01 に再実行しても同じ通知枠からは重複送信されない！
  const jstMorningPlus1 = new Date("2026-11-19T22:01:00.000Z");
  const sumDup = await runScheduledNotifications(env, jstMorningPlus1, mockFetch);
  assert.equal(sumDup.sent, 0);
  assert.equal(sumDup.skippedAlreadySent, 1);
  assert.equal(pushedRequests.length, 1);

  // 昼枠の時刻を 12:00 → 12:30 に変更（まだ未送信）
  await api(env, "PATCH", `/api/slots/${noon.id}`, { token, body: { time_hhmm: "12:30" } });
  env.DB.sqlite.exec(`UPDATE notification_slots SET updated_at = '2026-11-20T01:00:00.000Z' WHERE id = '${noon.id}'`);

  // JST 12:00 には旧時刻なので送信されない
  const jstNoonOld = new Date("2026-11-20T03:00:00.000Z");
  const sumNoonOld = await runScheduledNotifications(env, jstNoonOld, mockFetch);
  assert.equal(sumNoonOld.sent, 0);

  // JST 12:30 に新時刻で送信される！
  const jstNoonNew = new Date("2026-11-20T03:30:00.000Z");
  const sumNoonNew = await runScheduledNotifications(env, jstNoonNew, mockFetch);
  assert.equal(sumNoonNew.sent, 1);
  assert.equal(pushedRequests.length, 2);

  // JST 21:00 は夜枠がOFFなので送信されない
  const jstNight = new Date("2026-11-20T12:00:00.000Z");
  const sumNight = await runScheduledNotifications(env, jstNight, mockFetch);
  assert.equal(sumNight.sent, 0);

  // 朝枠を削除 → 朝枠の送信履歴だけが削除され、昼枠の設定・送信履歴には影響しない！
  const logsBefore = env.DB.sqlite.prepare("SELECT slot_id FROM notification_logs").all();
  assert.equal(logsBefore.length, 2);

  const delMorning = await api(env, "DELETE", `/api/slots/${morning.id}`, { token });
  assert.equal(delMorning.status, 200);

  const logsAfter = env.DB.sqlite.prepare("SELECT slot_id FROM notification_logs").all();
  assert.equal(logsAfter.length, 1);
  assert.equal(logsAfter[0].slot_id, noon.id);

  // 翌日 JST 2026-11-21 07:00 → 削除された朝枠からは配信されない
  const nextDayMorning = new Date("2026-11-20T22:00:00.000Z");
  const sumNextMorning = await runScheduledNotifications(env, nextDayMorning, mockFetch);
  assert.equal(sumNextMorning.sent, 0);

  // 翌日 JST 2026-11-21 12:30 → 残っている昼枠は新しい日なので配信される
  const nextDayNoon = new Date("2026-11-21T03:30:00.000Z");
  const sumNextNoon = await runScheduledNotifications(env, nextDayNoon, mockFetch);
  assert.equal(sumNextNoon.sent, 1);
  assert.equal(pushedRequests.length, 3);
});

test("設定時刻より後に追加・変更された過去ウィンドウでは誤爆しない", () => {
  // JST 12:03 (= UTC 03:03) に 12:00 の枠を新規作成したケース
  const now = new Date("2026-11-20T03:03:00.000Z");
  const slotJustCreated = {
    id: "slot-1",
    enabled: true,
    time_hhmm: "12:00",
    updated_at: "2026-11-20T03:03:00.000Z",
  };
  const evalPast = evaluateSlotDelivery(slotJustCreated, now, "Asia/Tokyo");
  assert.equal(evalPast.due, false);

  // 一方、JST 12:03 にちょうど 12:03 を設定した場合は配信対象になる
  const slotSameMinute = {
    id: "slot-2",
    enabled: true,
    time_hhmm: "12:03",
    updated_at: "2026-11-20T03:03:00.000Z",
  };
  const evalNow = evaluateSlotDelivery(slotSameMinute, now, "Asia/Tokyo");
  assert.equal(evalNow.due, true);
  assert.equal(evalNow.sentDate, "2026-11-20");
});

test("端末分離セキュリティ・テスト通知・410 Gone 失効端末クリーンアップ", async () => {
  const env = await createTestEnv();
  const sub1 = await generateTestSubscription("https://web.push.apple.com/device-A");
  const sub2 = await generateTestSubscription("https://web.push.apple.com/device-B");

  const reg1 = await api(env, "POST", "/api/devices/register", { body: { subscription: sub1 } });
  const reg2 = await api(env, "POST", "/api/devices/register", { body: { subscription: sub2 } });

  // 端末2のトークンで端末1の通知枠を削除しようとしても 404 で拒否される
  const targetSlotId = reg1.data.slots[0].id;
  const hijack = await api(env, "DELETE", `/api/slots/${targetSlotId}`, { token: reg2.data.authToken });
  assert.equal(hijack.status, 404);

  // テスト通知は成功し、notification_logs には記録されない
  const testPush = await api(env, "POST", "/api/test-push", {
    token: reg1.data.authToken,
    fetchImpl: async () => new Response("", { status: 201 }),
  });
  assert.equal(testPush.status, 200);
  assert.equal(testPush.data.ok, true);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS c FROM notification_logs").get().c, 0);

  // 410 Gone を返す端末は Cron 実行時に自動クリーンアップされる
  env.DB.sqlite.exec(`UPDATE notification_slots SET updated_at = '2026-11-19T00:00:00.000Z'`);
  const jstMorning = new Date("2026-11-19T22:00:00.000Z");
  const goneResult = await runScheduledNotifications(env, jstMorning, async (endpoint) => {
    if (endpoint === sub1.endpoint) return new Response("Gone", { status: 410 });
    return new Response("", { status: 201 });
  });
  assert.equal(goneResult.removedGoneDevices, 1);
  assert.equal(goneResult.sent, 1);

  const remainingDevices = env.DB.sqlite.prepare("SELECT endpoint FROM devices").all();
  assert.deepEqual(remainingDevices.map((d) => d.endpoint), [sub2.endpoint]);
});
