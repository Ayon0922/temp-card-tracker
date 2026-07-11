/**
 * server.js — Temp Card Tracker API (Express + built-in SQLite).
 *
 * Run:  npm install  &&  npm run seed  &&  npm start
 * Then open http://localhost:5000
 *
 * Design note: the app is the source of truth. We keep the `cards` table and
 * the `temp_card_log` audit trail in sync inside every transaction, so we do
 * not need a separate reconciliation pass. A card is:
 *    at desk  -> available=1, status<>'missing'
 *    out      -> available=0, status<>'missing'  (current_guest_id set)
 *    missing  -> status='missing'
 */
const express = require('express');
const path = require('path');
const { initSchema, all, get, run, tx } = require('./db');

initSchema();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── helpers ───────────────────────────────────
const ok = (res, data, status = 200) => res.status(status).json({ success: true, ...data });
const fail = (res, msg, status = 400) => res.status(status).json({ success: false, error: msg });
const wrap = fn => (req, res) => {
    try { fn(req, res); }
    catch (e) { console.error('[Error]', e.message); fail(res, e.message, 500); }
};
const norm = v => String(v || '').toUpperCase().replace(/[\s-]/g, '');

const DEFAULT_STAFF = [
    'Ayon Rahman', 'Front Desk', 'Security', 'Supervisor',
];
const MAX_CARDS = 3;

/** Non-missing cards currently held by a guest. */
const guestCardsOut = guest_id =>
    get(`SELECT COUNT(*) AS n FROM cards
         WHERE current_guest_id=? AND status<>'missing'`, guest_id).n;

// ─── health & staff ────────────────────────────
app.get('/api/health', (req, res) => ok(res, { message: 'running' }));

