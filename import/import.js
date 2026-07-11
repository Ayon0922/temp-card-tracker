/**
 * import.js — ONE-WAY roster importer (Excel / Google Sheet -> SQLite).
 *
 *   node --experimental-sqlite import/import.js <file.xlsx> [--reset]
 *   node --experimental-sqlite import/import.js --url <google-export-url> [--reset]
 *
 * READS ONLY. It never writes back to the sheet. It:
 *   1. reads each group's tab (SheetJS)
 *   2. parses guest rows + the bottom-section card inventory
 *   3. classifies every temp-card cell against reference sets (classify.js)
 *   4. loads clean data into SQLite, preserving anything edited in the app
 *   5. records every problem in `data_issues` for staff to fix at the source
 *
 * The live-Google-Sheet phase only changes step 1 (fetch the export URL first).
 */
'use strict';

const path = require('path');
const XLSX = require('xlsx');
const db = require('../db');
const {
    isBlank, clean, matchStaff, normalizeCard, looksLikeCard, resolveCard,
    parseFlexibleDate, canonReason,
} = require('./classify');

// tabs that are templates / not real groups
const SKIP_SHEETS = new Set([
    'Conference Roster Template', 'Training Check in', 'Sheet14_conflict596636926',
]);

// ─── helpers to locate structure inside a raw sheet ──
const norm = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();

function findHeaderRow(rows) {
    for (let i = 0; i < Math.min(6, rows.length); i++)
        if ((rows[i] || []).some(v => typeof v === 'string' && norm(v).includes('first name'))) return i;
    return 0;
}

function colIndex(header, ...needles) {
    for (const nd of needles) {
        for (let j = 0; j < header.length; j++)
            if (typeof header[j] === 'string' && norm(header[j]).includes(nd)) return j;
    }
    return -1;
}

// repeating 5-col blocks anchored on the "Temp Card Issued (Enter Temp Card #)" header
function findCardBlocks(header) {
    const blocks = [];
    for (let j = 0; j < header.length; j++) {
        const h = norm(header[j]);
        if (h.includes('temp card issued') && h.includes('enter temp card')) {
            blocks.push({ card: j, reason: j + 1, staff: j + 2, date: j + 3, returned: j + 4 });
        }
    }
    return blocks;
}

// bottom-section card inventory: find a "temp cards" label, read the column below it
function findInventory(rows) {
    for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < (rows[i] || []).length; j++) {
            const v = rows[i][j];
            if (typeof v === 'string' && ['temp cards', 'temp card', 'tempcards'].includes(norm(v))) {
                const cards = [];
                for (let k = i + 1; k < rows.length; k++) {
                    const cv = rows[k][j];
                    if (isBlank(cv)) { if (cards.length) break; else continue; }
                    cards.push(String(cv).trim());
                }
                if (cards.length) return cards;
            }
        }
    }
    return [];
}

const isReturned = v => {
    if (isBlank(v)) return false;
    const s = String(v).trim().toLowerCase();
    return !['false', '0', 'no', 'n'].includes(s);
};

