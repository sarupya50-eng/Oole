require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const crypto = require('crypto');
const store = require('./db');
const vps = require('./vps');
const TIERS = require('./tiers');

const PREFIX = process.env.PREFIX || 'ph?';
const GUILD_ID = process.env.GUILD_ID;
const USAGE_RATIO = parseFloat(process.env.USAGE_LIMIT_RATIO || String(20 / 24)); // suspend at 20/24 used
const INTERVAL = parseInt(process.env.CHECK_INTERVAL_SEC || '60', 10) * 1000;
const OWNERS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const COLOR = 0x5ac8fa;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const inviteCache = new Map();
const busy = new Set();

const embed = (title, desc) => new EmbedBuilder().setColor(COLOR).setTitle(title).setDescription(desc);
const dm = (id, e) => client.users.fetch(id).then(u => u.send({ embeds: [e] })).catch(() => {});
const sourcesOf = (row) => (row.boost_sources || '').split(',').filter(Boolean);
const usageLimit = (row) => row.ram_gb * USAGE_RATIO;

// ---------- helpers ----------
async function isBoosting(userId) {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    const m = await guild.members.fetch(userId);
    return !!m.premiumSince;
  } catch { return false; }
}

async function boostingAmong(ids) {
  let n = 0;
  for (const id of ids) if (await isBoosting(id)) n++;
  return n;
}

// own account + linked alts that are boosting right now and not already backing another VPS
async function boostCandidates(uid) {
  const ids = [uid, ...store.getAltLinks(uid).map(l => l.booster_id)];
  const out = [];
  for (const id of ids) if (await isBoosting(id) && !store.boostSourceUsed(id)) out.push(id);
  return out;
}

async function evaluate(row) {
  const tier = TIERS[row.tier];
  if (row.type === 'manual') return { ok: true };
  if (row.type === 'invite') {
    const n = store.countInvites(GUILD_ID, row.user_id);
    return n >= tier.invites
      ? { ok: true }
      : { ok: false, reason: 'invites', note: `You have **${n}/${tier.invites}** invites (${tier.invites - n} short).` };
  }
  const n = await boostingAmong(sourcesOf(row));
  return n >= tier.boosts
    ? { ok: true }
    : { ok: false, reason: 'boost', note: `Only **${n}/${tier.boosts}** boosts are active. A boost expired or was removed.` };
}

async function suspend(row, reason, note) {
  await vps.stop(row.name);
  store.setStatus(row.user_id, 'suspended', reason);
  dm(row.user_id, embed('⛔ VPS suspended', `${note}\n\nYour data is safe, nothing was deleted.\n` + suspendHelp({ ...row, reason })));
}

async function unsuspend(row) {
  await vps.start(row.name).catch(() => {});
  store.setStatus(row.user_id, 'active', null);
  dm(row.user_id, embed('✅ VPS unsuspended', 'Requirement met again. Your VPS is back online.'));
}

function suspendHelp(row) {
  const t = TIERS[row.tier];
  if (row.reason === 'invites') return `Get back to ${t.invites} invites and it unsuspends automatically.`;
  if (row.reason === 'boost') return `Get back to ${t.boosts} active boosts and it unsuspends automatically.`;
  return 'Contact staff.';
}

async function check(row) {
  if (busy.has(row.user_id)) return;
  busy.add(row.user_id);
  try {
    const fresh = store.getVps(row.user_id);
    if (!fresh) return;
    const req = await evaluate(fresh);
    if (fresh.status === 'active') {
      if (!req.ok) return await suspend(fresh, req.reason, req.note);
      const used = await vps.usageGb(fresh.name).catch(() => 0);
      if (used >= usageLimit(fresh)) {
        return await suspend(fresh, 'usage', `Usage reached **${used.toFixed(1)} GB** (limit ${usageLimit(fresh).toFixed(0)} GB of ${fresh.ram_gb} GB).`);
      }
    } else if (fresh.reason === 'invites' || fresh.reason === 'boost') {
      if (req.ok) await unsuspend(fresh);
    }
    // 'usage' / 'admin' suspensions lift only via staff (ph?unsuspend)
  } catch (e) {
    console.error('check failed', row.user_id, e.message);
  } finally {
    busy.delete(row.user_id);
  }
}

