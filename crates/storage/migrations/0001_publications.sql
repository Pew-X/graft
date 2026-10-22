-- Content records are immutable and content-addressed: the id is the SHA-256 of the canonical bytes.
CREATE TABLE content_records (
    id                    bytea   PRIMARY KEY CHECK (octet_length(id) = 32),
    format                integer NOT NULL,
    kind                  text    NOT NULL CHECK (kind IN ('source', 'flip')),
    parent_publication_id text,
    source_blob           bytea   NOT NULL CHECK (octet_length(source_blob) = 32),
    cut_start             integer NOT NULL CHECK (cut_start >= 0),
    cut_end               integer NOT NULL,
    p                     integer,
    q                     integer,
    method                integer,
    renderer_name         text    NOT NULL,
    renderer_version      integer NOT NULL,
    renderer_sha256       bytea   NOT NULL CHECK (octet_length(renderer_sha256) = 32),
    output_blob           bytea   NOT NULL CHECK (octet_length(output_blob) = 32),
    canonical             bytea   NOT NULL,
    CHECK (cut_end > cut_start),
    CHECK ((kind = 'source') = (parent_publication_id IS NULL)),
    CHECK ((kind = 'source') = (p IS NULL AND q IS NULL AND method IS NULL))
);

-- A publication is a maker's credited claim on a content record. It is not hashed.
CREATE TABLE publications (
    id              text        PRIMARY KEY,
    content_id      bytea       NOT NULL REFERENCES content_records (id),
    retry_key       text        NOT NULL UNIQUE,
    title           text        NOT NULL,
    author          text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    fork_permitted  boolean     NOT NULL DEFAULT true,
    hidden_reason   text        CHECK (hidden_reason IN ('withdrawn', 'rights')),
    manage_key_hash bytea,
    licence         text,
    work_title      text,
    work_author     text,
    work_url        text
);

ALTER TABLE content_records
    ADD CONSTRAINT content_records_parent_fk
    FOREIGN KEY (parent_publication_id) REFERENCES publications (id);

-- Ancestry walks and "flipped N times" both look up children by parent.
CREATE INDEX content_records_parent ON content_records (parent_publication_id);
CREATE INDEX publications_content ON publications (content_id);
