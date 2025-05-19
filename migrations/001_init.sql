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
    error TEXT,
    parent_id UUID NULL,
    retries INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS escalations (
    id UUID PRIMARY KEY,
    job_id UUID NOT NULL,
    wait_id VARCHAR NOT NULL,
    "user" VARCHAR NOT NULL,
    message TEXT NOT NULL,
    inputs JSONB NOT NULL,
    status VARCHAR NOT NULL,
    response JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
); 