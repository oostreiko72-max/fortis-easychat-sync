'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 10000);
const OWNER = process.env.GITHUB_OWNER || 'oostreiko72-max';
const REPO = process.env.GITHUB_REPO || 'fortis-easychat-sync';
const BRANCH = process.env.GITHUB_BRANCH || 'fortis-automation-map-site';
const FILE_PATH = process.env.GITHUB_PATH || 'fortis-automation-site/staff.html';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://fortis-fitbase-automation-map.onrender.com';
const MAX_BODY = 2 * 1024 * 1024;
const attempts = new Map();

function json(res, status, value, origin) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...(origin === ALLOWED_ORIGIN ? {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    } : {})
  });
  res.end(JSON.stringify(value));
}

function equalSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function rateLimited(ip) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || now - current.start > 60_000) {
    attempts.set(ip, { start: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > 12;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function githubRequest(method, url, body) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    const error = new Error('GITHUB_TOKEN is not configured on the admin service.');
    error.status = 503;
    throw error;
  }
  const response = await fetch(url, {
    method,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Fortis-Fitbase-Admin'
    },
    ...(body ? { headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Fortis-Fitbase-Admin',
      'Content-Type': 'application/json'
    }, body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error('GitHub API returned HTTP ' + response.status + ': ' + (data.message || 'Unknown error'));
    error.status = response.status === 401 || response.status === 403 ? 502 : 502;
    throw error;
  }
  return data;
}

const fileUrl = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/'
  + FILE_PATH.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(BRANCH);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (req.method === 'OPTIONS') {
    if (origin !== ALLOWED_ORIGIN) return json(res, 403, { error: 'Origin not allowed.' });
    res.writeHead(204, {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600'
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'fortis-fitbase-admin-api',
      githubConfigured: Boolean(process.env.GITHUB_TOKEN),
      adminConfigured: Boolean(process.env.ADMIN_PASSWORD)
    }, origin);
  }

  if (req.method !== 'POST' || req.url !== '/api/publish') {
    return json(res, 404, { error: 'Not found.' }, origin);
  }

  if (origin !== ALLOWED_ORIGIN) return json(res, 403, { error: 'This origin is not allowed to publish.' });
  if (rateLimited(ip)) return json(res, 429, { error: 'Too many attempts. Try again in one minute.' }, origin);

  const configuredPassword = process.env.ADMIN_PASSWORD;
  const authorization = req.headers.authorization || '';
  const suppliedPassword = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!configuredPassword || !equalSecret(suppliedPassword, configuredPassword)) {
    return json(res, 401, { error: 'Неверный пароль администратора.' }, origin);
  }

  try {
    const raw = await readBody(req);
    let payload;
    try { payload = JSON.parse(raw); } catch {
      return json(res, 400, { error: 'Некорректный JSON.' }, origin);
    }
    const html = payload && payload.html;
    if (typeof html !== 'string' || html.length < 50_000 || Buffer.byteLength(html, 'utf8') > MAX_BODY) {
      return json(res, 400, { error: 'HTML отсутствует или имеет недопустимый размер.' }, origin);
    }
    const lower = html.slice(0, 1000).toLowerCase();
    if (!lower.includes('<!doctype html') || !html.includes('id="fortis-editor-published"')
      || !html.includes('data-view="1"') || !html.includes('Воронки и автодействия')) {
      return json(res, 400, { error: 'Файл не прошёл проверку структуры карты Fortis.' }, origin);
    }

    const current = await githubRequest('GET', fileUrl);
    if (!current || !current.sha) {
      return json(res, 502, { error: 'Не удалось получить текущую версию staff.html.' }, origin);
    }

    const committed = await githubRequest('PUT',
      'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/'
        + FILE_PATH.split('/').map(encodeURIComponent).join('/'),
      {
        message: 'Publish Fortis Fitbase admin map',
        content: Buffer.from(html, 'utf8').toString('base64'),
        sha: current.sha,
        branch: BRANCH
      }
    );

    return json(res, 200, {
      ok: true,
      commit: committed.commit && committed.commit.sha,
      commitUrl: committed.commit && committed.commit.html_url,
      fileUrl: committed.content && committed.content.html_url,
      bytes: Buffer.byteLength(html, 'utf8'),
      message: 'Изменения сохранены в GitHub. Render автоматически обновляет публичный сайт.'
    }, origin);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 502;
    const safeMessage = status === 503
      ? 'Не настроен GITHUB_TOKEN. Добавьте секрет в Environment на Render.'
      : status === 502
        ? 'Не удалось записать файл в GitHub. Проверьте права токена Contents: Read and write.'
        : (error.message || 'Ошибка публикации.');
    return json(res, status, { error: safeMessage }, origin);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Fortis admin API listening on port ' + PORT);
});
