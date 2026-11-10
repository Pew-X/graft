-- The orphan cleanup asks, for each stored blob, whether any content record still names it as the
-- audio it was cut from or as its output. Both lookups need an index.
CREATE INDEX content_records_source_blob ON content_records (source_blob);
CREATE INDEX content_records_output_blob ON content_records (output_blob);
