/**
 * classify.js — reference-set cell classifier for the roster importer.
 *
 * The spreadsheet stores everything as text, so we cannot trust column types.
 * Instead we resolve each cell against strong reference types, in priority order:
 *
 *   1. known STAFF name  (constant list, fuzzy token match)
 *   2. known CARD number (from the sheet's bottom-section inventory)
 *   3. a DATE            (many messy formats)
 *   4. else -> REASON / free text, or UNCLASSIFIED (flagged)
 *
 * Every function is pure and unit-tested at the bottom (`node classify.js`).
 */

'use strict';

const DEFAULT_YEAR = Number(process.env.ROSTER_YEAR || 2026);

// Canonical staff list. The sheet uses first names / nicknames; we match by token.
// Real staff names are provided at runtime via the CA_STAFF_NAMES env var (see
// .env.example) so they never live in the source. The list below is example/
// placeholder data used for the public demo and tests.
const ENV_STAFF = (process.env.CA_STAFF_NAMES || '')
    .split(',').map(s => s.trim()).filter(Boolean);
const STAFF_EXAMPLE = [
    'Alex Rivera', 'Jordan Lee', 'Sam Ravi Patel', 'Taylor Kim', 'Morgan Diaz',
    'Casey Nguyen', 'Jamie Brooks', 'Riley Santos', 'Avery Chen', 'Drew Okafor',
    'Robin Silva', 'Ayon Rahman', 'Cameron Ali', 'Devon Torres', 'Quinn Adeyemi',
];
const STAFF_CANONICAL = ENV_STAFF.length ? ENV_STAFF : STAFF_EXAMPLE;

// Common reason phrasings -> canonical label (kept loose; reason is free text).
const REASON_CANON = [
    [/lock\s*-?\s*out/i, 'Lockout'],
    [/lost.*(original|card)/i, 'Lost original card'],
    [/left.*(card|room|home)/i, 'Left card'],
    [/lenel|main card/i, 'Main card issue'],
];

// Written-out prefixes staff sometimes use instead of the card code.
const CARD_PREFIX_SYNONYMS = [[/^RESLIFE/i, 'RL'], [/^CONF\s*/i, 'CONF']];

const isBlank = v => v == null || String(v).trim() === '' ||
    ['nan', 'nat', 'none', 'null', 'false', '0', '0.0'].includes(String(v).trim().toLowerCase());

const clean = v => (isBlank(v) ? null : String(v).trim());

const tokenize = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3);

// ─── STAFF ─────────────────────────────────────
function matchStaff(value, staffList = STAFF_CANONICAL) {
    const v = clean(value);
    if (!v) return { canonical: null, matched: false, reason: 'missing' };
    if (v.toUpperCase() === 'MISSING STAFF') return { canonical: 'MISSING STAFF', matched: false, reason: 'placeholder' };

    const vTokens = tokenize(v);
    let best = null, bestScore = 0;
    for (const canonical of staffList) {
        const cTokens = tokenize(canonical);
        const overlap = vTokens.filter(t => cTokens.includes(t)).length;
        if (overlap > bestScore) { bestScore = overlap; best = canonical; }
    }
    if (best && bestScore > 0) return { canonical: best, matched: true, reason: 'token-match' };
    return { canonical: v, matched: false, reason: 'unknown' };
}

// ─── CARD ──────────────────────────────────────
function normalizeCard(value) {
    const v = clean(value);
    if (!v) return { number: null, note: null, raw: null };
    // pull a parenthetical note like "(broken)"
    let note = null;
    const paren = v.match(/\(([^)]*)\)/);
    if (paren) note = paren[1].trim();
    let core = v.replace(/\([^)]*\)/g, '');
    for (const [re, rep] of CARD_PREFIX_SYNONYMS) core = core.replace(re, rep);
    const number = core.toUpperCase().replace(/[\s-]/g, '');
    return { number: number || null, note, raw: v };
}

// Does the text look like a card code at all (letters+digits)?
function looksLikeCard(value) {
    const v = clean(value);
    if (!v) return false;
    const compact = v.replace(/\([^)]*\)/g, '').toUpperCase().replace(/[\s-]/g, '');
    return /^[A-Z]{1,6}\d{3,6}$/.test(compact);
}

// Resolve a card cell against the known inventory (a Set of normalized numbers).
function resolveCard(value, inventory) {
    const { number, note, raw } = normalizeCard(value);
    if (!number) return { status: 'missing', number: null, note, raw };
    if (inventory.has(number)) return { status: 'ok', number, note, raw };
    // maybe a written-out synonym already applied but still not found -> suggest closest
    const suggestion = [...inventory].find(inv => inv.replace(/^[A-Z]+/, '') === number.replace(/^[A-Z]+/, ''));
    if (looksLikeCard(value)) return { status: 'unknown_card', number, note, raw, suggestion };
    return { status: 'not_a_card', number: null, note, raw };  // junk / words in card cell
}

// ─── DATE ──────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

