-- The events ledger: append-only, the source of truth for the event path. Any queue is transport;
-- this table is what a rebuild replays. A row holds an event id, a kind, a time and the ids it is
-- about. It holds no IP address, no user agent, no email and no account of any kind. The session id
-- (client events only) is generated in the browser per page load and cannot link visits.
CREATE TABLE events (
    seq            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id       text        NOT NULL DEFAULT gen_random_uuid()::text UNIQUE
                   CHECK (char_length(event_id) BETWEEN 16 AND 64),
    kind           text        NOT NULL
                   CHECK (kind IN ('publication_created', 'report_filed', 'roll_opened',
                                   'stage_played', 'flip_started')),
    origin         text        NOT NULL CHECK (origin IN ('server', 'client')),
    session_id     text        CHECK (session_id IS NULL OR char_length(session_id) BETWEEN 8 AND 64),
    occurred_at    timestamptz NOT NULL DEFAULT now(),
    publication_id text,
    detail         text        CHECK (detail IS NULL OR char_length(detail) <= 64),
    relay_state    text        NOT NULL DEFAULT 'unsent' CHECK (relay_state IN ('unsent', 'sent')),
    sent_at        timestamptz,
    CHECK ((relay_state = 'sent') = (sent_at IS NOT NULL)),
    -- Only the browser has a session; a server event never carries one.
    CHECK (origin = 'client' OR session_id IS NULL)
);

-- The relay scans unsent rows; a partial index keeps that scan small however long the ledger is.
-- The order is a scan order only: delivery never relies on it (commit order is not id order).
CREATE INDEX events_unsent ON events (seq) WHERE relay_state = 'unsent';
-- Retention deletes by age.
CREATE INDEX events_occurred ON events (occurred_at);
