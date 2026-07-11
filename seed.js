/**
 * seed.js — reset the database and load a FULLER demo with random example guests.
 * Run:  npm run seed      (safe: rebuilds data/cards.db from scratch)
 *
 * Names are randomly generated (not real interns). The data includes a spread of
 * issued / returned / missing cards, plus a few deliberately incomplete rows
 * (missing staff name, missing date) to demonstrate the roster-gap warnings.
 */
const fs = require('fs');
const path = require('path');

// wipe existing db so seeding is deterministic
const DATA_DIR = path.join(__dirname, 'data');
for (const f of ['cards.db', 'cards.db-wal', 'cards.db-shm']) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) fs.rmSync(p);
}

const { initSchema, run, get, tx } = require('./db');
initSchema();

// ─── deterministic RNG so the demo is reproducible ──
let _s = 1337;
const rnd = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const chance = p => rnd() < p;
const pad = (n, w = 2) => String(n).padStart(w, '0');

const FIRST = ['Aisha','Marcus','Priya','Diego','Chloe','Andre','Sofia','Ethan','Nia','Liam',
    'Yuki','Omar','Isabella','Malik','Hana','Noah','Zoe','Rahul','Camila','Jamal',
    'Elena','Kofi','Mei','Tariq','Grace','Ivan','Layla','Sean','Fatima','Diego',
    'Amara','Ben','Aaron','Carlos','Dana','Emeka','Farah','Gabe','Hina','Ravi',
    'Jade','Kian','Lucia','Mateo','Nadia','Oscar','Paula','Quinn','Rosa','Simone'];
const LAST = ['Nguyen','Patel','Okafor','Reyes','Chen','Johnson','Kim','Silva','Ahmed','Brooks',
    'Torres','Adeyemi','Rossi','Haddad','Nakamura','Delgado','OBrien','Mensah','Kaur','Petrov',
    'Santos','Cohen','Ali','Bauer','Costa','Duarte','Ellis','Farooq','Green','Hassan',
    'Ibrahim','Jansen','Kowalski','Lopez','Meyer','Novak','Owens','Park','Quintero','Ramos',
    'Sato','Thompson','Uddin','Vargas','Weber','Xu','Yamada','Zhang','Bello','Cruz'];

const STAFF = ['Ayon Rahman', 'Front Desk', 'Security', 'Supervisor', 'Maya P.', 'Kai L.'];
const REASONS = [null, 'Lockout', 'Locked out', 'Lost original', 'Late arrival', null, null];

// ─── group definitions (building + room + card style) ──
const GROUPS = [
    { name: 'BISM',                    n: 16, cards: 12, cardPfx: 'RL',    room: () => `SAS${int(11,35)}_${pick(['A','B','C','D'])}`, bldg: 'SAS' },
    { name: 'CWIT',                    n: 14, cards: 10, cardPfx: 'CONFC', room: () => `${int(200,299)}`, bldg: 'Patapsco' },
    { name: 'Meyerhoff Summer Bridge', n: 18, cards: 14, cardPfx: 'RL',    room: () => `${int(100,399)}`, bldg: 'Patapsco Hall' },
    { name: 'Interns',                 n: 15, cards: 12, cardPfx: 'RL',    room: () => `${pick(['ANT','GUN','TER'])}${int(20,40)}_${pick(['A','B','C','D'])}`, bldg: 'Interns' },
    { name: 'Young Artists of America',n: 16, cards: 11, cardPfx: 'CONFX', room: () => `${int(100,250)}`, bldg: 'Susquehanna' },
    { name: 'Constellation STEM',      n: 15, cards: 10, cardPfx: 'RL',    room: () => `HAR${int(10,40)}_${pick(['A','B'])}`, bldg: 'Harbor' },
];

// ─── build conferences, guests, cards ──
const world = [];
let cardSeq = 60;   // running card number so numbers look non-sequential per group

tx(() => {
    for (const g of GROUPS) {
        const confId = run('INSERT INTO conferences (name) VALUES (?)', g.name).lastInsertRowid;

        const cardIds = [];
        for (let i = 0; i < g.cards; i++) {
            cardSeq += int(1, 4);
            const num = `${g.cardPfx}${pad(cardSeq, 5)}`;
            const id = run(
                'INSERT INTO cards (conference_id,card_number,status,available,notes) VALUES (?,?,?,1,?)',
                confId, num, 'listed', 'Seen in roster').lastInsertRowid;
            cardIds.push({ id, num });
        }

        const guestIds = [];
        const usedRooms = new Set();
        for (let i = 0; i < g.n; i++) {
            let room; let tries = 0;
            do { room = g.room(); tries++; } while (usedRooms.has(room) && tries < 8);
            usedRooms.add(room);
            const fn = pick(FIRST), ln = pick(LAST);
            const id = run(
                `INSERT INTO guests (conference_id,first_name,last_name,building,room_number)
                 VALUES (?,?,?,?,?)`, confId, fn, ln, g.bldg, room).lastInsertRowid;
            guestIds.push(id);
        }

        world.push({ confId, cardIds, guestIds });
    }
});

// ─── helpers that mirror the app's transactional writes ──
const cardsOut = guestId =>
    get(`SELECT COUNT(*) AS n FROM cards WHERE current_guest_id=? AND status<>'missing'`, guestId).n;

function issue(confId, card, guestId, { staff, reason, when }) {
    tx(() => {
        run(`INSERT INTO temp_card_log
                (guest_id,conference_id,action,card_number,reason,staff_name,action_time,is_active,edited_in_app)
             VALUES (?,?,'issued',?,?,?,?,1,0)`,
            guestId, confId, card.num, reason || null, staff, when);
        run('UPDATE cards SET available=0, current_guest_id=? WHERE id=?', guestId, card.id);
    });
}

