# k6 High-Concurrency Stress Benchmark Suite (1,000+ RPS)

This directory contains the automated performance and stress test harness for the Distributed Idempotency Key Engine (DIKE) using [k6](https://k6.io/).

---

## Benchmark Profile

- **Virtual Users (VUs)**: 200 concurrent VUs ramping up to 500 VUs.
- **Target Throughput**: 1,200 requests per second (RPS).
- **Contention Key Pool**: 10 deterministic shared keys generating heavy lock contention and connection parking.
- **Service Level Objectives (SLOs)**:
  - `p99 latency < 5ms` for cached/parked responses.
  - `cache_hit_rate > 95%`.
  - `http_req_failed < 0.1%`.
  - Upstream execution is strictly executed once per key (`upstream_calls == number_of_unique_keys`).

---

## Running the Benchmark

### 1. Prerequisites
Install `k6` on your system:
```bash
# macOS
brew install k6

# Windows (Winget)
winget install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

### 2. Start the DIKE Server
```bash
npm run build
npm start
```

### 3. Execute the k6 Scenario
```bash
k6 run load-tests/k6-concurrency.js
```

Or target a remote cluster load balancer:
```bash
k6 run -e DIKE_BASE_URL=http://dike-lb.internal:8080 load-tests/k6-concurrency.js
```
