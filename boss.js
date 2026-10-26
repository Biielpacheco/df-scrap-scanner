const fs = require('fs');
const path = require('path');

const root = __dirname;
const configPath = path.join(root, 'config.json');
const config = { bossWebhookUrl: process.env.BOSS_WEBHOOK_URL || '' };
if (fs.existsSync(configPath)) {
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (saved.bossWebhookUrl) config.bossWebhookUrl = saved.bossWebhookUrl;
}
if (process.env.BOSS_WEBHOOK_URL) config.bossWebhookUrl = process.env.BOSS_WEBHOOK_URL;

const bosses = (process.env.BOSSES || 'Pumpkin Queen')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);
const statePath = path.join(root, 'boss-state.json');
const preview = process.argv.includes('--preview');

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return { sent: Array.isArray(saved.sent) ? saved.sent : [] };
  } catch (error) {
    return { sent: [] };
  }
}

function saveState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state));
}

function enemyNames(entry) {
  return String(entry.special_enemy_type || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map(part => part.replace(/^\s*\d+\s*x\s*/i, '').trim())
    .filter(name => name && !/^\d+$/.test(name));
}

function wanted(entry) {
  const names = enemyNames(entry);
  return bosses.find(boss => names.some(name => name.toLowerCase() === boss.toLowerCase())) || '';
}

async function loadMap() {
  const response = await fetch('https://www.dfprofiler.com/bossmap/json/?_=' + Date.now(), {
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0'
    }
  });
  const text = await response.text();
  if (!response.ok || text.trim().startsWith('<')) {
    throw new Error('O mapa de bosses não respondeu.');
  }
  return JSON.parse(text);
}

function message(boss, entry) {
  const places = (entry.locations || [])
    .slice(0, 4)
    .map(pair => pair[0] + ' x ' + pair[1])
    .join('\n');
  const label = String(entry.special_enemy_type).replace(/<br\s*\/?>/gi, ', ');
  const end = Number(entry.end_time);
  return [
    '**' + boss + ' Alert** @everyone',
    label + ' apareceu',
    places,
    'https://www.dfprofiler.com/bossmap',
    end ? 'Termina <t:' + end + ':R>' : ''
  ].filter(Boolean).join('\n');
}

async function publish(content) {
  const response = await fetch(config.bossWebhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Boss Alert',
      content,
      allowed_mentions: { parse: ['everyone'] }
    })
  });
  if (!response.ok) throw new Error('Discord recusou o webhook.');
}

async function main() {
  const webhook = String(config.bossWebhookUrl || '').trim();
  if (!preview && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\//.test(webhook)) {
    console.log('Falta o webhook do canal da Pumpkin Queen.');
    return;
  }
  const state = loadState();
  const data = await loadMap();
  const sent = new Set(state.sent);
  let posted = 0;
  for (const entry of Object.values(data)) {
    if (!entry || entry.ended === '1') continue;
    const boss = wanted(entry);
    if (!boss || !entry.event_id || sent.has(entry.event_id)) continue;
    const content = message(boss, entry);
    if (preview) {
      console.log(content);
    } else {
      await publish(content);
    }
    sent.add(entry.event_id);
    posted += 1;
  }
  state.sent = [...sent].slice(-50);
  if (!preview) saveState(state);
  console.log(posted ? 'Avisos enviados: ' + posted : 'Pumpkin Queen não está no mapa.');
}

main().catch(error => {
  console.log('Falhou: ' + error.message);
  process.exit(1);
});
