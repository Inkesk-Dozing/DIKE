//! Envoy Asynchronous Redis / Control Plane Client via Envoy Cluster Dispatch Protocol.
//!
//! WebAssembly running in Envoy cannot open raw TCP sockets; it dispatches asynchronous
//! HTTP / Redis calls through Envoy's cluster dispatch subsystem and handles responses
//! in `on_http_call_response` callback without blocking Envoy worker threads.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdempotencyCheckRequest {
    pub tenant_id: String,
    pub idempotency_key: String,
    pub payload_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LeaseStatus {
    Acquired,
    Hit,
    Mismatch,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdempotencyCheckResponse {
    pub status: LeaseStatus,
    pub cached_status_code: Option<u16>,
    pub cached_headers: Option<std::collections::HashMap<String, String>>,
    pub cached_body: Option<String>,
}

pub struct AsyncClusterClient {
    cluster_name: String,
    timeout: Duration,
}

impl AsyncClusterClient {
    pub fn new(cluster_name: &str, timeout_ms: u64) -> Self {
        Self {
            cluster_name: cluster_name.to_string(),
            timeout: Duration::from_millis(timeout_ms),
        }
    }

    pub fn cluster_name(&self) -> &str {
        &self.cluster_name
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    /// Formats payload into JSON bytes for dispatch
    pub fn prepare_dispatch_body(req: &IdempotencyCheckRequest) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(req)
    }

    /// Parses cluster response payload
    pub fn parse_response(body_bytes: &[u8]) -> Result<IdempotencyCheckResponse, serde_json::Error> {
        serde_json::from_slice(body_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_init() {
        let client = AsyncClusterClient::new("redis-cluster", 2500);
        assert_eq!(client.cluster_name(), "redis-cluster");
        assert_eq!(client.timeout(), Duration::from_millis(2500));
    }

    #[test]
    fn test_prepare_and_parse_response_hit() {
        let req = IdempotencyCheckRequest {
            tenant_id: "t_acme".to_string(),
            idempotency_key: "tx_123".to_string(),
            payload_hash: "abc123blake3".to_string(),
        };
        let body = AsyncClusterClient::prepare_dispatch_body(&req).unwrap();
        assert!(!body.is_empty());

        let raw_res = r#"{
            "status": "Hit",
            "cached_status_code": 200,
            "cached_headers": {"content-type": "application/json"},
            "cached_body": "{\"success\":true}"
        }"#;

        let res = AsyncClusterClient::parse_response(raw_res.as_bytes()).unwrap();
        assert_eq!(res.status, LeaseStatus::Hit);
        assert_eq!(res.cached_status_code, Some(200));
        assert_eq!(res.cached_body, Some("{\"success\":true}".to_string()));
    }

    #[test]
    fn test_parse_response_acquired() {
        let raw_res = r#"{"status": "Acquired", "cached_status_code": null, "cached_headers": null, "cached_body": null}"#;
        let res = AsyncClusterClient::parse_response(raw_res.as_bytes()).unwrap();
        assert_eq!(res.status, LeaseStatus::Acquired);
    }
}
