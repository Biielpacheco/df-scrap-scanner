const fs = require('fs');
const path = require('path');

const root = __dirname;
const configPath = path.join(root, 'config.json');
const config = {
  bossWebhookUrl: process.env.BOSS_WEBHOOK_URL || '',
  bossRoleId: process.env.BOSS_ROLE_ID || '',
  devilRoleId: process.env.DEVIL_ROLE_ID || '',
  raidRoleId: process.env.RAID_ROLE_ID || '',
  banditRoleId: process.env.BANDIT_ROLE_ID || ''
};
if (fs.existsSync(configPath)) {
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (saved.bossWebhookUrl) config.bossWebhookUrl = saved.bossWebhookUrl;
  if (saved.bossRoleId) config.bossRoleId = saved.bossRoleId;
  if (saved.devilRoleId) config.devilRoleId = saved.devilRoleId;
  if (saved.raidRoleId) config.raidRoleId = saved.raidRoleId;
  if (saved.banditRoleId) config.banditRoleId = saved.banditRoleId;
}
if (process.env.BOSS_WEBHOOK_URL) config.bossWebhookUrl = process.env.BOSS_WEBHOOK_URL;
if (process.env.BOSS_ROLE_ID) config.bossRoleId = process.env.BOSS_ROLE_ID;
if (process.env.DEVIL_ROLE_ID) config.devilRoleId = process.env.DEVIL_ROLE_ID;
if (process.env.RAID_ROLE_ID) config.raidRoleId = process.env.RAID_ROLE_ID;
if (process.env.BANDIT_ROLE_ID) config.banditRoleId = process.env.BANDIT_ROLE_ID;

const bosses = (process.env.BOSSES || 'Pumpkin Queen,Devil Hound')
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

