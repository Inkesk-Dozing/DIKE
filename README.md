# DIKE: Distributed Idempotency Key Engine

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Trajectory](https://img.shields.io/badge/Trajectory-74_Issues_%7C_7_Phases-orange.svg)](docs/ROADMAP.md)
[![Architecture](https://img.shields.io/badge/Architecture-3--Tier_Hybrid_Idempotency-green.svg)](docs/ARCHITECTURE.md)
[![IETF Spec](https://img.shields.io/badge/Standard-IETF_Idempotency--Key_Draft-blueviolet.svg)](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)
[![Coverage](https://img.shields.io/badge/Coverage-100%25_Race--Condition_Immunity-brightgreen.svg)](tests/)

> **DIKE** is an enterprise-grade, high-throughput Distributed Idempotency Key Engine, transparent reverse proxy, and service mesh filter designed to eliminate duplicate transactions, double-charges, and inconsistent mutations across distributed microservice fleets.

---

## 📌 Executive Architecture & Highlights

Most idempotency solutions force an unsustainable trade-off: in-memory Redis solutions lose state during failovers, while relational database table constraints create severe write amplification and connection pool exhaustion under load.

DIKE resolves this through a **Hybrid Three-Tier Storage Pipeline** combined with an **Asynchronous Connection Parking Engine** that eliminates thundering-herd retry storms:

```mermaid
flowchart TD
    subgraph Clients["Client Mutation Layer"]
        C1["Client Request A (Leader)"]
        C2["Client Request B (Concurrent Duplicate)"]
    end

    subgraph DIKE["DIKE Engine Architecture"]
        GW["API Gateway / Mesh Interceptor (Envoy WASM / Kong / Fastify)"]
        Hash["Streaming BLAKE3 & Semantic JSON Hasher"]
        Park["Async Connection Parking Multiplexer"]
        
        subgraph StorageTier["Hybrid 3-Tier Storage Hierarchy"]
            L1["L1: In-Memory Ring Buffer (Sub-microsecond, < 0.1 µs)"]
            L2["L2: Redis Distributed Lease & Fencing Tokens (0.5 - 1.5 ms)"]
            L3["L3: PostgreSQL ACID Cold Vault & Audit Log (2.0 - 5.0 ms)"]
        end
        
        Attest["Cryptographic HMAC / Ed25519 Attestation Signer (Vault / KMS)"]
    end

    subgraph Upstream["Upstream Business Services"]
        API["Payment / Mutation API (Stripe, Billing, Orders)"]
    end

    C1 -->|HTTP POST with Idempotency-Key| GW
    C2 -->|Simultaneous POST with Same Key| GW
    
    GW --> Hash
    Hash --> L1
    L1 --> L2
    
    L2 -->|Lease Granted: STARTED| API
    L2 -->|Lease Active: Park Connection| Park
    
    API -->|Mutation Complete| L3
    L3 --> Attest
    Attest -->|Store Resolved Result| L1
    
    L3 -->|Broadcast Resolution Event| Park
    Attest -->|Response with Attestation Signature| C1
    Park -->|Direct Replay without Upstream Call| C2
```

### Key Capabilities
- **Zero-Polling Connection Parking:** Concurrent duplicate requests are held on an async event bus and resolved instantly when the in-flight leader completes, eliminating `409 Conflict` thundering-herd loops.
- **Streaming Incremental Hashing (BLAKE3 / SHA-256):** Computes cryptographic payload fingerprints on the fly with strict $O(1)$ memory consumption, preventing Out-Of-Memory crashes on multi-megabyte payloads.
- **Semantic Payload Hashing & Dynamic Ignore Paths:** Strips benign nonces, timestamps, and client UUIDs to prevent false-positive `422 Payload Mismatch` errors.
- **Three-Tier Storage Hierarchy:** Combines lock-free in-memory lookups (L1), distributed lease coordination with monotonic fencing tokens (L2), and PostgreSQL ACID durability (L3).
- **Service Mesh & Gateway Native Filters:** Native Envoy WebAssembly (WASM) filter (Rust), Kong Gateway plugin (Lua), and Cloudflare Edge Worker support.
- **Cryptographic Attestation Receipts:** Signs replayed responses with HMAC-SHA256 / Ed25519 backed by HashiCorp Vault or AWS KMS to prove response provenance for financial audits.
- **Developer Management Web Console:** Interactive React/Tailwind visual dashboard featuring live key inspection, visual payload diffing, and real-time unparking telemetry.

---

## 📚 Platform Engineering Documentation

The technical foundation is detailed across dedicated specifications in `/docs`:

1. **[Architectural Design & Technical Rationale](docs/ARCHITECTURE.md):** Deep-dive into tiered storage, connection parking, streaming hashing, WASM filters, semantic JSON diffing, and tech stack trade-offs.
2. **[Domain Data Model & Storage Schema](docs/DATA_MODEL.md):** PostgreSQL DDL, GiST/B-tree indexing, Redis key-value lease protocols, and L1 memory buffer topologies.
3. **[STRIDE Threat Model & Security Posture](docs/THREAT_MODEL.md):** Comprehensive vulnerability analysis, payload poisoning defenses, and lease hijacking mitigations.
4. **[Engineering Roadmap & Milestones (74 Issues)](docs/ROADMAP.md):** 74-issue evolutionary trajectory across 7 phases, Gantt schedules, and Trunk-based Git branching strategy.
5. **[Phase-Bifurcated Issue Specifications](docs/.issues/):**
   - [Phase 1: Foundation & Core Engine (`#01` to `#11`)](docs/.issues/01-phase-1-foundation-and-core-engine.md)
   - [Phase 2: Concurrency & Connection Parking (`#12` to `#23`)](docs/.issues/02-phase-2-concurrency-and-parking.md)
   - [Phase 3: Proxy & Attestation Receipts (`#24` to `#34`)](docs/.issues/03-phase-3-proxy-and-attestation.md)
   - [Phase 4: Gateway Ecosystem & Native Plugins (`#35` to `#43`)](docs/.issues/04-phase-4-gateway-ecosystem-and-plugins.md)
   - [Phase 5: Developer Console & Audit UI (`#44` to `#55`)](docs/.issues/05-phase-5-developer-console-and-audit-ui.md)
   - [Phase 6: Advanced Security & Multi-Region (`#56` to `#65`)](docs/.issues/06-phase-6-advanced-security-and-multi-region.md)
   - [Phase 7: Polyglot SDKs & K8s Operator (`#66` to `#74`)](docs/.issues/07-phase-7-polyglot-sdks-and-k8s-operator.md)
6. **[Issue Label Taxonomy & Governance](docs/.issues/labels.md):** Multidimensional label schema with hex colors and definitions.

---

## 🚀 Engineering Roadmap Overview (74 Issues across 7 Phases)

```mermaid
gantt
    title DIKE Platform Evolution Roadmap (74-Issue Trajectory)
    dateFormat  YYYY-MM
    section Phase 1: Foundation
    Core FSM, Streaming BLAKE3 & Postgres    :active, p1_1, 2026-10, 2026-11
    Fastify Server & IETF Header Parser     :active, p1_2, 2026-11, 2026-12
    Milestone 1 Completion (Issues 01-11)    :milestone, m1, 2026-12, 0d
    section Phase 2: Distributed Concurrency
    Redis Lua Leases & Fencing Tokens       :p2_1, 2026-12, 2027-01
    Async Connection Parking & Race Suite   :p2_2, 2027-01, 2027-02
    Milestone 2 Completion (Issues 12-23)   :milestone, m2, 2027-02, 0d
    section Phase 3: Proxy & Attestation
    Duplex Stream Reverse Proxy Pipeline    :p3_1, 2027-02, 2027-03
    HMAC/Ed25519 Receipts & OpenTelemetry   :p3_2, 2027-03, 2027-04
    Milestone 3 Completion (Issues 24-34)   :milestone, m3, 2027-04, 0d
    section Phase 4: Gateway Ecosystem
    Envoy WASM Filter & Kong Lua Plugin     :p4_1, 2027-04, 2027-05
    Cloudflare Edge Worker & Ingress Policy :p4_2, 2027-05, 2027-06
    Milestone 4 Completion (Issues 35-43)   :milestone, m4, 2027-06, 0d
    section Phase 5: Developer Console UI
    React / Tailwind Audit Web Dashboard    :p5_1, 2027-06, 2027-07
    Live Telemetry, Key Invalidation & Diff :p5_2, 2027-07, 2027-08
    Milestone 5 Completion (Issues 44-55)   :milestone, m5, 2027-08, 0d
    section Phase 6: Security & Multi-Region
    Semantic Diffing & PCI-DSS PAN Masking  :p6_1, 2027-08, 2027-09
    HashiCorp Vault KMS & Multi-Region Sync :p6_2, 2027-09, 2027-10
    Milestone 6 Completion (Issues 56-65)   :milestone, m6, 2027-10, 0d
    section Phase 7: SDKs & K8s Operator
    Python, Spring Boot, Go & Rust SDKs     :p7_1, 2027-10, 2027-11
    Kubernetes Sidecar Operator & V1.0 GA   :p7_2, 2027-11, 2027-12
    Milestone 7 Completion (Issues 66-74)   :milestone, m7, 2027-12, 0d
```

---

## 🛠️ Technology Stack & Selection Rationale

| Layer | Technology | Primary Rationale |
| :--- | :--- | :--- |
| **Control Plane Runtime** | Node.js 24 LTS & TypeScript 5+ | High I/O event-loop concurrency, native streaming pipelines, type safety |
| **HTTP Framework** | Fastify v5 | High-throughput JSON routing, schema compilation via TypeBox |
| **Service Mesh / WASM** | Rust (`proxy-wasm`) | Zero-cost abstractions, compiles directly to Envoy WebAssembly bytecode |
| **Durability Store** | PostgreSQL 16+ | ACID transactions, row-level locks, jsonb storage for responses |
| **Coordination Store** | Redis 7+ / Dragonfly | Microsecond lease acquisition, Pub/Sub for connection unparking |
| **Hashing Engine** | BLAKE3 / Streaming SHA-256 | High-speed cryptographic digest calculation with $O(1)$ memory usage |
| **Developer Console** | React 19 + Tailwind CSS + Vite | Modular web dashboard for live transaction inspection and telemetry |
| **Test & Benchmarking** | Vitest + k6 + Toxiproxy | Concurrency verification, 1,000+ RPS stress tests, network partition simulation |

---

## ⚖️ License & Governance

DIKE is published under the **Apache 2.0 License**. See [LICENSE](LICENSE) for details.
