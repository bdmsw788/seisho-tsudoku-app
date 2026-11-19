/**
 * みことばの庭 — 自動クラウドバックアップ用メール送信中継 (Google Apps Script)
 *
 * 【セットアップ手順】
 * 1. https://script.google.com で新しいプロジェクトを作成し、このコードを貼り付ける。
 * 2. 「プロジェクトの設定」>「スクリプト プロパティ」に `MAIL_SECRET` を追加し、
 *    十分な長さのランダム文字列を設定する（Cloudflare Workers の `GAS_MAIL_SECRET` と一致させる）。
 * 3. 右上の「デプロイ」>「新しいデプロイ」> 種類「ウェブアプリ」を選択：
 *    - 実行するユーザー：自分
 *    - アクセスできるユーザー：全員（Worker からのみ秘匿シークレット付きで呼び出すため）
 * 4. 発行されたウェブアプリ URL を Cloudflare Workers のシークレット `GAS_MAIL_WEBHOOK_URL` に設定する。
 *    `npx wrangler secret put GAS_MAIL_WEBHOOK_URL`
 *    `npx wrangler secret put GAS_MAIL_SECRET`
 */

function doPost(e) {
  try {
    var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : "{}";
    var body = JSON.parse(raw);

    var props = PropertiesService.getScriptProperties();
    var expectedSecret = props.getProperty("MAIL_SECRET") || "";
    if (!expectedSecret || body.secret !== expectedSecret) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: "unauthorized" })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var to = String(body.to || "").trim();
    var subject = String(body.subject || "").trim();
    var text = String(body.text || "");
    var html = String(body.html || "");

    if (!to || !subject) {
      return ContentService.createTextOutput(
        JSON.stringify({ ok: false, error: "missing_fields" })
      ).setMimeType(ContentService.MimeType.JSON);
    }

    var options = {
      name: "みことばの庭",
    };
    if (html) {
      options.htmlBody = html;
    }

    MailApp.sendEmail(to, subject, text, options);

    return ContentService.createTextOutput(
      JSON.stringify({ ok: true })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