function is8Bandits(entry) {
  if (!entry || !entry.special_enemy_type || entry.special_enemy_type === '0') return false;
  const raw = String(entry.special_enemy_type).toLowerCase();
  return /8\s*x\s*bandit/i.test(raw);
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
    raw.includes('tendril') ||
    raw.includes('werewoo')
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

function getMention(boss) {
  if (boss && /devil/i.test(boss)) {
    const devilId = String(config.devilRoleId || '').trim();
    if (devilId) return `<@&${devilId}>`;
  }
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

function getBanditMention() {
  const banditId = String(config.banditRoleId || '').trim();
  if (banditId) return `<@&${banditId}>`;
  return '@everyone';
}

const outposts = [
  { name: 'Bunker', x: 1057, y: 1017 },
  { name: 'North Entrance', x: 1057, y: 1021 },
  { name: 'Fort Pastor', x: 1029, y: 1003 },
  { name: 'Dogg\'s Stockade', x: 1012, y: 1019 },
  { name: 'Camp Valcrest', x: 1032, y: 985 },
  { name: 'Precinct 13', x: 1005, y: 985 },
  { name: 'Nastya\'s Holdout', x: 1000, y: 1000 },
  { name: 'Ground Zero', x: 1054, y: 987 }
];

function getDirections(x, y) {
  const sorted = outposts.map(op => {
    const dx = x - op.x;
    const dy = y - op.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    let route = '';
    if (dx < 0) route += Math.abs(dx) + 'L';
    if (dx > 0) route += dx + 'R';
    if (dy < 0) route += Math.abs(dy) + 'D';
    if (dy > 0) route += dy + 'U';
    if (!route) route = 'No';
    return { name: op.name, dist, text: route + ' from ' + op.name + '.' };
  }).sort((a, b) => a.dist - b.dist);

  return sorted.slice(0, 2).map(s => s.text).join('\n');
}

const updatedMapsPath = path.join(root, 'updated-maps.json');
const updatedMaps = fs.existsSync(updatedMapsPath) ? new Set(JSON.parse(fs.readFileSync(updatedMapsPath, 'utf8'))) : new Set();

function getMapImageUrl(x, y) {
  const coord = x + 'x' + y;
  if (updatedMaps.has(coord)) {
    return 'https://raw.githubusercontent.com/luskrinha1/df-scrap-scanner/main/maps/Fairview_' + coord + '.webp';
  }
  return 'https://deadfrontier.info/map/Fairview_' + coord + '.png';
}

function createBossEmbed(boss, entry) {
  const isPumpkin = /pumpkin/i.test(boss);
  const isDevil = /devil/i.test(boss);
  let color = 0x9b59b6;
  if (isPumpkin) color = 0xff7518;
  if (isDevil) color = 0xb00020; // Vermelho Sangue / Red Crimson
  
  const primaryCoord = (entry.locations && entry.locations[0]) || [1050, 986];
  const px = Number(primaryCoord[0]);
  const py = Number(primaryCoord[1]);
  
  const end = Number(entry.end_time);
  const directions = getDirections(px, py);

  const locs = (entry.locations || []).filter(p => Number(p[0]) < 2000);
  let locationText = '';
  if (locs.length <= 1) {
    locationText = `📍 **Spawn em:** \`(${px}, ${py})\``;
  } else {
    locationText = `📍 **Spawns em:** ` + locs.map(p => `\`(${p[0]}, ${p[1]})\``).join(' • ');
  }

  let emoji = '🚨';
  if (isPumpkin) emoji = '🎃';
  if (isDevil) emoji = '🐺';

  let desc = `**Atenção ${getMention(boss)}!** Chefe especial ativo no mapa agora!\n\n`;
  desc += `${locationText}\n`;
  if (directions) {
    desc += `🧭 **Rotas:**\n${directions}\n`;
  }
  if (end) {
    desc += `⏳ **Tempo Restante:** <t:${end}:R> (<t:${end}:T>)\n`;
  }
  desc += `🗺️ [Abrir Mapa no DFProfiler](https://www.dfprofiler.com/bossmap)`;

  const spTime = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return {
    title: `${emoji} ${boss.toUpperCase()} DETECTADO!`,
    description: desc,
    color,
    image: {
      url: getMapImageUrl(px, py)
    },
    footer: { text: `DFProfiler Boss Alert • Detectado às ${spTime} (Brasília)` },
    timestamp: new Date().toISOString()
  };
}

function createBanditEmbed(entry) {
  const primaryCoord = (entry.locations && entry.locations[0]) || [1055, 988];
  const px = Number(primaryCoord[0]);
  const py = Number(primaryCoord[1]);
  
  const end = Number(entry.end_time);
  const directions = getDirections(px, py);

  const locs = (entry.locations || []).filter(p => Number(p[0]) < 2000);
  let locationText = '';
  if (locs.length <= 1) {
    locationText = `📍 **Spawn em:** \`(${px}, ${py})\``;
  } else {
    locationText = `📍 **Spawns em:** ` + locs.map(p => `\`(${p[0]}, ${p[1]})\``).join(' • ');
  }

  let desc = `**Atenção ${getBanditMention()}!** Evento raro de **8 x Bandits** ativo no mapa agora!\n\n`;
  desc += `${locationText}\n`;
  if (directions) {
    desc += `🧭 **Rotas:**\n${directions}\n`;
  }
  if (end) {
    desc += `⏳ **Tempo Restante:** <t:${end}:R> (<t:${end}:T>)\n`;
  }
  desc += `🗺️ [Abrir Mapa no DFProfiler](https://www.dfprofiler.com/bossmap)`;

  const spTime = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return {
    title: '🏴‍☠️ 8 x BANDITS DETECTADOS!',
    description: desc,
    color: 0xc0392b,
    image: {
      url: getMapImageUrl(px, py)
    },
    footer: { text: `DFProfiler Bandit Alert • Detectado às ${spTime} (Brasília)` },
    timestamp: new Date().toISOString()
  };
}

function consolidatedRaidMessage(raids) {
  const mention = getRaidMention();
  const end = raids.map(r => Number(r.end_time)).filter(Boolean)[0] || 0;
  const timerText = end ? `⏳ **Termina <t:${end}:R>** (<t:${end}:T>)` : '';

  return [
    '**Raid Alert** ' + mention,
    '⚠️ **Novas Raids (Ninhos de Boss) ativas no mapa:**',
    timerText,
    '',
    '<https://www.dfprofiler.com/bossmap>'
  ].filter(Boolean).join('\n');
}

async function publishEmbed(embed, mention) {
  const content = mention || getMention();
  const response = await fetch(config.bossWebhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Boss Alert',
      content,
      embeds: [embed],
      allowed_mentions: { parse: ['roles', 'everyone'] }
    })
  });
  if (!response.ok) throw new Error('Discord recusou o webhook do boss: ' + response.statusText);
}