function parseFlexibleDate(value) {
    const v = clean(value);
    if (!v) return { iso: null, kind: 'missing', raw: null };
    const low = v.toLowerCase();
    if (['unsure', 'unknown', 'n/a', 'tbd', '?'].includes(low)) return { iso: null, kind: 'unparseable', raw: v };

    // time only, e.g. "17:40:49.291000" or "7:17PM"  -> flag: no date
    if (/^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?$/i.test(v)) return { iso: null, kind: 'time_only', raw: v };

    // ISO-ish "2026-06-08 20:21:14" (tolerate trailing junk/dot)
    let m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
        const [_, y, mo, d, hh, mi, ss] = m;
        const time = hh != null ? ` ${pad(hh)}:${mi}:${ss || '00'}` : '';
        return { iso: `${y}-${mo}-${d}${time}`, kind: hh != null ? 'datetime' : 'date', raw: v };
    }
    // US "6/19/2026" or "6/19/26" or "6/19" (assume DEFAULT_YEAR), optional time "6/19 - 7:17PM"
    m = v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?:\s*[- ]\s*(\d{1,2}):(\d{2})\s*(am|pm)?)?/i);
    if (m) {
        let [_, mo, d, y, hh, mi, ap] = m;
        y = y ? (y.length === 2 ? 2000 + Number(y) : Number(y)) : DEFAULT_YEAR;
        let H = hh != null ? Number(hh) : null;
        if (H != null && ap) { const P = ap.toLowerCase() === 'pm'; if (P && H < 12) H += 12; if (!P && H === 12) H = 0; }
        const time = H != null ? ` ${pad(H)}:${mi}:00` : '';
        return { iso: `${y}-${pad(mo)}-${pad(d)}${time}`, kind: H != null ? 'datetime' : 'date', raw: v };
    }
    // "June 19 2026", "19 Jun"
    m = low.match(/(\d{1,2})?\s*([a-z]{3,})\.?\s*(\d{1,2})?,?\s*(\d{4})?/);
    if (m && MONTHS.includes(m[2].slice(0, 3))) {
        const mo = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
        const d = m[3] || m[1] || '1';
        const y = m[4] || DEFAULT_YEAR;
        return { iso: `${y}-${pad(mo)}-${pad(d)}`, kind: 'date', raw: v };
    }
    return { iso: null, kind: 'unparseable', raw: v };
}

// ─── generic single-cell classifier (for shifted-column detection) ──
function classifyValue(value, { staffList = STAFF_CANONICAL, inventory = new Set() } = {}) {
    if (isBlank(value)) return { type: 'blank' };
    const card = resolveCard(value, inventory);
    if (card.status === 'ok') return { type: 'card', value: card.number };
    const staff = matchStaff(value, staffList);
    if (staff.matched) return { type: 'staff', value: staff.canonical };
    const date = parseFlexibleDate(value);
    if (date.kind === 'datetime' || date.kind === 'date') return { type: 'date', value: date.iso };
    if (looksLikeCard(value)) return { type: 'card_like_unknown', value: card.number };
    return { type: 'text', value: clean(value) };
}

function canonReason(value) {
    const v = clean(value);
    if (!v) return null;
    for (const [re, label] of REASON_CANON) if (re.test(v)) return label;
    return v;
}

module.exports = {
    STAFF_CANONICAL, DEFAULT_YEAR,
    isBlank, clean, matchStaff, normalizeCard, looksLikeCard, resolveCard,
    parseFlexibleDate, classifyValue, canonReason,
};

// ─── self-test ─────────────────────────────────
if (require.main === module) {
    const inv = new Set(['RL00520', 'RL00490', 'RL00064', 'RL00070', 'CONFC00066']);
    const t = (label, got, want) => console.log((JSON.stringify(got) === JSON.stringify(want) ? 'ok  ' : 'FAIL') + ' ' + label, JSON.stringify(got));

    t('card space', normalizeCard('RL 00520').number, 'RL00520');
    t('card broken note', normalizeCard('RL00490(broken)'), { number: 'RL00490', note: 'broken', raw: 'RL00490(broken)' });
    t('resolve ok', resolveCard('RL 00520', inv).status, 'ok');
    t('resolve unknown', resolveCard('RL09999', inv).status, 'unknown_card');
    t('resolve reslife->suggest', resolveCard('Reslife 00070', inv).number, 'RL00070');
    t('resolve junk', resolveCard('see notes', inv).status, 'not_a_card');

    t('staff first name', matchStaff('Taylor').canonical, 'Taylor Kim');
    t('staff middle name', matchStaff('Ravi').canonical, 'Sam Ravi Patel');
    t('staff unknown', matchStaff('Zzzz').matched, false);
    t('staff missing', matchStaff('').reason, 'missing');

    t('date iso', parseFlexibleDate('2026-05-31 00:00:00').iso, '2026-05-31 00:00:00');
    t('date trailing dot', parseFlexibleDate('2026-06-08 20:21:14.').kind, 'datetime');
    t('date us short', parseFlexibleDate('6/19 - 7:17PM').iso, '2026-06-19 19:17:00');
    t('date pm lower', parseFlexibleDate('6/23 20:10pm').kind, 'datetime');
    t('date time-only', parseFlexibleDate('17:40:49.291000').kind, 'time_only');
    t('date unsure', parseFlexibleDate('unsure').kind, 'unparseable');
    t('date missing', parseFlexibleDate('').kind, 'missing');

    t('classify staff-in-card-col', classifyValue('Taylor', { inventory: inv }).type, 'staff');
    t('classify date-in-card-col', classifyValue('6/19/2026', { inventory: inv }).type, 'date');
}