const checkUser = (id) => { const r = store.getVps(id); if (r) check(r); };

// ---------- invite tracking ----------
async function cacheGuildInvites(guild) {
  const invites = await guild.invites.fetch().catch(() => null);
  if (invites) inviteCache.set(guild.id, new Map(invites.map(i => [i.code, i.uses])));
}

client.on('inviteCreate', (i) => {
  const c = inviteCache.get(i.guild.id) || new Map();
  c.set(i.code, i.uses || 0);
  inviteCache.set(i.guild.id, c);
});
client.on('inviteDelete', (i) => inviteCache.get(i.guild.id)?.delete(i.code));

client.on('guildMemberAdd', async (member) => {
  if (member.guild.id !== GUILD_ID || member.user.bot) return;
  const invites = await member.guild.invites.fetch().catch(() => null);
  if (!invites) return;
  const old = inviteCache.get(member.guild.id) || new Map();
  const used = invites.find(i => i.uses > (old.get(i.code) || 0));
  inviteCache.set(member.guild.id, new Map(invites.map(i => [i.code, i.uses])));
  if (used?.inviter && used.inviter.id !== member.id) {
    store.upsertJoin(member.guild.id, member.id, used.inviter.id);
    checkUser(used.inviter.id);
  }
});

client.on('guildMemberRemove', (member) => {
  if (member.guild.id !== GUILD_ID) return;
  const inviter = store.markLeft(member.guild.id, member.id);
  if (inviter) checkUser(inviter);
  for (const r of store.allVps()) if (sourcesOf(r).includes(member.id)) checkUser(r.user_id);
});

client.on('guildMemberUpdate', (oldM, newM) => {
  if (newM.guild.id !== GUILD_ID) return;
  if (!!oldM.premiumSince !== !!newM.premiumSince) {
    for (const r of store.allVps()) if (sourcesOf(r).includes(newM.id)) checkUser(r.user_id);
  }
});

// ---------- provisioning ----------
async function provision(user, tierKey, type, sources) {
  const t = TIERS[tierKey];
  const name = `ph-${user.id}`;
  const { password } = await vps.create({ name, ram: t.ram, cpu: t.cpu, disk: t.disk });
  store.insertVps({
    user_id: user.id, name, tier: tierKey, type,
    boost_sources: sources.join(','), ram_gb: t.ram, created_at: Date.now(),
  });
  const keep = type === 'invite' ? `${t.invites} invites` : type === 'boost' ? `${t.boosts} active boosts` : 'staff approval';
  await user.send({ embeds: [embed(`Your ${t.name} VPS is ready`,
    `**RAM:** ${t.ram} GB · **CPU:** ${t.cpu} vCores · **Disk:** ${t.disk} GB (KVM)\n**Instance:** \`${name}\`\n**Root password:** ||${password}||\n\nKeep **${keep}** or it gets suspended.`)] })
    .catch(() => {});
}

// ---------- commands ----------
function tierList() {
  return Object.entries(TIERS).map(([k, t]) =>
    `**${t.name}** (\`${k}\`) · ${t.invites} invites / ${t.boosts} boosts\n${t.ram} GB RAM · ${t.cpu} vCores · ${t.disk} GB disk`).join('\n\n');
}

async function cmdHelp(msg) {
  msg.reply({ embeds: [embed('PhoenixCloud Rewards', [
    tierList(), '',
    `**${PREFIX}invites** · your valid invite count`,
    `**${PREFIX}claim <plan>** · e.g. \`${PREFIX}claim s-24\``,
    `**${PREFIX}alt** · boosting from another account? link it`,
    `**${PREFIX}verify <code>** · finish alt linking`,
    `**${PREFIX}vps** · manage your VPS`,
  ].join('\n'))] });
}

async function cmdInvites(msg) {
  const n = store.countInvites(GUILD_ID, msg.author.id);
  const b = (await boostCandidates(msg.author.id)).length;
  msg.reply({ embeds: [embed('Your progress', `Valid invites: **${n}**\nBoosting accounts (yours + linked alts): **${b}**`)] });
}

