const fs = require('fs');
const path = require('path');

const root = __dirname;
const configPath = path.join(root, 'config.json');
const config = {
  bossWebhookUrl: process.env.BOSS_WEBHOOK_URL || '',
  bossRoleId: process.env.BOSS_ROLE_ID || ''
};
if (fs.existsSync(configPath)) {
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (saved.bossWebhookUrl) config.bossWebhookUrl = saved.bossWebhookUrl;
  if (saved.bossRoleId) config.bossRoleId = saved.bossRoleId;
}
if (process.env.BOSS_WEBHOOK_URL) config.bossWebhookUrl = process.env.BOSS_WEBHOOK_URL;
if (process.env.BOSS_ROLE_ID) config.bossRoleId = process.env.BOSS_ROLE_ID;

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

function createEmbed(boss, entry) {
  const isPumpkin = /pumpkin/i.test(boss);
  const color = isPumpkin ? 0xff7518 : 0x9b59b6;
  const places = (entry.locations || [])
    .slice(0, 4)
    .map(pair => `\`${pair[0]} x ${pair[1]}\``)
    .join('  •  ') || 'Desconhecido';
  const label = String(entry.special_enemy_type).replace(/<br\s*\/?>/gi, ', ');
  const end = Number(entry.end_time);

  const fields = [
    { name: '📍 Coordenadas', value: places, inline: true },
    { name: '🧟 Inimigo', value: label, inline: true }
  ];
  if (end) {
    fields.push({ name: '⏳ Tempo Restante', value: `<t:${end}:R> (<t:${end}:T>)`, inline: false });
  }
  fields.push({ name: '🗺️ Mapa ao Vivo', value: '[Abrir Mapa no DFProfiler](https://www.dfprofiler.com/bossmap)', inline: false });

  const spTime = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return {
    title: isPumpkin ? `🎃 ${boss.toUpperCase()} DETECTADA!` : `🚨 ${boss.toUpperCase()} DETECTADO!`,
    description: `**Atenção ${getMention()}!** Chefe especial ativo no mapa agora!`,
    color,
    fields,
    footer: { text: `DFProfiler Boss Alert • Detectado às ${spTime} (Brasília)` },
    timestamp: new Date().toISOString()
  };
}

async function publish(boss, entry) {
  const embed = createEmbed(boss, entry);
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
  if (!response.ok) throw new Error('Discord recusou o webhook: ' + response.statusText);
}

async function checkBosses(state) {
  const data = await loadMap();
  const sent = new Set(state.sent);
  let posted = 0;
  for (const entry of Object.values(data)) {
    if (!entry || entry.ended === '1') continue;
    const boss = wanted(entry);
    if (!boss || !entry.event_id || sent.has(entry.event_id)) continue;
    
    if (preview) {
      console.log('--- ALERTA GERADO (PREVIEW) ---');
      console.log(JSON.stringify(createEmbed(boss, entry), null, 2));
    } else {
      await publish(boss, entry);
    }
    sent.add(entry.event_id);
    posted += 1;
    console.log(`[ALERTA ENVIADO] ${boss} (ID do Evento: ${entry.event_id})`);
  }
  state.sent = [...sent].slice(-50);
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
    console.log('Enviando alerta de teste para o Discord...');
    const testEntry = {
      event_id: 'test_' + Date.now(),
      special_enemy_type: '1 x Pumpkin Queen (Teste de Configuração)',
      locations: [[1050, 986]],
      end_time: Math.floor(Date.now() / 1000) + 1800
    };
    await publish('Pumpkin Queen', testEntry);
    console.log('Alerta de teste enviado com sucesso!');
  }
  
  if (loop) {
    console.log('Iniciando Vigia Contínuo de Bosses (checagem a cada 45 segundos)...');
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
  console.log(posted ? 'Avisos enviados: ' + posted : 'Nenhum boss desejado ativo no mapa.');
}

main().catch(error => {
  console.log('Falhou: ' + error.message);
  process.exit(1);
});
