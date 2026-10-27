# Contributing to DIKE

Thank you for your interest in contributing to the Distributed Idempotency Key Engine (DIKE).

As a proprietary distributed infrastructure platform, all contributions must adhere to strict code-quality, cryptographic safety, and architectural standards enforced by the repository Codeowners:
- **Kushagra Bhardwaj**: `@kush05bhardwaj`
- **Mrinal Prakash**: `@mrinalprakashfsd`

---

## 1. Development & Branching Workflow

We utilize a Gitflow-derived trunk development model:

1. **Create an Issue Branch**:
   - Feature branches: `feat/<issue-number>-<short-description>` (e.g. `feat/1-project-scaffolding`)
   - Bugfix branches: `fix/<issue-number>-<short-description>`
   - Refactor branches: `refactor/<short-description>`
2. **Synchronize with Trunk**: Ensure your local branch is rebased on `main` before submitting a Pull Request.
3. **Run Quality Gates**: Ensure all linting, static analysis, and Vitest suites pass locally before pushing.

---

## 2. Commit Message Standards (Conventional Commits)

All commit messages must follow the [Conventional Commits v1.0.0](https://www.conventionalcommits.org/) specification:

```text
<type>(<scope>): <short description in present tense>

[optional body describing technical rationale and architectural impact]

[optional footer referencing issue, e.g. Fixes #1]
```

### Approved Types
- `feat`: A new architectural capability, route, or engine feature
- `fix`: A bug fix or race-condition remediation
- `docs`: Documentation modifications or visual diagram updates
- `test`: Addition or refactoring of unit, integration, or k6 stress tests
- `perf`: Latency reduction, SIMD acceleration, or memory optimization
- `refactor`: Code reorganization with zero change to external contract
- `chore`: Tooling, dependency maintenance, or CI pipeline modifications

---

## 3. Code Quality & Architecture Constraints

- **Language Runtime**: Node.js 24 LTS with TypeScript 5+.
- **Strict Typing**: Compiles under `exactOptionalPropertyTypes`, `strictNullChecks`, and `noUncheckedIndexedAccess`. Zero use of `any`.
- **Zero Heavy Unused Dependencies**: All dependencies must have proven high throughput and active maintenance.
- **Pure State Transitions**: The FSM core (`src/core/fsm.ts`) and streaming hasher (`src/core/hasher.ts`) must remain pure and free from hidden I/O side-effects.

---

## 4. Testing & Verification

- Every new functional capability must include comprehensive test coverage in Vitest.
- State machines and distributed lock components require exhaustive boundary condition tests and race condition simulation harnesses.
- PRs that reduce overall test coverage will not be merged.

---

## 5. Pull Request Review Process

1. Open your PR against `main`.
2. Link the corresponding GitHub issue in the PR description (e.g., `Resolves #1`).
3. Mandatory codeowner review: Every PR requires formal review and approval from either `@kush05bhardwaj` or `@mrinalprakashfsd` before merging.
