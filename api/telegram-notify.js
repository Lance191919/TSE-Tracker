// api/telegram-notify.js
//
// Vercel serverless function that forwards TSE Tracker activity to a
// Telegram group chat. It is called by a Supabase Database Webhook that
// fires on every INSERT into the public.activity_log table — since every
// add/edit/delete/import in the app already writes a row there (see
// logActivity() in index.html). Only the sections listed in
// NOTIFY_ENTITY_TYPES below are forwarded (currently Work Tracker only).
//
// Required environment variables (set in Vercel → Project → Settings →
// Environment Variables):
//   TELEGRAM_BOT_TOKEN  — the bot token from @BotFather
//   TELEGRAM_CHAT_ID    — the group chat's id (see TELEGRAM_BOT_SETUP.md)
//   WEBHOOK_SECRET       — any random string; must match the header the
//                          Supabase webhook sends (see TELEGRAM_BOT_SETUP.md)
//
// No npm packages needed — Vercel's Node.js runtime has a global fetch().

// Only these sections (activity_log.entity_type, i.e. ENTITY_LABEL in
// index.html) are announced in the Telegram group. Everything else
// (PMS Status, Inventory, Reimbursement, etc.) is still recorded in the
// app's Activity Log tab — it just doesn't ping the group anymore.
// "Work Tracker" here means TSE-team tasks only: index.html labels GA/AM
// tasks as "GA Schedule" / "AM Schedule" (and ADMIN-team tasks as
// "Work Tracker (ADMIN)"), so those are not announced.
// To notify for another section again, add its name here, e.g. 'PMS Status'.
const NOTIFY_ENTITY_TYPES = ['Work Tracker'];

const ACTION_EMOJI = { add: '🆕', edit: '✏️', delete: '🗑️', import: '📥' };
const ACTION_VERB = {
  add: 'added a new entry in',
  edit: 'updated an entry in',
  delete: 'deleted an entry in',
  import: 'imported data into'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  // --- Verify the shared secret sent by the Supabase webhook ---
  const expectedSecret = process.env.WEBHOOK_SECRET;
  const gotSecret = req.headers['x-webhook-secret'];
  if (!expectedSecret || gotSecret !== expectedSecret) {
    res.status(401).send('Unauthorized');
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('telegram-notify: missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    res.status(500).send('Server not configured');
    return;
  }

  // --- Only react to new activity_log rows ---
  const body = req.body || {};
  if (body.table !== 'activity_log' || body.type !== 'INSERT') {
    res.status(200).send('Ignored');
    return;
  }

  const row = body.record || {};
  const actor = row.actor_name || 'Someone';
  const action = row.action || '';
  const entityType = row.entity_type || 'TSE Tracker';
  const label = (row.entity_label || '').trim();

  // Work Tracker changes made through the Telegram bot (api/telegram-webhook.js)
  // already get a direct reply in the chat — skip the extra activity_log
  // notification for those so the same action isn't announced twice.
  if (actor.startsWith('Telegram:')) {
    res.status(200).send('Skipped (bot-originated)');
    return;
  }

  if (!NOTIFY_ENTITY_TYPES.includes(entityType)) {
    res.status(200).send('Skipped (section not in NOTIFY_ENTITY_TYPES)');
    return;
  }

  const emoji = ACTION_EMOJI[action] || '🔔';
  const verb = ACTION_VERB[action] || `made a "${action}" change in`;

  const timeStr = new Date().toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
  });

  let text = `${emoji} ${actor} ${verb} ${entityType}`;
  if (label) text += `: ${label}`;
  text += `\n${timeStr}`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!tgRes.ok) {
      const errText = await tgRes.text();
      console.error('telegram-notify: Telegram API error', tgRes.status, errText);
      res.status(502).send('Telegram API error');
      return;
    }
  } catch (err) {
    console.error('telegram-notify: failed to reach Telegram API', err);
    res.status(502).send('Failed to reach Telegram API');
    return;
  }

  res.status(200).send('OK');
};
