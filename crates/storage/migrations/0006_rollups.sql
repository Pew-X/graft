-- Hourly rollups: counts only, never a session id, an address or anything that identifies a visitor.
-- Derived state: it can be rebuilt from the events ledger (within the retention window) and is
-- never the source of a public fact.
CREATE TABLE rollups (
    hour           timestamptz NOT NULL,
    kind           text        NOT NULL
                   CHECK (kind IN ('publication_created', 'report_filed', 'roll_opened',
                                   'stage_played', 'flip_started')),
    -- The publication or stage the events were about; empty when an event named none.
    publication_id text        NOT NULL DEFAULT '',
    count          bigint      NOT NULL CHECK (count > 0),
    PRIMARY KEY (hour, kind, publication_id)
);

-- The consumer's dedupe set: an event id is applied once. Kept at least as long as the events
-- themselves, so a delivery that repeats an old event is still recognised.
CREATE TABLE processed_events (
    event_id    text        PRIMARY KEY,
    occurred_at timestamptz NOT NULL
);
CREATE INDEX processed_events_occurred ON processed_events (occurred_at);
