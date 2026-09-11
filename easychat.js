import { chromium } from 'playwright';
import WebSocket from 'ws';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function numberEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const DIALOGUE_PAGE_SIZE = numberEnv('DIALOGUE_PAGE_SIZE', 200);
const MESSAGE_PAGE_SIZE = numberEnv('MESSAGE_PAGE_SIZE', 20);
const MAX_MESSAGE_PAGES = numberEnv('MAX_MESSAGE_PAGES', 100);
const REQUEST_DELAY_MS = numberEnv('REQUEST_DELAY_MS', 50);
const TOKEN_CAPTURE_TIMEOUT_MS = numberEnv('TOKEN_CAPTURE_TIMEOUT_MS', 20000);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function findEasyChatUrl(value) {
  if (typeof value === 'string') {
    if (/^https:\/\/chat\.easychat\.ru\//i.test(value)) return value;
    try {
      const parsed = JSON.parse(value);
      return findEasyChatUrl(parsed);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findEasyChatUrl(item);
      if (found) return found;
    }
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findEasyChatUrl(item);
      if (found) return found;
    }
  }
  return null;
}

function sanitizeCookie(cookie) {
  return cookie.replace(/[\r\n]/g, '').trim();
}

async function getEasyChatLaunchUrl() {
  const domain = requiredEnv('FITBASE_DOMAIN');
  const cookie = sanitizeCookie(requiredEnv('FITBASE_COOKIE'));
  const chatId = requiredEnv('FITBASE_CHAT_ID');
  const channelId = requiredEnv('FITBASE_CHANNEL_ID');

  const url = `https://${domain}.fitbase.io/easychat/get-chat-url?chat_id=${encodeURIComponent(chatId)}&channel_id=${encodeURIComponent(channelId)}`;
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
    }
  });

  if (response.status === 401 || response.status === 403 || response.status === 302) {
    throw new Error(`FitBase session is not accepted (HTTP ${response.status}). Refresh FITBASE_COOKIE in Render.`);
  }
  if (!response.ok) {
    throw new Error(`FitBase get-chat-url failed: HTTP ${response.status}`);
  }

  const text = await response.text();
  let payload = text;
  try { payload = JSON.parse(text); } catch {}
  const easyChatUrl = findEasyChatUrl(payload);
  if (!easyChatUrl) throw new Error('EasyChat launch URL not found in FitBase response.');
  return easyChatUrl;
}

async function captureEasyChatCredentials(easyChatUrl) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ru-RU',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
  });
  const page = await context.newPage();

  let authorization = null;
  let wsUrl = null;

  page.on('request', (request) => {
    try {
      const url = new URL(request.url());
      if (url.hostname === 'chat_api.easychat.ru') {
        const headers = request.headers();
        if (headers.authorization) authorization = headers.authorization;
      }
    } catch {}
  });

  page.on('websocket', (socket) => {
    const url = socket.url();
    if (url.startsWith('wss://chat_wss.easychat.ru/')) wsUrl = url;
  });

  try {
    await page.goto(easyChatUrl, { waitUntil: 'domcontentloaded', timeout: TOKEN_CAPTURE_TIMEOUT_MS });
    const deadline = Date.now() + TOKEN_CAPTURE_TIMEOUT_MS;
    while (Date.now() < deadline && (!authorization || !wsUrl)) {
      await sleep(200);
    }
    if (!authorization) throw new Error('EasyChat Authorization header was not captured.');
    if (!wsUrl) throw new Error('EasyChat WebSocket URL was not captured.');
    return { authorization, wsUrl };
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export async function refreshCredentials() {
  const easyChatUrl = await getEasyChatLaunchUrl();
  return captureEasyChatCredentials(easyChatUrl);
}

async function fetchDialogues(authorization) {
  const dialogues = [];
  let page = 1;
  let totalCount = null;

  while (true) {
    const url = `https://chat_api.easychat.ru/v1/dialogue?page=${page}&pageSize=${DIALOGUE_PAGE_SIZE}`;
    const response = await fetch(url, {
      headers: {
        Authorization: authorization,
        Accept: 'application/json'
      }
    });
    if (!response.ok) throw new Error(`EasyChat dialogue list failed: HTTP ${response.status}, page=${page}`);
    const payload = await response.json();
    const batch = Array.isArray(payload.data) ? payload.data : [];
    totalCount ??= Number(payload.totalCount ?? batch.length);
    dialogues.push(...batch);
    if (!batch.length || batch.length < DIALOGUE_PAGE_SIZE || dialogues.length >= totalCount) break;
    page += 1;
    await sleep(40);
  }
  return dialogues;
}

function openMessageSocket(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { origin: 'https://chat.easychat.ru' });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('EasyChat WebSocket open timeout'));
    }, 12000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function createSequentialRequester(ws) {
  let pending = null;

  ws.on('message', (raw) => {
    if (!pending) return;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.action !== 'message.get') return;
      const { resolve, timer } = pending;
      pending = null;
      clearTimeout(timer);
      resolve(Array.isArray(msg.data) ? msg.data : []);
    } catch {}
  });

  ws.on('close', () => {
    if (pending) {
      const { reject, timer } = pending;
      pending = null;
      clearTimeout(timer);
      reject(new Error('EasyChat WebSocket closed during request'));
    }
  });

  return (dialogueId, page) => {
    if (pending) throw new Error('Sequential requester already has a pending request');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending = null;
        reject(new Error(`message.get timeout dialogue=${dialogueId} page=${page}`));
      }, 12000);
      pending = { resolve, reject, timer };
      ws.send(JSON.stringify({
        action: 'message.get',
        data: {
          dialogue_id: Number(dialogueId),
          page: Number(page),
          timeFrom: Date.now()
        }
      }));
    });
  };
}

