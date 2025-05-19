-- Example initial migration
CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY,
    state_machine VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    context JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    started_at TIMESTAMP,
    finished_at TIMESTAMP,
    error TEXT
); 