async function publishBandits(entry) {
  const embed = createBanditEmbed(entry);
  const mention = getBanditMention();
  const response = await fetch(config.bossWebhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Bandit Alert',
      content: mention,
      embeds: [embed],
      allowed_mentions: { parse: ['roles', 'everyone'] }
    })
  });
  if (!response.ok) throw new Error('Discord recusou o webhook dos bandidos: ' + response.statusText);
}

async function publishText(content) {
  const response = await fetch(config.bossWebhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Boss Alert',
      content,
      allowed_mentions: { parse: ['roles', 'everyone'] }
    })
  });
  if (!response.ok) throw new Error('Discord recusou o webhook de raid: ' + response.statusText);
}

async function checkBosses(state) {
  const data = await loadMap();
  const sent = new Set(state.sent);
  let posted = 0;
  const newRaids = [];

  for (const entry of Object.values(data)) {
    if (!entry || entry.ended === '1') continue;
    if (!entry.event_id || sent.has(entry.event_id)) continue;

    // 1. Solo Wanted Bosses (Pumpkin Queen, Devil Hound, etc.)
    const boss = wanted(entry);
    if (boss) {
      const embed = createBossEmbed(boss, entry);
      if (preview) {
        console.log('--- ALERTA BOSS (PREVIEW) ---');
        console.log(JSON.stringify(embed, null, 2));
      } else {
        await publishEmbed(embed, getMention(boss));
      }
      sent.add(entry.event_id);
      posted += 1;
      console.log(`[ALERTA ENVIADO] Boss: ${boss} (ID: ${entry.event_id})`);
      continue;
    }

    // 2. Evento Especial de 8 x Bandits
    if (is8Bandits(entry)) {
      if (preview) {
        console.log('--- ALERTA 8 BANDITS (PREVIEW) ---');
        console.log(JSON.stringify(createBanditEmbed(entry), null, 2));
      } else {
        await publishBandits(entry);
      }
      sent.add(entry.event_id);
      posted += 1;
      console.log(`[ALERTA ENVIADO] 8 x Bandits (ID: ${entry.event_id})`);
      continue;
    }

    // 3. Raids normais do ciclo
    if (isRaid(entry)) {
      newRaids.push(entry);
      sent.add(entry.event_id);
    }
  }

  if (newRaids.length > 0) {
    const text = consolidatedRaidMessage(newRaids);
    if (preview) {
      console.log('--- ALERTA RAIDS (CONSOLIDADO) ---');
      console.log(text);
    } else {
      await publishText(text);
    }
    posted += 1;
    console.log(`[ALERTA ENVIADO] ${newRaids.length} Raids enviadas em 1 única mensagem!`);
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
    console.log('Enviando alerta de teste de Devil Hound para o Discord...');
    const testDevilEntry = {
      event_id: 'test_devil_' + Date.now(),
      special_enemy_type: '1 x Devil Hound (Teste de Configuração)',
      locations: [[1050, 991]],
      end_time: Math.floor(Date.now() / 1000) + 8640
    };
    if (preview) {
      console.log('--- PREVIEW TESTE DEVIL HOUND ---');
      console.log(JSON.stringify(createBossEmbed('Devil Hound', testDevilEntry), null, 2));
    } else {
      await publishEmbed(createBossEmbed('Devil Hound', testDevilEntry), getMention('Devil Hound'));
      console.log('Alerta de teste do Devil Hound enviado com sucesso!');
    }
    if (!loop) return;
  }
  
  if (loop) {
    console.log('Iniciando Vigia Contínuo de Bosses, Bandits e Raids (checagem a cada 45 segundos)...');
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
  console.log(posted ? 'Avisos enviados: ' + posted : 'Nenhum boss, bandit ou raid ativa no momento.');
}

main().catch(error => {
  console.log('Falhou: ' + error.message);
  process.exit(1);
});