function normalizeMessage(dialogue, message) {
  const created = Number(message.created_at ?? 0);
  const createdMs = created > 1e12 ? created : created * 1000;
  return {
    client_id: dialogue.crm_client_id ?? null,
    dialogue_name: dialogue.name ?? '',
    created_at: message.created_at ?? null,
    created_at_iso: Number.isFinite(createdMs) && createdMs > 0 ? new Date(createdMs).toISOString() : '',
    direction: Number(message.message_type) === 1 ? 'Входящее' : Number(message.message_type) === 2 ? 'Исходящее' : '',
    text: message.message ?? '',
    channel_id: dialogue.channel_id ?? message.channel_id ?? null,
    dialogue_id: dialogue.dialogue_id ?? message.dialogue_id ?? null,
    message_id: message.message_id ?? null,
    operator_id: message.operator_id ?? null,
    crm_manager_id: dialogue.crm_manager_id ?? null,
    integration_chat_id: dialogue.integration_chat_id ?? message.integration_chat_id ?? null,
    message_type: message.message_type ?? null,
    integration_message_id: message.integration_message_id ?? null,
    is_read: message.is_read ?? null,
    status: message.status ?? null
  };
}

export async function syncMessages({ sinceSec, overlapSec = 120 }) {
  const startedSec = Math.floor(Date.now() / 1000);
  const effectiveSince = Math.max(0, Number(sinceSec || 0) - Number(overlapSec || 0));
  const credentials = await refreshCredentials();
  const dialogues = await fetchDialogues(credentials.authorization);
  const changedDialogues = dialogues.filter((d) => Number(d.last_message_at ?? 0) > effectiveSince);

  let ws = await openMessageSocket(credentials.wsUrl);
  let requestPage = createSequentialRequester(ws);
  const messages = [];
  const seen = new Set();
  const errors = [];

  for (const dialogue of changedDialogues) {
    const dialogueId = Number(dialogue.dialogue_id);
    for (let page = 1; page <= MAX_MESSAGE_PAGES; page += 1) {
      let batch;
      try {
        batch = await requestPage(dialogueId, page);
      } catch (error) {
        errors.push({ dialogue_id: dialogueId, page, error: String(error?.message || error), retry: false });
        try { ws.terminate(); } catch {}
        try {
          const fresh = await refreshCredentials();
          ws = await openMessageSocket(fresh.wsUrl);
          requestPage = createSequentialRequester(ws);
          batch = await requestPage(dialogueId, page);
        } catch (retryError) {
          errors.push({ dialogue_id: dialogueId, page, error: String(retryError?.message || retryError), retry: true });
          break;
        }
      }

      if (!Array.isArray(batch) || batch.length === 0) break;
      let oldest = Number.POSITIVE_INFINITY;
      for (const message of batch) {
        const created = Number(message.created_at ?? 0);
        if (Number.isFinite(created)) oldest = Math.min(oldest, created > 1e12 ? Math.floor(created / 1000) : created);
        const key = `${dialogueId}:${message.message_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if ((created > 1e12 ? Math.floor(created / 1000) : created) > effectiveSince) {
          messages.push(normalizeMessage(dialogue, message));
        }
      }
      if (batch.length < MESSAGE_PAGE_SIZE || oldest <= effectiveSince) break;
      await sleep(REQUEST_DELAY_MS);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  try { ws.close(); } catch {}

  messages.sort((a, b) => {
    const ta = Date.parse(a.created_at_iso || 0);
    const tb = Date.parse(b.created_at_iso || 0);
    if (ta !== tb) return ta - tb;
    return Number(a.message_id || 0) - Number(b.message_id || 0);
  });

  return {
    ok: errors.filter((e) => e.retry).length === 0,
    sync_started_at: new Date(startedSec * 1000).toISOString(),
    next_since: startedSec,
    effective_since: effectiveSince,
    dialogues_total: dialogues.length,
    dialogues_changed: changedDialogues.length,
    messages,
    errors
  };
}
