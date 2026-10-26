const fs = require('fs');
const path = require('path');

const root = __dirname;
const configPath = path.join(root, 'config.json');
const config = {
  webhookUrl: process.env.WEBHOOK_URL || '',
  location: '21',
  intervalMinutes: 5,
  lines: 10
};
if (fs.existsSync(configPath)) {
  Object.assign(config, JSON.parse(fs.readFileSync(configPath, 'utf8')));
}
if (process.env.WEBHOOK_URL) config.webhookUrl = process.env.WEBHOOK_URL;
const yields = JSON.parse(fs.readFileSync(path.join(root, 'yields.json'), 'utf8'));
const statePath = path.join(root, 'state.json');
const preview = process.argv.includes('--preview');
const once = process.argv.includes('--once');
const loop = process.argv.includes('--loop');

const categories = [
  'weapon_heavymachinegun',
  'weapon_melee',
  'weapon_rifle',
  'weapon_pistol',
  'weapon_shotgun',
  'weapon_lightmachinegun',
  'armour',
  'weapon_grenadelauncher'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (error) {
    return { messageId: '', seen: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state));
}

function lookup(name) {
  const trimmed = name.trim();
  if (yields[trimmed]) return yields[trimmed];
  const shortName = trimmed.replace(/^Corpse\s+/i, '');
  return yields[shortName] || null;
}

function displayName(name) {
  return name.trim().replace(/^Corpse\s+/i, '');
}

function money(value) {
  const thousands = Math.round(value / 1000);
  if (thousands >= 1000) {
    const millions = Math.round(thousands / 100) / 10;
    return '$' + millions + 'm';
  }
  return '$' + thousands + 'k';
}

function parseTrade(text) {
  const data = {};
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const cut = pair.indexOf('=');
    if (cut < 0) continue;
    let value = pair.slice(cut + 1).replace(/\+/g, ' ');
    try { value = decodeURIComponent(value); } catch (error) {}
    data[pair.slice(0, cut)] = value;
  }
  return data;
}

async function searchCategory(category) {
  const body = new URLSearchParams({
    tradezone: String(config.location || '21'),
    searchname: '',
    memID: '',
    profession: '',
    category,
    search: 'trades',
    searchtype: 'buyinglistcategory'
  });
  const response = await fetch('https://fairview.deadfrontier.com/onlinezombiemmo/trade_search.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CappanCrunch'
    },
    body
  });
  const text = await response.text();
  if (!response.ok || text.trim().startsWith('<') || /too many|rate limit|blocked/i.test(text.slice(0, 300))) {
    const error = new Error('rate');
    error.rate = true;
    throw error;
  }
  const data = parseTrade(text);
  const max = parseInt(data.tradelist_maxresults, 10) || 0;
  const rows = [];
  for (let index = 0; index < max; index++) {
    const prefix = 'tradelist_' + index + '_';
    const price = parseInt(data[prefix + 'price'], 10);
    const name = String(data[prefix + 'itemname'] || '');
    const tradeId = String(data[prefix + 'trade_id'] || '');
    if (!tradeId || !Number.isFinite(price) || price <= 0) continue;
    const info = lookup(name);
    if (!info) continue;
    rows.push({
      name: displayName(name),
      price,
      count: info.count,
      kind: info.kind,
      unit: price / info.count,
      tradeId
    });
  }
  return rows;
}

async function collect() {
  const rows = [];
  for (const category of categories) {
    const found = await searchCategory(category);
    rows.push(...found);
    console.log(category + ': ' + found.length);
    await sleep(8000);
  }
  return rows;
}

function stamp(rows, state) {
  const now = Math.floor(Date.now() / 1000);
  const seen = {};
  for (const row of rows) {
    seen[row.tradeId] = row.seen || now;
    row.seen = seen[row.tradeId];
  }
  state.seen = seen;
  state.listings = rows;
}

function cheapest(rows, kind, singles) {
  return rows
    .filter(row => row.kind === kind && (!singles || row.count === 1))
    .sort((a, b) => a.unit - b.unit || a.price - b.price)
    .slice(0, config.lines || 10);
}

function getRareFingerprint(rows) {
  const rares = cheapest(rows, 'rare', false).map(r => r.tradeId + ':' + r.price).join('|');
  const singles = cheapest(rows, 'rare', true).map(r => r.tradeId + ':' + r.price).join('|');
  return rares + '#' + singles;
}

function line(row) {
  const when = '<t:' + row.seen + ':R>';
  if (row.count === 1) {
    return '**' + row.name + '** - Price: **' + money(row.price) + '** - ' + when;
  }
  return '**' + row.name + '** - **' + row.count + '** - **' + money(row.price) + '** - Scrap: **' + money(row.unit) + '** - ' + when;
}

function section(title, rows, color) {
  return {
    title,
    description: rows.length ? rows.map(line).join('\n') : 'Nenhum anúncio.',
    color
  };
}

function webhookUrl(extra, wait) {
  const url = new URL(config.webhookUrl.trim());
  if (extra) url.pathname = url.pathname.replace(/\/$/, '') + extra;
  if (wait) url.searchParams.set('wait', 'true');
  return url;
}

async function deleteMessage(id) {
  if (!id) return;
  await fetch(webhookUrl('/messages/' + id, false), { method: 'DELETE' });
}

