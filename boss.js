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
  const color = isPumpkin ? 0xff7518 : 0x9b59b6;
  const primaryCoord = (entry.locations && entry.locations[0]) || [1050, 986];
  const px = Number(primaryCoord[0]);
  const py = Number(primaryCoord[1]);
  
  const end = Number(entry.end_time);
  const directions = getDirections(px, py);

  const locs = entry.locations || [];
  let locationText = '';
  if (locs.length <= 1) {
    locationText = `📍 **Spawn em:** \`(${px}, ${py})\``;
  } else {
    locationText = `📍 **Spawns em:** ` + locs.map(p => `\`(${p[0]}, ${p[1]})\``).join(' • ');
  }

  let desc = `**Atenção ${getMention()}!** Chefe especial ativo no mapa agora!\n\n`;
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
    title: isPumpkin ? `🎃 ${boss.toUpperCase()} DETECTADA!` : `🚨 ${boss.toUpperCase()} DETECTADO!`,
    description: desc,
    color,
    image: {
      url: getMapImageUrl(px, py)
    },
    footer: { text: `DFProfiler Boss Alert • Detectado às ${spTime} (Brasília)` },
    timestamp: new Date().toISOString()
  };
}

function consolidatedRaidMessage(raids) {
  const mention = getRaidMention();
  const lines = [
    '**Raid Alert** ' + mention,
    '⚠️ **Novas Raids (Ninhos de Boss) ativas no mapa:**',
    ''
  ];

  for (const r of raids) {
    const loc = (r.locations || [])
      .filter(p => Number(p[0]) < 2000)
      .slice(0, 3)
      .map(p => p[0] + ' x ' + p[1])
      .join(' • ');
    const enemies = String(r.special_enemy_type || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .join(', ');
    const end = Number(r.end_time);

    lines.push('📍 `' + loc + '`' + (end ? ' (Termina <t:' + end + ':R>)' : ''));
    lines.push('↳ ' + enemies);
    lines.push('');
  }

  lines.push('<https://www.dfprofiler.com/bossmap>');
  return lines.join('\n');
}

async function publishEmbed(embed) {
  const mention = getMention();
  const response = await fetch(config.bossWebhookUrl.trim(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Boss Alert',
      content: mention,
      embeds: [embed],
      allowed_mentions: { parse: ['roles', 'everyone'] }
    })
  });
  if (!response.ok) throw new Error('Discord recusou o webhook do boss: ' + response.statusText);
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

    const boss = wanted(entry);
    if (boss) {
      const embed = createBossEmbed(boss, entry);
      if (preview) {
        console.log('--- ALERTA BOSS (PREVIEW) ---');
        console.log(JSON.stringify(embed, null, 2));
      } else {
        await publishEmbed(embed);
      }
      sent.add(entry.event_id);
      posted += 1;
      console.log(`[ALERTA ENVIADO] Boss: ${boss} (ID: ${entry.event_id})`);
      continue;
    }

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
    console.log('Enviando alertas de teste para o Discord...');
    const testBossEntry = {
      event_id: 'test_boss_' + Date.now(),
      special_enemy_type: '1 x Pumpkin Queen (Teste de Configuração)',
      locations: [[1050, 986]],
      end_time: Math.floor(Date.now() / 1000) + 1800
    };
    const testRaids = [
      {
        event_id: 'test_raid_1',
        special_enemy_type: '1 x Irradiated Mother<br />1 x Mega Titan<br />2 x Mega Mother<br />1 x Charred Wraith',
        locations: [[1053, 1016]],
        end_time: Math.floor(Date.now() / 1000) + 3600
      },
      {
        event_id: 'test_raid_2',
        special_enemy_type: '1 x Flaming Titan<br />1 x Flaming Mother<br />2 x Flaming Giant Spider<br />1 x Flaming Charred Titan',
        locations: [[1058, 989]],
        end_time: Math.floor(Date.now() / 1000) + 3600
      },
      {
        event_id: 'test_raid_3',
        special_enemy_type: '2 x Titan<br />2 x Mother<br />1 x Wraith',
        locations: [[1029, 1000]],
        end_time: Math.floor(Date.now() / 1000) + 3600
      }
    ];

    if (preview) {
      console.log('--- PREVIEW TESTE BOSS EMBED ---');
      console.log(JSON.stringify(createBossEmbed('Pumpkin Queen', testBossEntry), null, 2));
      console.log('--- PREVIEW TESTE RAIDS CONSOLIDADO ---');
      console.log(consolidatedRaidMessage(testRaids));
    } else {
      await publishEmbed(createBossEmbed('Pumpkin Queen', testBossEntry));
      await publishText(consolidatedRaidMessage(testRaids));
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
