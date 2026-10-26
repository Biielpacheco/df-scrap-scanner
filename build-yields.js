const pages = [
  'Melee Weapons',
  'Chainsaws',
  'Pistols',
  'Rifles',
  'Assault Rifles',
  'Sub-Machine Guns',
  'Machine Guns',
  'Heavy Machine Guns',
  'Shotguns',
  'Grenade Launchers',
  'Flamethrowers',
  'Armour',
  'Strength Armour',
  'Agility Armour',
  'Endurance Armour',
  'Limited Edition Armour',
  'Limited Edition Weapons',
  'Special Armour',
  'Event Weapons'
];

function parseDismantle(raw) {
  const text = raw.replace(/<[^>]+>/g, '').replace(/\[\[|\]\]/g, '').trim();
  const mult = /x\s*(\d+)\s*$/i.exec(text);
  const count = mult ? Number(mult[1]) : 1;
  const name = text.replace(/x\s*\d+\s*$/i, '').trim().toLowerCase();
  if (name === 'rare metal bar') return { kind: 'rare', count: 3 * count };
  if (name === 'rare metal scrap') return { kind: 'rare', count };
  if (name === 'uncommon metal bar') return { kind: 'uncommon', count: 3 * count };
  if (name === 'uncommon metal scrap') return { kind: 'uncommon', count };
  return null;
}

async function load(page) {
  const url = 'https://deadfrontier.fandom.com/api.php?action=parse&page=' + encodeURIComponent(page) + '&prop=wikitext&format=json';
  const response = await fetch(url);
  const data = await response.json();
  if (!data.parse) return [];
  const text = data.parse.wikitext['*'];
  const rows = [];
  for (const block of text.split('{{Item').slice(1)) {
    const name = (block.match(/Item Name\s*=\s*([^\n|]+)/) || [])[1];
    const dismantle = (block.match(/Dismantle\s*=\s*([^\n|]+)/) || [])[1];
    if (!name || !dismantle) continue;
    const yieldInfo = parseDismantle(dismantle);
    if (!yieldInfo) continue;
    rows.push({ name: name.trim(), ...yieldInfo });
  }
  return rows;
}

(async () => {
  const byName = new Map();
  for (const page of pages) {
    const rows = await load(page);
    console.log(page, rows.length);
    for (const row of rows) byName.set(row.name, row);
  }
  const yields = {};
  for (const row of byName.values()) yields[row.name] = { kind: row.kind, count: row.count };
  const fs = require('fs');
  fs.writeFileSync(__dirname + '/yields.json', JSON.stringify(yields, null, 2));
  for (const name of ['Jackhammer 10G', 'Ace Barrel GZ3', 'Piercer', 'Nodachi', 'Wakizashi', 'Stell AUG', 'Kris', 'Greyhawk 55', 'Mirage S8', 'Ironsight 33-F', 'Uziel 14mm', 'Steel 090', 'SN-42', 'IOTV Hard Plate']) {
    console.log(name, yields[name] || 'MISSING');
  }
  console.log('total', Object.keys(yields).length);
})();