async function rememberMessage(id) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!token || !repo || !id) {
    console.log('Número da mensagem ficou só nesta execução.');
    return;
  }
  const api = 'https://api.github.com/repos/' + repo + '/contents/message-id.txt';
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json'
  };
  let sha = '';
  const current = await fetch(api, { headers });
  if (current.ok) {
    const saved = await current.json();
    const text = Buffer.from(saved.content, 'base64').toString().trim();
    if (text === id) return;
    sha = saved.sha;
  }
  const body = {
    message: 'Keep the Discord message id',
    content: Buffer.from(id + '\n').toString('base64')
  };
  if (sha) body.sha = sha;
  const saved = await fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  console.log(saved.ok ? 'Número da mensagem guardado.' : 'Não guardei o número da mensagem.');
}

async function publish(embeds, state) {
  const payload = {
    username: 'Scrap Scanner',
    allowed_mentions: { parse: [] },
    embeds
  };
  if (state.messageId) {
    const edit = await fetch(webhookUrl('/messages/' + state.messageId, false), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (edit.ok) {
      await rememberMessage(state.messageId);
      return;
    }
    if (edit.status !== 404) {
      console.log('Não consegui editar a mensagem. Não vou mandar outra.');
      return;
    }
    state.messageId = '';
  }
  const created = await fetch(webhookUrl('', true), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await created.json();
  if (!created.ok || !body.id) {
    throw new Error('Discord recusou o webhook.');
  }
  state.messageId = body.id;
  await rememberMessage(body.id);
}

let nextAllowed = 0;

async function collectOne(state) {
  const index = Number(state.categoryIndex) || 0;
  const category = categories[index % categories.length];
  console.log('Consultando ' + category + '...');
  const found = await searchCategory(category);
  state.categoryIndex = (index + 1) % categories.length;
  console.log(category + ': ' + found.length);
  const kept = (state.listings || []).filter(row => row.category !== category);
  const now = Math.floor(Date.now() / 1000);
  const fresh = found.map(row => ({
    ...row,
    category,
    seen: now
  }));
  return kept.concat(fresh);
}

async function scan(state) {
  if (Date.now() < nextAllowed) return;
  let rows;
  try {
    if (loop) {
      rows = await collectOne(state);
    } else {
      console.log('Consultando o mercado...');
      rows = await collect();
    }
  } catch (error) {
    if (error.rate) {
      nextAllowed = Date.now() + 60 * 1000;
      state.nextAllowed = nextAllowed;
      saveState(state);
      console.log('Consulta falhou. Nova tentativa em 60 segundos.');
      return;
    }
    console.log('Falhou: ' + error.message);
    return;
  }
  stamp(rows, state);
  const oldFp = state.lastRareFp || '';
  const newFp = getRareFingerprint(rows);
  if (oldFp && oldFp !== newFp) {
    console.log('⚡ Alteração em Rare Metal Scrap detectada! Prioridade atualizada.');
  }
  state.lastRareFp = newFp;
  const rare = 0xf1c40f;
  const uncommon = 0x2ecc71;
  const common = 0x95a5a6;
  const embeds = [
    section('⚡ Top Cheapest Rare Metal Scrap [Prioridade]:', cheapest(rows, 'rare', false), rare),
    section('⚡ Top Cheapest Rare Metal Scrap Single [Prioridade]:', cheapest(rows, 'rare', true), rare),
    section('Top Cheapest Uncommon Metal Scrap:', cheapest(rows, 'uncommon', false), uncommon),
    section('Top Cheapest Uncommon Metal Scrap Single:', cheapest(rows, 'uncommon', true), uncommon),
    section('Top Cheapest Metal Scrap:', cheapest(rows, 'common', false), common),
    section('Top Cheapest Metal Scrap Single:', cheapest(rows, 'common', true), common)
  ];
  const spTime = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  embeds[embeds.length - 1].footer = {
    text: `⚡ Prioridade Rare Scrap Ativa • Atualizado às ${spTime} (Brasília)`
  };
  embeds[embeds.length - 1].timestamp = new Date().toISOString();
  if (preview) {
    for (const embed of embeds) {
      console.log('\n' + embed.title + '\n' + embed.description);
    }
    return;
  }
  await publish(embeds, state);
  saveState(state);
  console.log('Mensagem atualizada.');
}

async function main() {
  const webhook = String(config.webhookUrl || '').trim();
  if (!preview && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\//.test(webhook)) {
    console.log('Cola a URL do webhook em scrap-scanner/config.json, no campo webhookUrl, e roda de novo.');
    process.exit(1);
  }
  const state = loadState();
  const idFile = path.join(root, 'message-id.txt');
  if (fs.existsSync(idFile)) {
    const savedId = fs.readFileSync(idFile, 'utf8').trim();
    if (savedId) state.messageId = savedId;
  }
  nextAllowed = Number(state.nextAllowed) || 0;
  if (Date.now() < nextAllowed) {
    const minutes = Math.ceil((nextAllowed - Date.now()) / 60000);
    console.log('Ainda em espera. Tentativa em ' + minutes + ' minutos. Não roda outro scanner.');
  }
  const interval = Math.max(1, Number(config.intervalMinutes) || 3) * 60 * 1000;
  if (loop) {
    const minutes = Math.max(1, Number(process.env.SCAN_MINUTES) || 350);
    const end = Date.now() + minutes * 60 * 1000;
    while (Date.now() < end) {
      const started = Date.now();
      await scan(state);
      const wait = 60000 - (Date.now() - started);
      if (wait > 0 && Date.now() + wait < end) await sleep(wait);
    }
    return;
  }
  await scan(state);
  if (preview || once) return;
  setInterval(() => {
    scan(state).catch(error => console.log('Falhou: ' + error.message));
  }, interval);
}

main().catch(error => {
  console.log('Falhou: ' + error.message);
  process.exit(1);
});
