-- A maker's note on a publication: one short line of plain text, optional, and the only part of a
-- publication that its maker can change afterwards (with the manage key). It is NOT part of the content
-- record, so the record id and the audio never depend on it. `note_updated_at` lets the operator see that
-- a note was changed after a report was filed. The service enforces its configured length; the table
-- allows up to 400 characters so the service limit can be raised without a migration.
ALTER TABLE publications
    ADD COLUMN note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 400),
    ADD COLUMN note_updated_at timestamptz;