async function cmdClaim(msg, args) {
  const uid = msg.author.id;
  const key = (args[0] || '').toLowerCase();
  const t = TIERS[key];
  if (!t) return msg.reply({ embeds: [embed('Pick a plan', `${tierList()}\n\nUse \`${PREFIX}claim s-24\``)] });
  if (store.getVps(uid)) return msg.reply('You already have a VPS. Use `' + PREFIX + 'vps`.');
  if (busy.has(uid)) return msg.reply('Hold on, already working on it.');

  const invites = store.countInvites(GUILD_ID, uid);
  const boosters = await boostCandidates(uid);
  let type = null, sources = [];
  if (invites >= t.invites) type = 'invite';
  else if (boosters.length >= t.boosts) { type = 'boost'; sources = boosters.slice(0, t.boosts); }

  if (!type) {
    return msg.reply(`Not eligible for **${t.name}**.\nNeed **${t.invites} invites** (you have ${invites}) or **${t.boosts} boosts** (you have ${boosters.length} boosting accounts).\nMore accounts boosting? Use \`${PREFIX}alt\`.`);
  }

  busy.add(uid);
  const status = await msg.reply('Creating your VPS... this can take a minute.');
  try {
    await provision(msg.author, key, type, sources);
    status.edit('✅ VPS created. Check your DMs (open them if you did not get one, then run `' + PREFIX + 'vps`).');
  } catch (e) {
    console.error(e);
    status.edit('Failed to create VPS: ' + e.message.slice(0, 200));
  } finally {
    busy.delete(uid);
  }
}

async function cmdAlt(msg) {
  const uid = msg.author.id;
  await msg.reply('Send the **user ID** of the account that boosted the server (60s).');
  const got = await msg.channel.awaitMessages({ filter: m => m.author.id === uid, max: 1, time: 60000 }).catch(() => null);
  const input = got?.first()?.content.trim().replace(/[<@!>]/g, '');
  if (!input) return msg.channel.send('Timed out.');
  if (!/^\d{17,20}$/.test(input)) return msg.channel.send('That is not a valid user ID.');
  if (input === uid) return msg.channel.send('That is your own account. Just use `' + PREFIX + 'claim`.');
  if (!(await isBoosting(input))) return msg.channel.send('That account is not currently boosting this server.');
  if (store.boostSourceUsed(input) || store.boosterLinked(input)) return msg.channel.send('That boost is already used for another VPS.');

  const code = crypto.randomInt(100000, 999999).toString();
  const sent = await client.users.fetch(input).then(u => u.send({ embeds: [embed('Boost link request',
    `<@${uid}> (${msg.author.tag}) wants to use your boost for a VPS.\n\nCode: **${code}**\n\nOnly share it if it is really you or your alt. Expires in 10 minutes.`)] })).then(() => true).catch(() => false);
  if (!sent) return msg.channel.send('I could not DM that account. Make sure its DMs are open.');
  store.saveCode(code, uid, input);
  msg.channel.send(`Code sent to that account's DMs. Get it, then run \`${PREFIX}verify <code>\`.`);
}

async function cmdVerify(msg, args) {
  const code = (args[0] || '').trim();
  const row = code && store.getCode(code);
  if (!row || row.claimer_id !== msg.author.id) return msg.reply('Invalid code.');
  if (row.expires_at < Date.now()) { store.delCode(code); return msg.reply('Code expired. Run `' + PREFIX + 'alt` again.'); }
  if (!(await isBoosting(row.booster_id))) { store.delCode(code); return msg.reply('That account is no longer boosting.'); }
  if (store.boosterLinked(row.booster_id) || store.boostSourceUsed(row.booster_id)) { store.delCode(code); return msg.reply('That boost is already used.'); }
  store.setAltLink(msg.author.id, row.booster_id);
  store.delCode(code);
  msg.reply(`✅ Linked. Run \`${PREFIX}invites\` to see your boost count, then \`${PREFIX}claim <plan>\`.`);
}

function vpsButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('vps:start').setLabel('Start').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('vps:stop').setLabel('Stop').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('vps:restart').setLabel('Restart').setStyle(ButtonStyle.Primary),
  );
}