function returnCard(confId, card, guestId, staff) {
    tx(() => {
        const active = get(`SELECT id FROM temp_card_log
            WHERE guest_id=? AND action='issued' AND is_active=1 AND card_number=? ORDER BY id DESC LIMIT 1`,
            guestId, card.num);
        if (active) run('UPDATE temp_card_log SET is_active=0 WHERE id=?', active.id);
        run(`INSERT INTO temp_card_log
                (guest_id,conference_id,action,card_number,staff_name,action_time,is_active,edited_in_app)
             VALUES (?,?,'returned',?,?,datetime('now','localtime'),0,0)`,
            guestId, confId, card.num, staff);
        run(`UPDATE cards SET available=1, current_guest_id=NULL WHERE id=?`, card.id);
    });
}

// a LOCAL timestamp N hours ago, formatted for SQLite (matches datetime('now','localtime'))
const hoursAgo = h => {
    const d = new Date(Date.now() - h * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
           `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// ─── generate a realistic spread of activity ──
for (const grp of world) {
    // shuffle cards, take ~45% to be issued
    const shuffled = [...grp.cardIds].sort(() => rnd() - 0.5);
    const outN = Math.floor(grp.cardIds.length * 0.45);

    for (let i = 0; i < outN; i++) {
        const card = shuffled[i];
        // choose a guest with < 3 cards
        let guestId, tries = 0;
        do { guestId = pick(grp.guestIds); tries++; } while (cardsOut(guestId) >= 3 && tries < 10);
        if (cardsOut(guestId) >= 3) continue;

        // ~15% missing staff, ~15% missing date — to showcase the warnings
        const staff = chance(0.15) ? 'MISSING STAFF' : pick(STAFF);
        const when = chance(0.15) ? null : hoursAgo(int(1, 40));
        issue(grp.confId, card, guestId, { staff, reason: pick(REASONS), when });

        // ~35% of issued cards then get returned (full lifecycle in the log)
        if (chance(0.35)) returnCard(grp.confId, card, guestId, pick(STAFF));
    }

    // mark ~1 still-available card missing in some groups
    if (chance(0.6)) {
        const stillListed = get(`SELECT id, card_number FROM cards
            WHERE conference_id=? AND available=1 AND status='listed' LIMIT 1`, grp.confId);
        if (stillListed)
            run(`UPDATE cards SET status='missing', available=0,
                    notes='Auto-marked missing: out more than 2 days'
                 WHERE id=?`, stillListed.id);
    }
}

// ─── a few sample data-quality issues (so the Data Issues tab demos without a real import) ──
const sampleIssues = [
    ['Interns', 'junk_card', 'error', 'Reslife 00070', 'Temp-card cell is not a card number: "Reslife 00070"', 'Did you mean RL00070?'],
    ['Harlem Lacrosse', 'junk_card', 'error', 'CONFX 00053, 6/24, 4:43PM. Checked out temp card at 6:12pm', 'A whole note was typed into the temp-card cell', null],
    ['Interns', 'unknown_card', 'error', 'RL00062', 'Card "RL00062" is not in any group\'s inventory list', null],
    ['Meyerhoff Summer Bridge', 'unknown_card', 'error', 'RL00483', 'Card "RL00483" is not in any group\'s inventory list', null],
    ['CWIT', 'missing_date', 'warn', null, 'No issue date for card CONFC00061', null],
    ['BISM', 'missing_staff', 'warn', null, 'No staff name for card RL00523', null],
    ['Interns', 'time_only_date', 'warn', '17:40:49.291000', 'Only a time (no date) for card RL01319: "17:40:49.291000"', null],
    ['Interns', 'bad_date', 'warn', 'unsure', 'Unreadable date for card RL01334: "unsure"', null],
    ['CWIT', 'unknown_staff', 'warn', 'Bob', 'Staff "Bob" is not in the known staff list', null],
    ['Constellation STEM', 'missing_room', 'warn', null, 'A guest has no room number in the roster', null],
    ['Meyerhoff Summer Bridge', 'card_note', 'info', 'RL00490(broken)', 'Card RL00490 note: "broken"', null],
    ['Interns', 'borrowed_card', 'info', 'CONFC00066', 'Card CONFC00066 was issued here but belongs to Young Artists of America (borrowed)', null],
];
for (const [sheet, type, sev, raw, msg, sug] of sampleIssues)
    run(`INSERT INTO data_issues (sheet_name,field,issue_type,severity,raw_value,message,suggestion)
         VALUES (?,?,?,?,?,?,?)`, sheet, 'card', type, sev, raw, msg, sug);

const s = get(`SELECT
    (SELECT COUNT(*) FROM conferences) AS groups,
    (SELECT COUNT(*) FROM guests)      AS guests,
    (SELECT COUNT(*) FROM cards)       AS cards,
    (SELECT COUNT(*) FROM cards WHERE available=0 AND status<>'missing') AS out,
    (SELECT COUNT(*) FROM cards WHERE status='missing') AS missing,
    (SELECT COUNT(*) FROM temp_card_log) AS log_rows,
    (SELECT COUNT(*) FROM temp_card_log WHERE staff_name='MISSING STAFF') AS missing_staff,
    (SELECT COUNT(*) FROM temp_card_log WHERE action='issued' AND is_active=1 AND action_time IS NULL) AS missing_date`);

console.log('Seed complete:',
    `${s.groups} groups, ${s.guests} guests, ${s.cards} cards, ${s.out} out, ${s.missing} missing.`);
console.log(`  log rows: ${s.log_rows} | flagged: ${s.missing_staff} missing-staff, ${s.missing_date} missing-date`);
