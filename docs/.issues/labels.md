# DIKE Label Taxonomy & GitHub Issue Governance

This document establishes the official, industry-standard label taxonomy for the **Distributed Idempotency Key Engine (DIKE)** repository. All 74 platform issues conform strictly to this multidimensional schema.

---

## 1. Dimensional Label Schema

```
┌────────────────────────────────────────────────────────────────────────┐
│                        DIKE LABEL TAXONOMY                             │
├────────────────────┬───────────────────────────────────────────────────┤
│ Dimension          │ Format & Purpose                                  │
├────────────────────┼───────────────────────────────────────────────────┤
│ 1. Phase           │ phase:phase-[1-7] (Milestone alignment)           │
│ 2. Type            │ type:[feature|bug|security|perf|devops|chore]     │
│ 3. Priority        │ priority:[P0-critical|P1-high|P2-medium|P3-low]   │
│ 4. Component       │ component:[core|storage|proxy|mesh|ui|sec|sdk]    │
│ 5. Status          │ status:[ready|in-progress|blocked|completed]      │
└────────────────────┴───────────────────────────────────────────────────┘
```

---

## 2. Phase Labels (Evolutionary Milestones)

| Label | Color | Description |
| :--- | :--- | :--- |
| `phase:phase-1` | `#0E8A16` | Foundation & Core Engine (Issues 01–11) |
| `phase:phase-2` | `#1D76DB` | Distributed Concurrency & Connection Parking (Issues 12–23) |
| `phase:phase-3` | `#5319E7` | Transparent Reverse Proxy & Attestation Receipts (Issues 24–34) |
| `phase:phase-4` | `#B60205` | Gateway Ecosystem & Native Plugins (Issues 35–43) |
| `phase:phase-5` | `#FBCA04` | Developer Console & Audit Web UI (Issues 44–55) |
| `phase:phase-6` | `#D93F0B` | Advanced Security & Multi-Region Replication (Issues 56–65) |
| `phase:phase-7` | `#6F42C1` | Polyglot SDKs & Kubernetes Operator (Issues 66–74) |

---

## 3. Type Labels (Classification of Work)

| Label | Color | Description |
| :--- | :--- | :--- |
| `type:feature` | `#A2EEEF` | New architectural capability or user-facing feature |
| `type:security` | `#E11D48` | Cryptographic signing, isolation boundaries, or vulnerability mitigations |
| `type:reliability` | `#D97706` | Fail-safes, timeouts, circuit breakers, and crash recovery |
| `type:perf` | `#F59E0B` | Memory optimization, sub-microsecond latency, or SIMD acceleration |
| `type:test` | `#10B981` | Race-condition harnesses, chaos drills, and k6 load tests |
| `type:devops` | `#2563EB` | Docker containers, CI workflows, and Kubernetes manifests |
| `type:chore` | `#6B7280` | Scaffolding, dependency upgrades, and linter tooling |
| `type:docs` | `#4F46E5` | Technical specifications, runbooks, and API documentation |

---

## 4. Priority Labels (Execution Urgency)

| Label | Color | SLA / Scheduling Target |
| :--- | :--- | :--- |
| `priority:P0-critical` | `#B91C1C` | Must be completed to satisfy milestone exit gates; blocks downstream tiers |
| `priority:P1-high` | `#EA580C` | Core functional requirement; required for release stability |
| `priority:P2-medium` | `#D97706` | Secondary enhancement, SDK expansion, or optimization |
| `priority:P3-low` | `#64748B` | Nice-to-have visual refinement or developer ergonomic polish |

---

## 5. Component Labels (Subsystem Ownership)

| Component Label | Subsystem Scope |
| :--- | :--- |
| `component:core/engine` | Finite state machine, transition logic, error handling |
| `component:core/hasher` | BLAKE3 streaming digester and canonical JSON AST sorting |
| `component:core/parking` | Async EventEmitter connection parking and multiplexer |
| `component:storage/postgres` | PostgreSQL relational schema, row-level locks, migrations |
| `component:storage/redis` | Redis connection pools, atomic Lua leases, fencing tokens |
| `component:proxy` | Fastify reverse proxy plugin and stream tee forwarding |
| `component:security/attest` | HMAC-SHA256 and Ed25519 cryptographic receipts |
| `component:mesh/envoy` | Rust WebAssembly (WASM) filter for Envoy & Istio |
| `component:gateway/kong` | Kong Gateway native Lua plugin |
| `component:ui/console` | React 19 / Tailwind developer management console |
| `component:multi_region` | Active-Active WAN replication, Anycast DNS, CRDT state |
| `component:sdk/*` | Language SDKs (`sdk/python`, `sdk/java`, `sdk/go`, `sdk/rust`) |
| `component:k8s/operator` | Kubernetes Custom Resource Definition and mutating webhook |

---

## 6. Status Labels (Issue Lifecycle)

| Label | Color | Meaning |
| :--- | :--- | :--- |
| `status:ready` | `#10B981` | Specification approved; ready for implementation |
| `status:in-progress` | `#3B82F6` | Currently being developed in a feature branch |
| `status:blocked` | `#EF4444` | Dependent on an upstream issue completion |
| `status:review` | `#8B5CF6` | Pull Request open; awaiting Codeowner review |
| `status:completed` | `#6B7280` | Merged and verified via automated test suite |
