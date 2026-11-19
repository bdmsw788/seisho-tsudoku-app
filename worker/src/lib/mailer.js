function buildOtpMailContent(code) {
  const subject = "【みことばの庭】ログイン認証コード：" + code;
  const text = [
    "みことばの庭（聖書通読アプリ）の自動クラウドバックアップをご利用いただき、ありがとうございます。",
    "",
    "下の6桁の認証コードをアプリに入力してください。",
    "",
    "  認証コード： " + code,
    "",
    "※ このコードの有効期限は 10分間 です。",
    "※ 心当たりがない場合は、このメールをそのまま破棄してください。",
  ].join("\n");

  const html = [
    '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;color:#2c241b;background:#faf7f0;border:1px solid #e5dcc8;border-radius:12px;">',
    '<h2 style="margin:0 0 12px;font-size:18px;color:#1b4332;">みことばの庭 認証コード</h2>',
    '<p style="margin:0 0 16px;font-size:14px;line-height:1.7;">自動クラウドバックアップのサインイン用コードです。10分以内にアプリへご入力ください。</p>',
    '<div style="text-align:center;margin:18px 0;padding:16px;background:#ffffff;border:1px solid #d4af37;border-radius:10px;font-size:28px;font-weight:700;letter-spacing:0.25em;color:#1b4332;">',
    code,
    "</div>",
    '<p style="margin:0;font-size:12px;color:#6f6457;line-height:1.6;">※ 心当たりがない場合は、このメールを破棄してください。</p>',
    "</div>",
  ].join("");

  return { subject, text, html };
}

export async function sendOtpEmail(env, { to, code, fetchImpl = fetch }) {
  const { subject, text, html } = buildOtpMailContent(code);

  const resendKey = (env?.RESEND_API_KEY || "").trim();
  if (resendKey) {
    const from = (env.MAIL_FROM || "").trim() || "みことばの庭 <onboarding@resend.dev>";
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + resendKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        text,
        html,
      }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => "");
      console.error("Resend send failed:", response.status, errBody.slice(0, 300));
      return {
        ok: false,
        code: "MAIL_SEND_FAILED",
        message: "メール送信に失敗しました。しばらく経ってからお試しください。",
      };
    }

    return { ok: true, provider: "resend" };
  }

  const gasUrl = (env?.GAS_MAIL_WEBHOOK_URL || "").trim();
  if (gasUrl) {
    const response = await fetchImpl(gasUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        secret: (env.GAS_MAIL_SECRET || "").trim(),
        to,
        subject,
        text,
        html,
      }),
    });

    const rawText = await response.text().catch(() => "");
    let parsed = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch (_) {
      parsed = null;
    }

    if (!response.ok || (parsed && parsed.ok === false)) {
      console.error("GAS mail relay failed:", response.status, rawText.slice(0, 300));
      return {
        ok: false,
        code: "MAIL_SEND_FAILED",
        message: "メール送信に失敗しました。GAS中継の設定をご確認ください。",
      };
    }

    return { ok: true, provider: "gas" };
  }

  return {
    ok: false,
    code: "MAIL_NOT_CONFIGURED",
    message: "メール送信がまだ設定されていません（管理者にメール連携の設定をご依頼ください）。",
  };
}
