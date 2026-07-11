/**
 * db.js — SQLite connection layer using Node's built-in `node:sqlite`.
 * No native dependencies. Requires Node >= 22.5 (run with --experimental-sqlite).
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.CARD_DB || path.join(DATA_DIR, 'cards.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

/** Create tables/indexes/triggers from schema.sql (idempotent). */
function initSchema() {
    const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
    db.exec(sql);
}

/** Convenience helpers so callers read like better-sqlite3. */
const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

/** Run fn inside a transaction; rolls back on throw. */
function tx(fn) {
    db.exec('BEGIN');
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    } catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}

module.exports = { db, DB_PATH, initSchema, all, get, run, tx };
