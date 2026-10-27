# Security Policy

## 1. Supported Versions

Security updates and critical hotfixes are actively provided for the following development channels:

| Version Channel | Supported | Notes |
| :--- | :---: | :--- |
| `main` (trunk) | :white_check_mark: | Active development channel |
| `< 1.0.0` (alpha/beta) | :white_check_mark: | Actively hardened against distributed state vulnerabilities |

---

## 2. Reporting a Vulnerability

The Codeowners and engineering maintainers take security and cryptographic state integrity seriously. If you discover a potential vulnerability in the Distributed Idempotency Key Engine (DIKE)—such as:
- Distributed lease race conditions or zombie-writer fencing violations
- Hash collision bypasses or semantic AST payload discrepancies
- Authentication/Authorization bypass in control plane or admin routes
- Cryptographic receipt signature tampering (Ed25519 / HMAC)
- Unredacted customer secret leakage in telemetry streams

**DO NOT file a public GitHub issue.**

Please report security vulnerabilities privately via GitHub Coordinated Vulnerability Disclosure:
1. Navigate to the DIKE repository [Security Advisories tab](https://github.com/Inkesk-Dozing/DIKE/security/advisories/new).
2. Click **Report a vulnerability**.
3. Direct private correspondence to the Codeowners:
   - **Kushagra Bhardwaj**: `@kush05bhardwaj`
   - **Mrinal Prakash**: `@mrinalprakashfsd`

---

## 3. Vulnerability Response Timeline

Upon receipt of a vulnerability disclosure, the Codeowners commit to the following SLA:

- **Initial Acknowledgment**: Within 24 hours of submission.
- **Triage & Threat Assessment**: Within 48 hours, reproducing the defect and assessing the STRIDE threat category.
- **Remediation & Patch Release**: Critical vulnerabilities patched within 7 business days, accompanied by regression test coverage in `tests/race/` or `tests/security/`.
- **Public Disclosure**: Coordinated after affected deployments and hotfix releases have been published.

---

## 4. Threat Modeling Context

For a comprehensive breakdown of DIKE's STRIDE threat model, replay mitigations, and fencing token security architectures, consult [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
