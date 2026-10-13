// api/telegram-webhook.js
//
// Vercel serverless function that receives messages from the Telegram Bot
// API (via a webhook you register once with Telegram — see
// TELEGRAM_BOT_SETUP.md) and lets the team run a small set of Work Tracker
// commands directly from the Telegram group chat:
//
//   /addtask <task> | <assigned (optional)> | <date YYYY-MM-DD (optional)>
//   /pending
//   /complete <part of the task name>
//   /site <site name or part of it>
//   /help
//
// By design, every write this bot can make is limited to the Work Tracker
// (tasks) table — it can add a task and mark one complete, nothing else.
// Everything else in TSE Tracker (PMS Status writes, Inventory, Lakiwin,
// Landbased Accounts, deletes, etc.) stays notification-only via
// api/telegram-notify.js; this bot cannot touch those tables at all.
//
// Anyone who is a member of the configured Telegram group chat can use
// these commands — there is no per-person login check. Messages from any
// chat other than TELEGRAM_CHAT_ID are ignored. If you need tighter control
// later (e.g. only specific people), ask to add a Telegram username
// allow-list on top of this.
//
// Required environment variables (Vercel → Project → Settings →
// Environment Variables):
//   TELEGRAM_BOT_TOKEN        — the bot token from @BotFather
//   TELEGRAM_CHAT_ID          — the group chat's id (same one notify.js uses)
//   TELEGRAM_WEBHOOK_SECRET   — any random string; must match the
//                               secret_token you registered with Telegram's
//                               setWebhook call (see TELEGRAM_BOT_SETUP.md)
//   SUPABASE_URL              — e.g. https://kucnjakrnjvummydksst.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY — the service_role key from Supabase →
//                               Settings → API (NOT the anon key — this one
//                               bypasses RLS, so it must stay a server-only
//                               secret and is never sent to the browser)
//
// No npm packages needed — Vercel's Node.js runtime has a global fetch().

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  // Telegram sends this header back when the webhook was registered with a
  // secret_token — verifying it stops randoms from POSTing fake updates.
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!process.env.TELEGRAM_WEBHOOK_SECRET || secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(401).send('Unauthorized');
    return;
  }

  const update = req.body || {};
  const message = update.message || update.edited_message;
  if (!message || !message.text) {
    res.status(200).send('OK');
    return;
  }

  // Only react inside the one configured team group — ignore DMs or any
  // other chat the bot might end up in.
  const allowedChatId = String(process.env.TELEGRAM_CHAT_ID || '');
  if (!allowedChatId || String(message.chat.id) !== allowedChatId) {
    res.status(200).send('Ignored (wrong chat)');
    return;
  }

  const parsed = parseCommand(message.text);
  if (!parsed) {
    res.status(200).send('OK');
    return;
  }

  const fromName = (message.from && (message.from.username || message.from.first_name)) || 'Unknown';
  let reply;
  try {
    switch (parsed.cmd) {
      case 'start':
      case 'help':
        reply = helpText();
        break;
      case 'addtask':
        reply = await handleAddTask(parsed.args, fromName);
        break;
      case 'pending':
        reply = await handlePending();
        break;
      case 'complete':
        reply = await handleComplete(parsed.args, fromName);
        break;
      case 'site':
        reply = await handleSite(parsed.args);
        break;
      default:
        reply = `Hindi ko kilala ang command na "/${parsed.cmd}". I-type ang /help para sa listahan.`;
    }
  } catch (err) {
    console.error('telegram-webhook: command failed', parsed.cmd, err);
    reply = '⚠️ May error na nangyari, subukan ulit mamaya.';
  }

  await sendTelegramMessage(message.chat.id, reply);
  res.status(200).send('OK');
};

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------
function parseCommand(text) {
  // Strips an optional "@BotUsername" suffix that Telegram appends to
  // commands typed in a group, e.g. "/addtask@TSETrackerBot ...".
  const match = /^\/(\w+)(?:@\S+)?\s*([\s\S]*)$/.exec(text.trim());
  if (!match) return null;
  return { cmd: match[1].toLowerCase(), args: match[2].trim() };
}

