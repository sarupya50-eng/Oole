const Database = require('better-sqlite3');
const db = new Database('rewards.db');
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS joins (
  guild_id   TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  inviter_id TEXT NOT NULL,
  left       INTEGER NOT NULL DEFAULT 0,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_joins_inviter ON joins (guild_id, inviter_id, left);

CREATE TABLE IF NOT EXISTS vps (
  user_id       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  tier          TEXT NOT NULL,         -- 's-24' | 's-32' | 's-48'
  type          TEXT NOT NULL,         -- 'invite' | 'boost' | 'manual'
  boost_sources TEXT,                  -- comma-separated booster user ids
  ram_gb        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'suspended'
  reason        TEXT,                  -- 'invites' | 'boost' | 'usage' | 'admin'
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alt_codes (
  code       TEXT PRIMARY KEY,
  claimer_id TEXT NOT NULL,
  booster_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alt_links (
  claimer_id TEXT NOT NULL,
  booster_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (claimer_id, booster_id)
);
`);

module.exports = {
  db,
  // invites
  upsertJoin: (g, m, inv) =>
    db.prepare(`INSERT INTO joins (guild_id, member_id, inviter_id, left, joined_at)
                VALUES (?, ?, ?, 0, ?)
                ON CONFLICT(guild_id, member_id) DO UPDATE SET inviter_id = excluded.inviter_id, left = 0, joined_at = excluded.joined_at`)
      .run(g, m, inv, Date.now()),
  markLeft: (g, m) => {
    const row = db.prepare('SELECT inviter_id FROM joins WHERE guild_id = ? AND member_id = ? AND left = 0').get(g, m);
    if (row) db.prepare('UPDATE joins SET left = 1 WHERE guild_id = ? AND member_id = ?').run(g, m);
    return row ? row.inviter_id : null;
  },
  countInvites: (g, inv) =>
    db.prepare('SELECT COUNT(*) c FROM joins WHERE guild_id = ? AND inviter_id = ? AND left = 0').get(g, inv).c,
  // vps
  getVps: (u) => db.prepare('SELECT * FROM vps WHERE user_id = ?').get(u),
  allVps: () => db.prepare('SELECT * FROM vps').all(),
  boostSourceUsed: (b) =>
    db.prepare("SELECT 1 FROM vps WHERE (',' || boost_sources || ',') LIKE ?").get(`%,${b},%`),
  insertVps: (v) =>
    db.prepare(`INSERT INTO vps (user_id, name, tier, type, boost_sources, ram_gb, status, created_at)
                VALUES (@user_id, @name, @tier, @type, @boost_sources, @ram_gb, 'active', @created_at)`).run(v),
  setStatus: (u, status, reason) =>
    db.prepare('UPDATE vps SET status = ?, reason = ? WHERE user_id = ?').run(status, reason, u),
  deleteVps: (u) => db.prepare('DELETE FROM vps WHERE user_id = ?').run(u),
  // alt
  saveCode: (code, claimer, booster) =>
    db.prepare('INSERT OR REPLACE INTO alt_codes (code, claimer_id, booster_id, expires_at) VALUES (?, ?, ?, ?)')
      .run(code, claimer, booster, Date.now() + 10 * 60 * 1000),
  getCode: (code) => db.prepare('SELECT * FROM alt_codes WHERE code = ?').get(code),
  delCode: (code) => db.prepare('DELETE FROM alt_codes WHERE code = ?').run(code),
  getAltLinks: (c) => db.prepare('SELECT * FROM alt_links WHERE claimer_id = ?').all(c),
  boosterLinked: (b) => db.prepare('SELECT 1 FROM alt_links WHERE booster_id = ?').get(b),
  setAltLink: (c, b) => db.prepare('INSERT OR IGNORE INTO alt_links (claimer_id, booster_id) VALUES (?, ?)').run(c, b),
};
