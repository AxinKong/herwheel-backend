const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Sends an email via the Resend API.
 * Requires RESEND_API_KEY and EMAIL_FROM in .env.
 * Failures are logged but never thrown — a failed welcome email
 * should not block account creation.
 */
async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping email send.');
    return;
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'HerWheel <onboarding@resend.dev>',
        to,
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Resend API error:', res.status, text);
    }
  } catch (err) {
    console.error('Failed to send email:', err);
  }
}

/**
 * Sends the "welcome / registration successful" email.
 * Intentionally does NOT include the password — only confirms the
 * account email and reminds the user to keep their password safe.
 */
function sendWelcomeEmail(toEmail, lang = 'en') {
  const copy = {
    en: {
      subject: 'Welcome to HerWheel — your account is ready',
      heading: 'You\'re all set!',
      body: `Your HerWheel account has been created successfully.`,
      usernameLabel: 'Username (email)',
      passwordNote: 'For your security, we don\'t store or send your password in plain text. Please keep the password you chose somewhere safe — you\'ll need it to sign in.',
      footer: 'If you didn\'t create this account, you can safely ignore this email.',
    },
    zh: {
      subject: '欢迎加入 HerWheel — 你的账号已创建成功',
      heading: '注册成功！',
      body: `你的 HerWheel 账号已成功创建。`,
      usernameLabel: '用户名（邮箱）',
      passwordNote: '出于安全考虑，我们不会以明文形式存储或发送你的密码。请妥善保管你设置的密码，登录时需要用到。',
      footer: '如果这不是你本人的操作，请忽略此邮件。',
    },
    ja: {
      subject: 'HerWheelへようこそ — アカウントの準備が完了しました',
      heading: '登録が完了しました！',
      body: `HerWheelのアカウントが正常に作成されました。`,
      usernameLabel: 'ユーザー名（メールアドレス）',
      passwordNote: '安全のため、パスワードを平文で保存・送信することはありません。ログイン時に必要となりますので、設定したパスワードは安全な場所に保管してください。',
      footer: 'このアカウント作成に心当たりがない場合は、本メールを無視してください。',
    },
  };

  const c = copy[lang] || copy.en;

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color:#21302B;">
      <h2 style="color:#2F4F46;">${c.heading}</h2>
      <p>${c.body}</p>
      <table style="background:#F1E7D4; border-radius:10px; padding:14px; width:100%; margin:16px 0;">
        <tr><td style="font-size:13px; color:#5C6F68;">${c.usernameLabel}</td></tr>
        <tr><td style="font-size:15px; font-weight:600;">${toEmail}</td></tr>
      </table>
      <p style="font-size:13px; color:#5C6F68;">${c.passwordNote}</p>
      <hr style="border:none; border-top:1px solid #E4DCC9; margin:20px 0;">
      <p style="font-size:12px; color:#A9BBB3;">${c.footer}</p>
    </div>
  `;

  return sendEmail({ to: toEmail, subject: c.subject, html });
}

module.exports = { sendEmail, sendWelcomeEmail };