function helpText() {
  return [
    '🤖 TSE Tracker Bot — Work Tracker commands:',
    '',
    '/addtask <task> | <assigned (optional)> | <date YYYY-MM-DD, optional>',
    'Hal: /addtask Restart router sa Berkeley | Dex | 2026-10-14',
    '',
    '/pending — listahan ng mga pending task',
    '',
    '/complete <bahagi ng task name> — markahan na Complete',
    'Hal: /complete restart router',
    '',
    '/site <site name o bahagi nito> — status ng isang site sa PMS Status',
    'Hal: /site Adriatico'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------
async function handleAddTask(args, fromName) {
  if (!args) {
    return 'Paano gamitin:\n/addtask <task> | <assigned (optional)> | <date YYYY-MM-DD, optional>\nHal: /addtask Restart router sa Berkeley | Dex | 2026-10-14';
  }
  const parts = args.split('|').map(s => s.trim());
  const taskText = parts[0];
  if (!taskText) return 'Kailangan ng task description bago ang "|".';
  const assigned = parts[1] || '—';
  const date = parts[2] || todayManila();

  const id = 'id_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const row = { id, task: taskText, assigned, date, team: 'TSE', status: 'pending' };

  await sbInsert('tasks', row);
  await logBotActivity(fromName, 'add', 'Work Tracker', taskText);

  return `✅ Naidagdag sa Work Tracker: "${taskText}"${assigned !== '—' ? ' — ' + assigned : ''} (${date})`;
}

async function handlePending() {
  const rows = await sbSelect('tasks', { status: 'eq.pending', order: 'date.asc', select: '*' });
  if (!rows.length) return '🎉 Walang pending task ngayon.';
  const shown = rows.slice(0, 15);
  const lines = shown.map((t, i) => {
    const who = t.assigned && t.assigned !== '—' ? ' — ' + t.assigned : '';
    return `${i + 1}. ${t.task}${who} (${t.date || 'no date'})`;
  });
  let msg = `📝 Pending tasks (${rows.length}):\n` + lines.join('\n');
  if (rows.length > shown.length) msg += `\n…at ${rows.length - shown.length} pa.`;
  return msg;
}

async function handleComplete(args, fromName) {
  if (!args) return 'Paano gamitin: /complete <bahagi ng task name>\nHal: /complete restart router';
  const matches = await sbSelect('tasks', {
    status: 'eq.pending',
    task: `ilike.*${args}*`,
    select: '*'
  });
  if (matches.length === 0) return `Walang nahanap na pending task na tugma sa "${args}".`;
  if (matches.length > 1) {
    const lines = matches.slice(0, 10).map(t => `• ${t.task}${t.assigned && t.assigned !== '—' ? ' — ' + t.assigned : ''}`);
    return `May ${matches.length} tasks na tugma sa "${args}". Maging mas specific:\n` + lines.join('\n');
  }
  const t = matches[0];
  await sbUpdate('tasks', t.id, { status: 'complete' });
  await logBotActivity(fromName, 'edit', 'Work Tracker', t.task);
  return `✅ Na-mark na Complete: "${t.task}"`;
}

async function handleSite(args) {
  if (!args) return 'Paano gamitin: /site <site name o bahagi nito>\nHal: /site Adriatico';
  const matches = await sbSelect('sites', {
    name: `ilike.*${args}*`,
    select: '*',
    limit: '6'
  });
  if (matches.length === 0) return `Walang nahanap na site na tugma sa "${args}".`;
  if (matches.length > 1) {
    const lines = matches.map(s => `• ${s.name}`);
    return `May ${matches.length} sites na tugma sa "${args}". Maging mas specific:\n` + lines.join('\n');
  }
  const s = matches[0];
  const markLabel = (s.mark || '').trim() || 'Pending';
  return [
    `📍 ${s.name}`,
    `Cluster: ${s.cluster || '—'}`,
    `TSE: ${s.tse || '—'}`,
    `Operation Hours: ${s.hours || '—'}`,
    `Schedule Date: ${s.sched || '—'}`,
    `Date Done: ${s.datedone || '—'}`,
    `Mark: ${markLabel}`
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Supabase REST helpers (service-role key — server-side only, bypasses RLS)
// ---------------------------------------------------------------------------
async function sbSelect(table, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  if (!res.ok) throw new Error(`Supabase select failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`Supabase insert failed (${res.status}): ${await res.text()}`);
}

async function sbUpdate(table, id, patch) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error(`Supabase update failed (${res.status}): ${await res.text()}`);
}

async function logBotActivity(fromName, action, entityType, label) {
  try {
    await sbInsert('activity_log', {
      actor_name: `Telegram: ${fromName}`,
      action,
      entity_type: entityType,
      entity_label: label || ''
    });
  } catch (err) {
    // Non-fatal — the task itself was already saved; the Activity Log
    // entry is just a bonus audit trail.
    console.error('telegram-webhook: logBotActivity failed', err);
  }
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------
function todayManila() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    if (!res.ok) console.error('telegram-webhook: sendMessage failed', res.status, await res.text());
  } catch (err) {
    console.error('telegram-webhook: failed to reach Telegram API', err);
  }
}
