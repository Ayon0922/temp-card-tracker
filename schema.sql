-- ============================================================
-- Temp Card Tracker — SQLite schema (ported from MySQL)
-- Entities: conferences -> guests -> temp_card_log + cards
-- ============================================================

PRAGMA foreign_keys = ON;

-- ─── conferences (a.k.a. groups) ──────────────
CREATE TABLE IF NOT EXISTS conferences (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    organizer   TEXT,
    start_date  TEXT,
    end_date    TEXT,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── guests ───────────────────────────────────
CREATE TABLE IF NOT EXISTS guests (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    conference_id       INTEGER NOT NULL,
    first_name          TEXT NOT NULL,
    last_name           TEXT NOT NULL,
    room_number         TEXT,
    building            TEXT,
    company_or_org      TEXT,
    phone               TEXT,
    email               TEXT,
    key_assigned        TEXT,
    scheduled_arrival   TEXT,
    scheduled_departure TEXT,
    checked_in          INTEGER NOT NULL DEFAULT 0,   -- 0/1 boolean
    check_in_time       TEXT,
    notes               TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conference_id) REFERENCES conferences(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_guests_conf ON guests(conference_id);
CREATE INDEX IF NOT EXISTS idx_guests_name ON guests(last_name, first_name);
CREATE INDEX IF NOT EXISTS idx_guests_room ON guests(room_number);

-- ─── temp_card_log (audit trail — never delete rows) ──
CREATE TABLE IF NOT EXISTS temp_card_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_id      INTEGER NOT NULL,
    conference_id INTEGER NOT NULL,
    action        TEXT NOT NULL CHECK (action IN ('issued','returned')),
    card_number   TEXT,
    reason        TEXT,
    staff_name    TEXT,
    action_time   TEXT DEFAULT NULL,             -- NULL = imported, unknown time
    is_active     INTEGER NOT NULL DEFAULT 1,     -- 1 = card still out
    edited_in_app INTEGER NOT NULL DEFAULT 0,     -- 1 = preserve during sync
    FOREIGN KEY (guest_id)      REFERENCES guests(id)      ON DELETE RESTRICT,
    FOREIGN KEY (conference_id) REFERENCES conferences(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_log_guest  ON temp_card_log(guest_id);
CREATE INDEX IF NOT EXISTS idx_log_active ON temp_card_log(is_active);
CREATE INDEX IF NOT EXISTS idx_log_time   ON temp_card_log(action_time);

-- ─── cards (physical inventory, per conference) ──
CREATE TABLE IF NOT EXISTS cards (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conference_id    INTEGER NOT NULL,
    card_number      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'listed'
                     CHECK (status IN ('listed','not_listed','missing')),
    available        INTEGER NOT NULL DEFAULT 1,    -- 1 = at desk
    current_guest_id INTEGER DEFAULT NULL,          -- who has it right now
    notes            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conference_id)    REFERENCES conferences(id) ON DELETE CASCADE,
    FOREIGN KEY (current_guest_id) REFERENCES guests(id)      ON DELETE SET NULL,
    UNIQUE (conference_id, card_number)
);
CREATE INDEX IF NOT EXISTS idx_cards_available ON cards(available);
CREATE INDEX IF NOT EXISTS idx_cards_conf      ON cards(conference_id);

-- Keep cards.updated_at fresh on update (MySQL's ON UPDATE equivalent)
CREATE TRIGGER IF NOT EXISTS trg_cards_updated
AFTER UPDATE ON cards
FOR EACH ROW
BEGIN
    UPDATE cards SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ─── data_issues (roster quality report from the import) ──
-- Every problem the importer finds in the Google Sheet / Excel roster.
-- Read-only wrt the sheet: we record issues here for staff to fix at the source.
CREATE TABLE IF NOT EXISTS data_issues (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_name       TEXT,                 -- which group/tab
    guest_name       TEXT,                 -- affected guest (if any)
    room             TEXT,
    field            TEXT,                 -- card | staff | date | reason | guest | inventory
    issue_type       TEXT NOT NULL,        -- e.g. missing_date, unknown_card, junk_card
    severity         TEXT NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','error')),
    raw_value        TEXT,                 -- what was actually in the cell
    message          TEXT NOT NULL,
    suggestion       TEXT,                 -- best-guess fix, if any
    resolved         INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_issues_type ON data_issues(issue_type);
CREATE INDEX IF NOT EXISTS idx_issues_sheet ON data_issues(sheet_name);
