-- Settings the operator changes at run time without a restart (the kill switch lives here). A key
-- with no row means "use the environment default".
CREATE TABLE runtime_settings (
    key        text        PRIMARY KEY,
    value      text        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- The global publish budget: one row, a token bucket. A publish takes one token; tokens refill at
-- a fixed rate up to a burst size. One row updated in one statement is exact under any number of
-- concurrent publishers and across service instances.
CREATE TABLE publish_budget (
    id         smallint         PRIMARY KEY CHECK (id = 1),
    tokens     double precision NOT NULL CHECK (tokens >= 0),
    updated_at timestamptz      NOT NULL
);
