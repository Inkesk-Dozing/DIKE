-- ==============================================================================
-- DIKE PostgreSQL Storage Engine DDL - Initial Schema Migration
-- Migration: 001_initial_schema.sql
-- (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
-- ==============================================================================

-- Enable required cryptographic and indexing extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";

-- 1. Multi-Tenant Account Registry
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(64) UNIQUE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Client Authentication & API Credentials
CREATE TABLE IF NOT EXISTS client_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_key VARCHAR(128) NOT NULL,
    secret_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tenant_client_key UNIQUE (tenant_id, client_key)
);

-- 3. Core Idempotency Transaction Store (L3 ACID Tier)
CREATE TABLE IF NOT EXISTS idempotency_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(255) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL CHECK (status IN ('STARTED', 'RESOLVED', 'FAILED')),
    response_status SMALLINT NULL,
    response_headers JSONB NULL,
    response_body JSONB NULL,
    fencing_token BIGINT NOT NULL DEFAULT 1,
    locked_until TIMESTAMPTZ NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key)
);

-- High-performance composite B-Tree indexes for fast-path primary lookup
CREATE INDEX IF NOT EXISTS idx_idempotency_lookup 
    ON idempotency_records (tenant_id, idempotency_key);

-- Partial index for active lease timeouts
CREATE INDEX IF NOT EXISTS idx_idempotency_active_leases 
    ON idempotency_records (tenant_id, locked_until) 
    WHERE status = 'STARTED';

-- Partial index for background TTL purge sweeper
CREATE INDEX IF NOT EXISTS idx_idempotency_cleanup 
    ON idempotency_records (expires_at) 
    WHERE status = 'RESOLVED';