// ─── main import ───────────────────────────────
function runImport({ file, reset }) {
    db.initSchema();
    if (reset) {
        db.run('DELETE FROM data_issues');
        // fresh roster load for the prototype (keeps schema, clears data)
        db.run('DELETE FROM temp_card_log');
        db.run('DELETE FROM cards');
        db.run('DELETE FROM guests');
        db.run('DELETE FROM conferences');
    }
    db.run('DELETE FROM data_issues');   // issues are always regenerated

    const wb = XLSX.readFile(file);
    const stats = { groups: 0, guests: 0, cards: 0, issued: 0, returned: 0, issues: 0 };
    const issues = [];
    const addIssue = (o) => { issues.push(o); stats.issues++; };

    // ── PASS 1: parse every sheet, load inventories, build a GLOBAL card map ──
    const globalCard = new Map();   // normalized number -> owner sheet name
    const sheets = [];              // parsed structure reused in pass 2

    for (const sheetName of wb.SheetNames) {
        if (SKIP_SHEETS.has(sheetName)) continue;
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: null });
        if (!rows.length) continue;

        const hIdx = findHeaderRow(rows);
        const header = rows[hIdx] || [];
        const fn = colIndex(header, 'first name');
        const ln = colIndex(header, 'last name');
        if (fn < 0 || ln < 0) continue;   // not a roster tab

        const cols = {
            fn, ln,
            bld: colIndex(header, 'building'),
            room: colIndex(header, 'room number', 'room'),
            arr: colIndex(header, 'scheduled arrival'),
            dep: colIndex(header, 'scheduled departure'),
        };
        const blocks = findCardBlocks(header);
        const inventoryRaw = findInventory(rows);

        db.run('INSERT OR IGNORE INTO conferences (name) VALUES (?)', sheetName);
        const conf = db.get('SELECT id FROM conferences WHERE name=?', sheetName);
        stats.groups++;

        const invSet = new Set();
        for (const rawCard of inventoryRaw) {
            const { number, note } = normalizeCard(rawCard);
            if (!number || !looksLikeCard(rawCard)) {
                addIssue({ sheet: sheetName, field: 'inventory', type: 'junk_inventory', sev: 'warn',
                    raw: rawCard, msg: `Bottom card list has a non-card entry: "${rawCard}"` });
                continue;
            }
            invSet.add(number);
            if (!globalCard.has(number)) globalCard.set(number, sheetName);
            const exists = db.get('SELECT id FROM cards WHERE conference_id=? AND card_number=?', conf.id, number);
            if (!exists) {
                db.run(`INSERT INTO cards (conference_id, card_number, status, available, notes)
                        VALUES (?,?,?,1,?)`, conf.id, number, 'listed',
                        note ? `From roster (${note})` : 'From roster');
                stats.cards++;
            }
            if (note) addIssue({ sheet: sheetName, field: 'inventory', type: 'card_note', sev: 'info',
                raw: rawCard, msg: `Card ${number} has a note in the roster: "${note}"` });
        }

        sheets.push({ sheetName, rows, hIdx, cols, blocks, invSet, confId: conf.id });
    }

    // ── PASS 2: process guest rows against the global inventory ──
    for (const S of sheets) {
        const { sheetName, rows, hIdx, cols, blocks, invSet, confId } = S;
        const conf = { id: confId };
        const fn = cols.fn, ln = cols.ln, cBld = cols.bld, cRoom = cols.room, cArr = cols.arr, cDep = cols.dep;

        for (let r = hIdx + 1; r < rows.length; r++) {
            const first = clean(rows[r][fn]);
            const last = clean(rows[r][ln]);
            if (!first || !last) continue;
            const room = cRoom >= 0 ? clean(rows[r][cRoom]) : null;
            const building = cBld >= 0 ? clean(rows[r][cBld]) : null;

            // upsert guest
            let guest = db.get(`SELECT id FROM guests WHERE conference_id=? AND first_name=? AND last_name=?
                                AND IFNULL(room_number,'')=IFNULL(?,'')`, conf.id, first, last, room);
            if (!guest) {
                const gr = db.run(`INSERT INTO guests (conference_id,first_name,last_name,building,room_number,
                                    scheduled_arrival,scheduled_departure) VALUES (?,?,?,?,?,?,?)`,
                    conf.id, first, last, building, room,
                    cArr >= 0 ? clean(rows[r][cArr]) : null, cDep >= 0 ? clean(rows[r][cDep]) : null);
                guest = { id: gr.lastInsertRowid };
                stats.guests++;
            }
            if (!room) addIssue({ sheet: sheetName, guest: `${first} ${last}`, field: 'guest',
                type: 'missing_room', sev: 'warn', raw: null, msg: `${first} ${last} has no room number in the roster` });

            // each temp-card block
            for (const b of blocks) {
                const rawCard = rows[r][b.card];
                const rawReason = b.reason < rows[r].length ? rows[r][b.reason] : null;
                const rawStaff = b.staff < rows[r].length ? rows[r][b.staff] : null;
                const rawDate = b.date < rows[r].length ? rows[r][b.date] : null;
                const rawRet = b.returned < rows[r].length ? rows[r][b.returned] : null;

                if (isBlank(rawCard)) {
                    // entry started but no card #?
                    if (!isBlank(rawStaff) || !isBlank(rawDate))
                        addIssue({ sheet: sheetName, guest: `${first} ${last}`, field: 'card',
                            type: 'entry_without_card', sev: 'warn', raw: null,
                            msg: `${first} ${last}: a temp-card entry has staff/date but no card number` });
                    continue;
                }

                const card = resolveCard(rawCard, invSet);
                const room2 = room;
                if (card.status === 'not_a_card') {
                    addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2, field: 'card',
                        type: 'junk_card', sev: 'error', raw: card.raw,
                        msg: `Temp-card cell is not a card number: "${card.raw}"` });
                    continue;
                }
                if (card.status === 'unknown_card') {
                    const owner = globalCard.get(card.number);
                    if (owner && owner !== sheetName) {
                        // legitimate borrow from another group's inventory — not an error
                        addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2, field: 'card',
                            type: 'borrowed_card', sev: 'info', raw: card.raw,
                            msg: `Card ${card.number} was issued here but belongs to ${owner} (borrowed)` });
                    } else {
                        addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2, field: 'card',
                            type: 'unknown_card', sev: 'error', raw: card.raw,
                            msg: `Card "${card.number}" is not in any group's inventory list`,
                            suggestion: card.suggestion ? `Did you mean ${card.suggestion}?` : null });
                    }
                }
                if (card.note) addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2, field: 'card',
                    type: 'card_note', sev: 'info', raw: card.raw, msg: `Card ${card.number} note: "${card.note}"` });

                // staff
                const st = matchStaff(rawStaff);
                let staffName = st.canonical;
                if (st.reason === 'missing') { staffName = 'MISSING STAFF';
                    addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2, field: 'staff',
                        type: 'missing_staff', sev: 'warn', raw: null, msg: `No staff name for card ${card.number}` });
                } else if (!st.matched && st.reason === 'unknown') {
                    addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2, field: 'staff',
                        type: 'unknown_staff', sev: 'warn', raw: clean(rawStaff),
                        msg: `Staff "${clean(rawStaff)}" is not in the known staff list` });
                }

                // date
                const dt = parseFlexibleDate(rawDate);
                let actionTime = dt.iso;
                if (dt.kind === 'missing') addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2,
                    field: 'date', type: 'missing_date', sev: 'warn', raw: null, msg: `No issue date for card ${card.number}` });
                else if (dt.kind === 'time_only') addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2,
                    field: 'date', type: 'time_only_date', sev: 'warn', raw: dt.raw, msg: `Only a time (no date) for card ${card.number}: "${dt.raw}"` });
                else if (dt.kind === 'unparseable') addIssue({ sheet: sheetName, guest: `${first} ${last}`, room: room2,
                    field: 'date', type: 'bad_date', sev: 'warn', raw: dt.raw, msg: `Unreadable date for card ${card.number}: "${dt.raw}"` });

                const returned = isReturned(rawRet);
                const cardNumberForLog = card.number || String(rawCard).trim();
                const reason = canonReason(rawReason);

                // avoid duplicate log rows on re-import; preserve app edits
                const existing = db.get(`SELECT id, edited_in_app FROM temp_card_log
                    WHERE guest_id=? AND action='issued'
                      AND REPLACE(REPLACE(UPPER(card_number),' ',''),'-','')=? ORDER BY id DESC LIMIT 1`,
                    guest.id, cardNumberForLog);
                if (existing && existing.edited_in_app) {
                    // keep the app's version, just reconcile active flag
                    db.run('UPDATE temp_card_log SET is_active=? WHERE id=?', returned ? 0 : 1, existing.id);
                } else if (existing) {
                    db.run(`UPDATE temp_card_log SET reason=?, staff_name=?, action_time=?, is_active=? WHERE id=?`,
                        reason, staffName, actionTime, returned ? 0 : 1, existing.id);
                } else {
                    db.run(`INSERT INTO temp_card_log
                            (guest_id,conference_id,action,card_number,reason,staff_name,action_time,is_active,edited_in_app)
                            VALUES (?,?,'issued',?,?,?,?,?,0)`,
                        guest.id, conf.id, cardNumberForLog, reason, staffName, actionTime, returned ? 0 : 1);
                    stats.issued++;
                }

                if (returned) {
                    stats.returned++;
                    const retExists = db.get(`SELECT id FROM temp_card_log WHERE guest_id=? AND action='returned'
                        AND REPLACE(REPLACE(UPPER(card_number),' ',''),'-','')=? LIMIT 1`, guest.id, cardNumberForLog);
                    if (!retExists)
                        db.run(`INSERT INTO temp_card_log
                                (guest_id,conference_id,action,card_number,staff_name,action_time,is_active,edited_in_app)
                                VALUES (?,?,'returned',?,?,?,0,0)`,
                            guest.id, conf.id, cardNumberForLog, staffName, actionTime);
                }
            }
        }
    }

    // ── reconcile cards table with active issued logs ──
    db.run(`UPDATE cards SET available=1, current_guest_id=NULL WHERE status<>'missing'`);
    for (const row of db.all(`SELECT guest_id, card_number FROM temp_card_log WHERE action='issued' AND is_active=1`)) {
        db.run(`UPDATE cards SET available=0, current_guest_id=?
                WHERE REPLACE(REPLACE(UPPER(card_number),' ',''),'-','')=?
                  AND status<>'missing'`,
            row.guest_id, normalizeCard(row.card_number).number);
    }

    // ── duplicate active card check (same card out to >1 guest) ──
    for (const d of db.all(`SELECT card_number, COUNT(DISTINCT guest_id) AS n
                            FROM temp_card_log WHERE action='issued' AND is_active=1
                            GROUP BY REPLACE(REPLACE(UPPER(card_number),' ',''),'-','') HAVING n>1`)) {
        addIssue({ sheet: '(cross-group)', field: 'card', type: 'duplicate_active', sev: 'error',
            raw: d.card_number, msg: `Card ${d.card_number} appears issued to ${d.n} guests at once` });
    }

    // persist issues
    const ins = db.db.prepare(`INSERT INTO data_issues
        (sheet_name,guest_name,room,field,issue_type,severity,raw_value,message,suggestion)
        VALUES (?,?,?,?,?,?,?,?,?)`);
    for (const it of issues)
        ins.run(it.sheet || null, it.guest || null, it.room || null, it.field || null,
            it.type, it.sev || 'warn', it.raw ?? null, it.msg, it.suggestion || null);

    return stats;
}

// ─── CLI ───────────────────────────────────────
if (require.main === module) {
    const args = process.argv.slice(2);
    const reset = args.includes('--reset');
    const file = args.find(a => !a.startsWith('--')) ||
        path.join(__dirname, '..', 'data', 'roster.xlsx');
    console.log(`Importing roster (read-only): ${file}`);
    const stats = runImport({ file, reset });
    console.log('Import complete:',
        `${stats.groups} groups, ${stats.guests} guests, ${stats.cards} cards, ` +
        `${stats.issued} issued, ${stats.returned} returned.`);
    console.log(`Data issues found: ${stats.issues}`);
}

module.exports = { runImport };
