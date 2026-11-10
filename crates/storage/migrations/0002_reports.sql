-- A report is a request, from anyone, that a publication be looked at. It carries no identity: no
-- account, no email address, no IP address and no user agent. The note is for the operator and is
-- never shown publicly.
CREATE TABLE reports (
    id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    publication_id text        NOT NULL REFERENCES publications (id),
    category       text        NOT NULL
                   CHECK (category IN ('rights', 'private_conversation', 'harmful', 'spam', 'other')),
    note           text        CHECK (note IS NULL OR char_length(note) <= 500),
    created_at     timestamptz NOT NULL DEFAULT now()
);

-- The operator reads reports newest first, and looks reports up by publication.
CREATE INDEX reports_newest ON reports (created_at DESC, id DESC);
CREATE INDEX reports_publication ON reports (publication_id);
