-- A visitor who publishes their own source declares their right to share it. The statement they
-- accepted is stored as they accepted it, with the time. It is a declaration: shown as declared,
-- never as established. Seeded sources carry licence evidence instead and have no declaration.
ALTER TABLE publications
    ADD COLUMN declaration text CHECK (declaration IS NULL OR char_length(declaration) <= 400),
    ADD COLUMN declared_at timestamptz,
    ADD CONSTRAINT publications_declaration_with_time
        CHECK ((declaration IS NULL) = (declared_at IS NULL));
