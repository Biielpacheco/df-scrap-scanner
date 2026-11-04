const fs = require('fs');
const path = require('path');

const root = __dirname;
const configPath = path.join(root, 'config.json');
const config = {
  bossWebhookUrl: process.env.BOSS_WEBHOOK_URL || '',
  bossRoleId: process.env.BOSS_ROLE_ID || '',
  raidRoleId: process.env.RAID_ROLE_ID || ''
};
if (fs.existsSync(configPath)) {
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (saved.bossWebhookUrl) config.bossWebhookUrl = saved.bossWebhookUrl;
  if (saved.bossRoleId) config.bossRoleId = saved.bossRoleId;
  if (saved.raidRoleId) config.raidRoleId = saved.raidRoleId;
}
if (process.env.BOSS_WEBHOOK_URL) config.bossWebhookUrl = process.env.BOSS_WEBHOOK_URL;
if (process.env.BOSS_ROLE_ID) config.bossRoleId = process.env.BOSS_ROLE_ID;
if (process.env.RAID_ROLE_ID) config.raidRoleId = process.env.RAID_ROLE_ID;

const bosses = (process.env.BOSSES || 'Pumpkin Queen')
  .split(',')
  .map(name => name.trim())
  .filter(Boolean);
const statePath = path.join(root, 'boss-state.json');
const preview = process.argv.includes('--preview');
const loop = process.argv.includes('--loop');
const test = process.argv.includes('--test');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function isRaid(entry) {
  if (!entry || !entry.special_enemy_type || entry.special_enemy_type === '0') return false;
  const loc = entry.locations && entry.locations[0];
  if (!loc || Number(loc[0]) >= 2000) return false;

  const raw = String(entry.special_enemy_type).toLowerCase();
  if (
    raw.includes('bandit') ||
    raw.includes('scarecrow') ||
    raw.includes('slenderman') ||
    raw.includes('snowman') ||
    raw.includes('tendril')
  ) {
    return false;
  }

  const isMulti = raw.includes('<br') || raw.includes('\n');
  if (!isMulti) return false;

  const bossTypes = ['titan', 'mother', 'wraith', 'spider', 'bear', 'dreadstag', 'hound'];
  return bossTypes.some(b => raw.includes(b));
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

function getMention() {
  const roleId = String(config.bossRoleId || '').trim();
  if (roleId) return `<@&${roleId}>`;
  return '@everyone';
}

function getRaidMention() {
  const raidId = String(config.raidRoleId || '').trim();
  if (raidId) return `<@&${raidId}>`;
  const bossId = String(config.bossRoleId || '').trim();
  if (bossId) return `<@&${bossId}>`;
  return '@raids';
}

function formatLocations(entry) {
  return (entry.locations || [])
    .filter(p => Number(p[0]) < 2000)
    .slice(0, 4)
    .map(pair => pair[0] + ' x ' + pair[1])
    .join('\n');
}

function bossMessage(boss, entry) {
  const places = formatLocations(entry);
  const label = String(entry.special_enemy_type).replace(/<br\s*\/?>/gi, ', ');
  const end = Number(entry.end_time);
  const mention = getMention();
  return [
    '**' + boss + ' Alert** ' + mention,
    label + ' apareceu',
    places,
    'https://www.dfprofiler.com/bossmap',
    end ? 'Termina <t:' + end + ':R>' : ''
  ].filter(Boolean).join('\n');
}

function raidMessage(entry) {
  const places = formatLocations(entry);
  const enemies = String(entry.special_enemy_type || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .join('\n');
  const end = Number(entry.end_time);
  const mention = getRaidMention();
  return [
    '**Raid Alert** ' + mention,
    enemies,
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
      allowed_mentions: { parse: ['roles', 'everyone'] }
    })
  });
  if (!response.ok) throw new Error('Discord recusou o webhook: ' + response.statusText);
}

async function checkBosses(state) {
  const data = await loadMap();
  const sent = new Set(state.sent);
  let posted = 0;
  for (const entry of Object.values(data)) {
    if (!entry || entry.ended === '1') continue;
    if (!entry.event_id || sent.has(entry.event_id)) continue;

    const boss = wanted(entry);
    if (boss) {
      const content = bossMessage(boss, entry);
      if (preview) {
        console.log('--- ALERTA BOSS (PREVIEW) ---');
        console.log(content);
      } else {
        await publish(content);
      }
      sent.add(entry.event_id);
      posted += 1;
      console.log(`[ALERTA ENVIADO] Boss: ${boss} (ID: ${entry.event_id})`);
      continue;
    }

    if (isRaid(entry)) {
      const content = raidMessage(entry);
      if (preview) {
        console.log('--- ALERTA RAID (PREVIEW) ---');
        console.log(content);
      } else {
        await publish(content);
      }
      sent.add(entry.event_id);
      posted += 1;
      console.log(`[ALERTA ENVIADO] Raid em (${entry.locations?.[0]}) (ID: ${entry.event_id})`);
      continue;
    }
  }
  state.sent = [...sent].slice(-100);
  if (!preview && posted > 0) saveState(state);
  return posted;
}

async function main() {
  const webhook = String(config.bossWebhookUrl || '').trim();
  if (!preview && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\d+\//.test(webhook)) {
    console.log('Falta o webhook do canal de boss (BOSS_WEBHOOK_URL).');
    return;
  }
  const state = loadState();

  if (test) {
    console.log('Enviando alertas de teste para o Discord...');
    const testBossEntry = {
      event_id: 'test_boss_' + Date.now(),
      special_enemy_type: '1 x Pumpkin Queen',
      locations: [[1056, 990]],
      end_time: Math.floor(Date.now() / 1000) + 1800
    };
    const testRaidEntry = {
      event_id: 'test_raid_' + Date.now(),
      special_enemy_type: '1 x Irradiated Mother<br />1 x Irradiated Wraith<br />1 x Mega Titan<br />2 x Mega Mother<br />2 x Mega Wraith<br />1 x Charred Wraith',
      locations: [[1053, 1016]],
      end_time: Math.floor(Date.now() / 1000) + 3600
    };
    const bossContent = bossMessage('Pumpkin Queen', testBossEntry);
    const raidContent = raidMessage(testRaidEntry);
    if (preview) {
      console.log('--- PREVIEW TESTE BOSS ---');
      console.log(bossContent);
      console.log('--- PREVIEW TESTE RAID ---');
      console.log(raidContent);
    } else {
      await publish(bossContent);
      await publish(raidContent);
      console.log('Alertas de teste enviados com sucesso!');
    }
    if (!loop) return;
  }
  
  if (loop) {
    console.log('Iniciando Vigia Contínuo de Bosses e Raids (checagem a cada 45 segundos)...');
    const minutes = Math.max(1, Number(process.env.SCAN_MINUTES) || 350);
    const end = Date.now() + minutes * 60 * 1000;
    while (Date.now() < end) {
      try {
        const posted = await checkBosses(state);
        if (posted > 0) {
          console.log(`Alertas enviados neste ciclo: ${posted}`);
        }
      } catch (err) {
        console.log('Erro ao consultar mapa de bosses: ' + err.message);
      }
      await sleep(45000);
    }
    return;
  }
  
  const posted = await checkBosses(state);
  console.log(posted ? 'Avisos enviados: ' + posted : 'Nenhum boss ou raid ativa no momento.');
}

main().catch(error => {
  console.log('Falhou: ' + error.message);
  process.exit(1);
});