app.get('/api/staff-names', wrap((req, res) => {
    const configured = (process.env.CA_STAFF_NAMES || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    ok(res, { data: [...new Set(configured.length ? configured : DEFAULT_STAFF)] });
}));

// ═══ CONFERENCES ═══════════════════════════════
app.get('/api/conferences', wrap((req, res) => {
    const rows = all(`
        SELECT c.*, COUNT(ca.id) AS card_count
        FROM conferences c
        LEFT JOIN cards ca ON ca.conference_id=c.id
        GROUP BY c.id ORDER BY c.name`);
    ok(res, { data: rows });
}));

app.post('/api/conferences', wrap((req, res) => {
    const { name, organizer, start_date, end_date } = req.body;
    if (!name?.trim()) return fail(res, 'Name is required');
    const exists = get('SELECT id FROM conferences WHERE name=?', name.trim());
    if (exists) return fail(res, 'Conference already exists', 409);
    const r = run(
        'INSERT INTO conferences (name,organizer,start_date,end_date) VALUES (?,?,?,?)',
        name.trim(), organizer || null, start_date || null, end_date || null);
    ok(res, { id: r.lastInsertRowid, message: 'Conference created' }, 201);
}));

app.delete('/api/conferences/:id', wrap((req, res) => {
    const conf = get('SELECT id,name FROM conferences WHERE id=?', req.params.id);
    if (!conf) return fail(res, 'Group not found', 404);
    const out = get(`SELECT COUNT(*) AS n FROM cards
                     WHERE conference_id=? AND available=0 AND status<>'missing'`, conf.id).n;
    if (out > 0) return fail(res, `Cannot delete "${conf.name}" while ${out} card(s) are still out.`, 409);
    tx(() => {
        run('DELETE FROM temp_card_log WHERE conference_id=?', conf.id);
        run('DELETE FROM cards WHERE conference_id=?', conf.id);
        run('DELETE FROM guests WHERE conference_id=?', conf.id);
        run('DELETE FROM conferences WHERE id=?', conf.id);
    });
    ok(res, { message: `"${conf.name}" deleted` });
}));

// ═══ DASHBOARD ═════════════════════════════════
app.get('/api/dashboard', wrap((req, res) => {
    const total_guests = get('SELECT COUNT(*) AS n FROM guests').n;
    const t = get(`SELECT
        COUNT(*) AS total_cards,
        SUM(CASE WHEN available=0 AND status<>'missing' THEN 1 ELSE 0 END) AS cards_out,
        SUM(CASE WHEN available=1 AND status<>'missing' THEN 1 ELSE 0 END) AS cards_at_desk,
        SUM(CASE WHEN status='missing' THEN 1 ELSE 0 END) AS cards_missing
        FROM cards`);
    const guests_at_max = get(`SELECT COUNT(*) AS n FROM (
        SELECT current_guest_id FROM cards
        WHERE current_guest_id IS NOT NULL AND status<>'missing'
        GROUP BY current_guest_id HAVING COUNT(*)>=${MAX_CARDS})`).n;

    // Correlated subqueries avoid a guests×cards cartesian fan-out.
    const byGroup = all(`
        SELECT c.id, c.name,
            (SELECT COUNT(*) FROM guests g WHERE g.conference_id=c.id) AS guests,
            (SELECT COUNT(*) FROM cards ca WHERE ca.conference_id=c.id) AS total_cards,
            (SELECT COUNT(*) FROM cards ca WHERE ca.conference_id=c.id
                AND ca.available=0 AND ca.status<>'missing') AS cards_out,
            (SELECT COUNT(*) FROM cards ca WHERE ca.conference_id=c.id
                AND ca.available=1 AND ca.status<>'missing') AS cards_at_desk,
            (SELECT COUNT(*) FROM cards ca WHERE ca.conference_id=c.id
                AND ca.status='missing') AS cards_missing
        FROM conferences c ORDER BY c.name`);

    ok(res, {
        totals: {
            total_guests,
            total_cards: t.total_cards || 0,
            cards_out: t.cards_out || 0,
            cards_at_desk: t.cards_at_desk || 0,
            cards_missing: t.cards_missing || 0,
            guests_at_max,
        },
        byGroup: byGroup.map(g => ({
            ...g,
            total_cards: g.total_cards || 0,
            cards_out: g.cards_out || 0,
            cards_at_desk: g.cards_at_desk || 0,
            cards_missing: g.cards_missing || 0,
        })),
    });
}));

// ═══ GUESTS ════════════════════════════════════
app.get('/api/conferences/:id/guests', wrap((req, res) => {
    const { search } = req.query;
    let sql = `
        SELECT g.*, c.name AS conference_name,
          (SELECT COUNT(*) FROM cards ca
             WHERE ca.current_guest_id=g.id AND ca.status<>'missing') AS cards_out
        FROM guests g JOIN conferences c ON c.id=g.conference_id
        WHERE g.conference_id=?`;
    const params = [req.params.id];
    if (search?.trim()) {
        sql += ' AND (g.first_name LIKE ? OR g.last_name LIKE ? OR g.room_number LIKE ?)';
        const s = `%${search.trim()}%`;
        params.push(s, s, s);
    }
    sql += ' ORDER BY g.last_name, g.first_name';
    const rows = all(sql, ...params);
    ok(res, { data: rows, count: rows.length });
}));

app.post('/api/guests', wrap((req, res) => {
    const { conference_id, first_name, last_name, room_number, building,
            company_or_org, phone, email, key_assigned,
            scheduled_arrival, scheduled_departure } = req.body;
    if (!conference_id) return fail(res, 'conference_id is required');
    if (!first_name?.trim()) return fail(res, 'first_name is required');
    if (!last_name?.trim()) return fail(res, 'last_name is required');
    const r = run(
        `INSERT INTO guests (conference_id,first_name,last_name,room_number,building,
            company_or_org,phone,email,key_assigned,scheduled_arrival,scheduled_departure)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        conference_id, first_name.trim(), last_name.trim(), room_number || null,
        building || null, company_or_org || null, phone || null, email || null,
        key_assigned || null, scheduled_arrival || null, scheduled_departure || null);
    ok(res, { id: r.lastInsertRowid, message: 'Guest added' }, 201);
}));

app.delete('/api/guests/:id', wrap((req, res) => {
    const guest = get('SELECT id,first_name,last_name FROM guests WHERE id=?', req.params.id);
    if (!guest) return fail(res, 'Guest not found', 404);
    if (guestCardsOut(guest.id) > 0)
        return fail(res, `Cannot delete ${guest.first_name} ${guest.last_name} while cards are still out.`, 409);
    tx(() => {
        run('UPDATE cards SET current_guest_id=NULL, available=1 WHERE current_guest_id=?', guest.id);
        run('DELETE FROM temp_card_log WHERE guest_id=?', guest.id);
        run('DELETE FROM guests WHERE id=?', guest.id);
    });
    ok(res, { message: `${guest.first_name} ${guest.last_name} deleted` });
}));

// ═══ ISSUE / RETURN ════════════════════════════
app.post('/api/guests/:id/issue', wrap((req, res) => {
    const { card_id, card_number, reason, staff_name } = req.body;
    if (!card_id && !card_number?.trim()) return fail(res, 'A card is required');
    if (!staff_name?.trim()) return fail(res, 'staff_name is required');

    const guest = get('SELECT id,conference_id,first_name,last_name FROM guests WHERE id=?', req.params.id);
    if (!guest) return fail(res, 'Guest not found', 404);

    const out = guestCardsOut(guest.id);
    if (out >= MAX_CARDS)
        return fail(res, `${guest.first_name} ${guest.last_name} already has ${out} card(s) out. Max is ${MAX_CARDS}.`, 409);

    // locate the physical card
    let card;
    if (card_id) card = get(`SELECT ca.*, c.name AS owner_name FROM cards ca
                             JOIN conferences c ON c.id=ca.conference_id WHERE ca.id=?`, card_id);
    else card = get(`SELECT ca.*, c.name AS owner_name FROM cards ca
                     JOIN conferences c ON c.id=ca.conference_id
                     WHERE ca.conference_id=? AND ca.card_number=?`, guest.conference_id, card_number.trim());
    if (!card) return fail(res, 'Card not found in inventory', 404);
    if (!card.available || card.status === 'missing')
        return fail(res, `Card ${card.card_number} is not available`, 409);

    const borrowed = card.conference_id !== guest.conference_id ? `Borrowed from ${card.owner_name}` : null;
    const logReason = [reason || null, borrowed].filter(Boolean).join(' | ') || null;

    tx(() => {
        run(`INSERT INTO temp_card_log
                (guest_id,conference_id,action,card_number,reason,staff_name,action_time,is_active,edited_in_app)
             VALUES (?,?,'issued',?,?,?,datetime('now','localtime'),1,1)`,
            guest.id, guest.conference_id, card.card_number, logReason, staff_name.trim());
        run(`UPDATE cards SET available=0, current_guest_id=? WHERE id=?`, guest.id, card.id);
    });

    const n = out + 1;
    ok(res, {
        message: `Card ${card.card_number} issued to ${guest.first_name} ${guest.last_name}`,
        cards_out: n,
        borrowed_from: borrowed ? card.owner_name : null,
        warning: n === MAX_CARDS ? `${guest.first_name} ${guest.last_name} is now at the ${MAX_CARDS}-card maximum` : null,
    }, 201);
}));

app.post('/api/guests/:id/return', wrap((req, res) => {
    const { staff_name, card_number } = req.body;
    if (!staff_name?.trim()) return fail(res, 'staff_name is required');
    const guest = get('SELECT id,conference_id,first_name,last_name FROM guests WHERE id=?', req.params.id);
    if (!guest) return fail(res, 'Guest not found', 404);

    // pick the card to return
    let card;
    if (card_number?.trim())
        card = get(`SELECT * FROM cards WHERE current_guest_id=? AND status<>'missing'
                    AND REPLACE(REPLACE(UPPER(card_number),' ',''),'-','')=?`, guest.id, norm(card_number));
    else
        card = get(`SELECT * FROM cards WHERE current_guest_id=? AND status<>'missing'
                    ORDER BY updated_at DESC LIMIT 1`, guest.id);
    if (!card) return fail(res, `${guest.first_name} ${guest.last_name} has no active cards to return`, 404);

    tx(() => {
        // close the matching active issued log, add a returned row (full audit)
        const active = get(`SELECT id FROM temp_card_log
            WHERE guest_id=? AND action='issued' AND is_active=1
              AND REPLACE(REPLACE(UPPER(card_number),' ',''),'-','')=?
            ORDER BY id DESC LIMIT 1`, guest.id, norm(card.card_number));
        if (active) run('UPDATE temp_card_log SET is_active=0 WHERE id=?', active.id);
        run(`INSERT INTO temp_card_log
                (guest_id,conference_id,action,card_number,staff_name,action_time,is_active,edited_in_app)
             VALUES (?,?,'returned',?,?,datetime('now','localtime'),0,1)`,
            guest.id, card.conference_id, card.card_number, staff_name.trim());
        run(`UPDATE cards SET available=1, current_guest_id=NULL,
                status=CASE WHEN status='missing' THEN 'listed' ELSE status END
             WHERE id=?`, card.id);
    });

    ok(res, {
        message: `Card ${card.card_number} returned by ${guest.first_name} ${guest.last_name}`,
        card_returned: card.card_number,
        cards_remaining: guestCardsOut(guest.id),
    });
}));

// ═══ CARD INVENTORY ════════════════════════════
app.get('/api/available-cards', wrap((req, res) => {
    const rows = all(`
        SELECT ca.id, ca.conference_id, ca.card_number, ca.status, c.name AS conference_name
        FROM cards ca JOIN conferences c ON c.id=ca.conference_id
        WHERE ca.available=1 AND ca.status<>'missing'
        ORDER BY c.name, ca.card_number`);
    ok(res, { data: rows, count: rows.length });
}));

app.get('/api/conferences/:id/cards', wrap((req, res) => {
    const rows = all(`
        SELECT ca.*,
            (g.first_name || ' ' || g.last_name) AS held_by_name,
            g.room_number AS held_by_room
        FROM cards ca LEFT JOIN guests g ON g.id=ca.current_guest_id
        WHERE ca.conference_id=?
        ORDER BY ca.available DESC, ca.card_number`, req.params.id);
    const summary = {
        total: rows.length,
        available: rows.filter(r => r.available && r.status !== 'missing').length,
        out: rows.filter(r => !r.available && r.status !== 'missing').length,
        missing: rows.filter(r => r.status === 'missing').length,
    };
    ok(res, { data: rows, summary });
}));

app.post('/api/conferences/:id/cards', wrap((req, res) => {
    const { card_number, status, notes } = req.body;
    if (!card_number?.trim()) return fail(res, 'card_number is required');
    const dup = get('SELECT id FROM cards WHERE conference_id=? AND card_number=?',
        req.params.id, card_number.trim());
    if (dup) return fail(res, 'Card already in inventory', 409);
    const r = run(`INSERT INTO cards (conference_id,card_number,status,available,notes)
                   VALUES (?,?,?,1,?)`,
        req.params.id, card_number.trim(), status || 'listed', notes || null);
    ok(res, { id: r.lastInsertRowid, message: 'Card added to inventory' }, 201);
}));

app.put('/api/cards/:id', wrap((req, res) => {
    const { status, notes } = req.body;
    const card = get('SELECT * FROM cards WHERE id=?', req.params.id);
    if (!card) return fail(res, 'Card not found', 404);
    if (card.current_guest_id && status === 'missing')
        return fail(res, 'Return the card before marking it missing.', 409);
    const nextStatus = status || card.status;
    const nextAvailable = nextStatus === 'missing' ? 0 : (card.current_guest_id ? 0 : 1);
    run('UPDATE cards SET status=?, available=?, notes=COALESCE(?,notes) WHERE id=?',
        nextStatus, nextAvailable, notes ?? null, card.id);
    ok(res, { message: 'Card updated' });
}));

// ═══ TRANSACTION LOG ═══════════════════════════
app.get('/api/log', wrap((req, res) => {
    const { conf_id, limit = 200 } = req.query;
    let sql = `
        SELECT tcl.*, (g.first_name || ' ' || g.last_name) AS guest_name,
               g.room_number, c.name AS conference_name
        FROM temp_card_log tcl
        JOIN guests g ON g.id=tcl.guest_id
        JOIN conferences c ON c.id=tcl.conference_id
        WHERE 1=1`;
    const params = [];
    if (conf_id) { sql += ' AND tcl.conference_id=?'; params.push(conf_id); }
    sql += ' ORDER BY tcl.action_time IS NULL, tcl.action_time DESC, tcl.id DESC LIMIT ?';
    params.push(parseInt(limit));
    ok(res, { data: all(sql, ...params) });
}));

app.put('/api/log/:id', wrap((req, res) => {
    const { card_number, reason, staff_name, action_time } = req.body;
    if (staff_name !== undefined && !staff_name.trim())
        return fail(res, 'staff_name cannot be blank. Use MISSING STAFF if unknown.');
    const entry = get('SELECT * FROM temp_card_log WHERE id=?', req.params.id);
    if (!entry) return fail(res, 'Transaction not found', 404);
    run(`UPDATE temp_card_log SET card_number=?, reason=?, staff_name=?, action_time=?, edited_in_app=1 WHERE id=?`,
        card_number?.trim() || entry.card_number,
        reason !== undefined ? (reason.trim() || null) : entry.reason,
        staff_name !== undefined ? staff_name.trim() : entry.staff_name,
        action_time === '' ? null : (action_time || entry.action_time),
        entry.id);
    ok(res, { message: 'Transaction updated' });
}));

// ═══ CARDS OUT ═════════════════════════════════
app.get('/api/cards-out', wrap((req, res) => {
    const { conf_id } = req.query;
    let sql = `
        SELECT ca.card_number,
               (g.first_name || ' ' || g.last_name) AS guest_name,
               g.room_number, g.building,
               c.name AS conference_name,
               owner.name AS card_owner_conference_name,
               g.conference_id,
               tcl.staff_name AS issued_by,
               tcl.reason,
               tcl.action_time AS issued_at
        FROM cards ca
        JOIN guests g ON g.id=ca.current_guest_id
        JOIN conferences c ON c.id=g.conference_id
        JOIN conferences owner ON owner.id=ca.conference_id
        LEFT JOIN temp_card_log tcl ON tcl.id=(
            SELECT id FROM temp_card_log
            WHERE guest_id=g.id AND action='issued' AND is_active=1
              AND REPLACE(REPLACE(UPPER(card_number),' ',''),'-','')=
                  REPLACE(REPLACE(UPPER(ca.card_number),' ',''),'-','')
            ORDER BY id DESC LIMIT 1)
        WHERE ca.status<>'missing' AND ca.available=0`;
    const params = [];
    if (conf_id) { sql += ' AND g.conference_id=?'; params.push(conf_id); }
    sql += ' ORDER BY tcl.action_time IS NULL, tcl.action_time DESC';
    const rows = all(sql, ...params);
    ok(res, { data: rows, count: rows.length });
}));

// ═══ DATA ISSUES (roster quality report) ═══════
app.get('/api/data-issues', wrap((req, res) => {
    const { severity, type, sheet, resolved = '0' } = req.query;
    let sql = 'SELECT * FROM data_issues WHERE 1=1';
    const params = [];
    if (resolved !== 'all') { sql += ' AND resolved=?'; params.push(Number(resolved)); }
    if (severity) { sql += ' AND severity=?'; params.push(severity); }
    if (type) { sql += ' AND issue_type=?'; params.push(type); }
    if (sheet) { sql += ' AND sheet_name=?'; params.push(sheet); }
    sql += ` ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
             sheet_name, guest_name`;
    const rows = all(sql, ...params);

    const summary = all(`SELECT issue_type, severity, COUNT(*) AS n
        FROM data_issues WHERE resolved=0 GROUP BY issue_type, severity`);
    const totals = get(`SELECT
        SUM(CASE WHEN severity='error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN severity='warn'  THEN 1 ELSE 0 END) AS warnings,
        SUM(CASE WHEN severity='info'  THEN 1 ELSE 0 END) AS info,
        COUNT(*) AS total FROM data_issues WHERE resolved=0`);
    ok(res, { data: rows, summary, totals });
}));

app.put('/api/data-issues/:id/resolve', wrap((req, res) => {
    run('UPDATE data_issues SET resolved=1 WHERE id=?', req.params.id);
    ok(res, { message: 'Issue marked resolved' });
}));

// SPA fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`\n🔑 Temp Card Tracker — http://localhost:${PORT}\n`);
});