async function cmdVps(msg) {
  const row = store.getVps(msg.author.id);
  if (!row) return msg.reply(`You have no VPS. Use \`${PREFIX}claim <plan>\`.`);
  if (row.status === 'suspended') {
    return msg.reply({ embeds: [embed('⛔ Your VPS is suspended', `Reason: **${row.reason}**\n${suspendHelp(row)}\nYour data is kept.`)] });
  }
  const t = TIERS[row.tier];
  const used = await vps.usageGb(row.name).catch(() => 0);
  msg.reply({
    embeds: [embed(`Your ${t.name} VPS`, `**Instance:** \`${row.name}\`\n**Specs:** ${t.ram} GB RAM · ${t.cpu} vCores · ${t.disk} GB disk\n**Usage:** ${used.toFixed(1)} GB (suspends at ${usageLimit(row).toFixed(0)} GB)`)],
    components: [vpsButtons()],
  });
}

client.on('interactionCreate', async (i) => {
  if (!i.isButton() || !i.customId.startsWith('vps:')) return;
  const row = store.getVps(i.user.id);
  if (!row) return i.reply({ content: 'You have no VPS.', ephemeral: true });
  if (row.status === 'suspended') {
    return i.reply({ content: `⛔ Your VPS is suspended (${row.reason}). ${suspendHelp(row)}`, ephemeral: true });
  }
  await i.deferReply({ ephemeral: true });
  try {
    const action = i.customId.split(':')[1];
    await vps[action](row.name);
    i.editReply(`Done: ${action}.`);
  } catch (e) { i.editReply('Failed: ' + e.message.slice(0, 200)); }
});

// ---------- owner commands ----------
async function ownerCmd(msg, cmd, args) {
  const target = msg.mentions.users.first();
  if (!target) return msg.reply('Mention a user.');
  if (cmd === 'grant') {
    // for cases the API cannot see, e.g. one account with 2 boosts: ph?grant @user s-24
    const key = (args.find(a => TIERS[a.toLowerCase()]) || '').toLowerCase();
    if (!key) return msg.reply('Usage: `' + PREFIX + 'grant @user s-24`');
    if (store.getVps(target.id)) return msg.reply('That user already has a VPS.');
    const s = await msg.reply('Creating...');
    try { await provision(target, key, 'manual', []); s.edit('Granted.'); } catch (e) { s.edit('Failed: ' + e.message.slice(0, 200)); }
    return;
  }
  const row = store.getVps(target.id);
  if (!row) return msg.reply('That user has no VPS.');
  if (cmd === 'unsuspend') { await unsuspend(row); return msg.reply('Unsuspended.'); }
  if (cmd === 'suspend') { await suspend(row, 'admin', 'Suspended by staff.'); return msg.reply('Suspended.'); }
  if (cmd === 'deletevps') { await vps.deleteVps(row.name).catch(() => {}); store.deleteVps(target.id); return msg.reply('Deleted.'); }
}

client.on('messageCreate', async (msg) => {
  if (msg.author.bot || !msg.guild || msg.guild.id !== GUILD_ID || !msg.content.startsWith(PREFIX)) return;
  const [cmd, ...args] = msg.content.slice(PREFIX.length).trim().split(/\s+/);
  try {
    switch (cmd.toLowerCase()) {
      case 'help': return cmdHelp(msg);
      case 'invites': return cmdInvites(msg);
      case 'claim': return cmdClaim(msg, args);
      case 'alt': return cmdAlt(msg);
      case 'verify': return cmdVerify(msg, args);
      case 'vps': return cmdVps(msg);
      case 'unsuspend': case 'suspend': case 'deletevps': case 'grant':
        if (!OWNERS.includes(msg.author.id)) return;
        return ownerCmd(msg, cmd.toLowerCase(), args);
    }
  } catch (e) { console.error(e); msg.reply('Something went wrong.').catch(() => {}); }
});

// ---------- boot ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.members.fetch();
  await cacheGuildInvites(guild);
  const sweep = () => store.allVps().forEach(check);
  sweep();
  setInterval(sweep, INTERVAL);
});

client.login(process.env.TOKEN);
