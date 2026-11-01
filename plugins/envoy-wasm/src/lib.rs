//! DIKE WebAssembly (WASM) Filter for Envoy Proxy.
//!
//! Provides root context and stream context hooks for inline idempotency key enforcement
//! inside Envoy worker threads without sidecar latency.

pub mod filter;

use filter::RequestDigester;
use log::{debug, info};
use proxy_wasm::traits::*;
use proxy_wasm::types::*;
use serde::Deserialize;

#[derive(Default, Clone, Debug, Deserialize, PartialEq, Eq)]
pub struct DikeFilterConfig {
    #[serde(default = "default_header_name")]
    pub idempotency_header: String,
    #[serde(default = "default_cluster_name")]
    pub dike_cluster: String,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_header_name() -> String {
    "idempotency-key".to_string()
}

fn default_cluster_name() -> String {
    "dike-service".to_string()
}

fn default_timeout_ms() -> u64 {
    2000
}

#[cfg(target_arch = "wasm32")]
proxy_wasm::main! {{
    proxy_wasm::set_log_level(LogLevel::Debug);
    proxy_wasm::set_root_context(|_| -> Box<dyn RootContext> {
        Box::new(DikeRootContext {
            config: DikeFilterConfig::default(),
        })
    });
}}

pub struct DikeRootContext {
    pub config: DikeFilterConfig,
}

impl Context for DikeRootContext {}

impl RootContext for DikeRootContext {
    fn on_vm_start(&mut self, _vm_configuration_size: usize) -> bool {
        info!("DIKE Envoy WASM VM initialized successfully");
        true
    }

    fn on_configure(&mut self, _plugin_configuration_size: usize) -> bool {
        if let Some(config_bytes) = self.get_plugin_configuration() {
            if !config_bytes.is_empty() {
                match serde_json::from_slice::<DikeFilterConfig>(&config_bytes) {
                    Ok(parsed) => {
                        info!("Loaded DIKE Envoy WASM configuration: {:?}", parsed);
                        self.config = parsed;
                    }
                    Err(err) => {
                        log::error!("Failed to parse DIKE WASM plugin configuration: {}", err);
                        return false;
                    }
                }
            }
        }
        true
    }

    fn create_http_context(&self, context_id: u32) -> Option<Box<dyn HttpContext>> {
        debug!("Creating DIKE HttpContext with ID: {}", context_id);
        Some(Box::new(DikeHttpContext {
            context_id,
            config: self.config.clone(),
            idempotency_key: None,
            digester: None,
            body_fingerprint: None,
        }))
    }

    fn get_type(&self) -> Option<ContextType> {
        Some(ContextType::HttpContext)
    }
}

pub struct DikeHttpContext {
    pub context_id: u32,
    pub config: DikeFilterConfig,
    pub idempotency_key: Option<String>,
    pub digester: Option<RequestDigester>,
    pub body_fingerprint: Option<String>,
}

impl Context for DikeHttpContext {}

impl HttpContext for DikeHttpContext {
    fn on_http_request_headers(&mut self, _num_headers: usize, end_of_stream: bool) -> Action {
        debug!(
            "[HttpContext {}] on_http_request_headers, end_of_stream={}",
            self.context_id, end_of_stream
        );

        if let Some(key_val) = self.get_http_request_header(&self.config.idempotency_header) {
            let trimmed = key_val.trim();
            if !trimmed.is_empty() {
                self.idempotency_key = Some(trimmed.to_string());
                debug!(
                    "[HttpContext {}] Found Idempotency-Key: {}",
                    self.context_id, trimmed
                );
            }
        }

        // If no idempotency key is present, pass through immediately (selective bypass)
        if self.idempotency_key.is_none() {
            return Action::Continue;
        }

        // Extract HTTP method and path for payload digest seeding
        let method = self
            .get_http_request_header(":method")
            .unwrap_or_else(|| "POST".to_string());
        let path = self
            .get_http_request_header(":path")
            .unwrap_or_else(|| "/".to_string());

        let mut digester = RequestDigester::new(&method, &path);

        // If request has no body (end_of_stream on headers)
        if end_of_stream {
            let fingerprint = digester.finalize();
            self.body_fingerprint = Some(fingerprint);
            return Action::Continue;
        }

        self.digester = Some(digester);
        Action::Continue
    }

    fn on_http_request_body(&mut self, body_size: usize, end_of_stream: bool) -> Action {
        debug!(
            "[HttpContext {}] on_http_request_body, size={}, end_of_stream={}",
            self.context_id, body_size, end_of_stream
        );

        // Fast bypass if request lacks Idempotency-Key
        if self.idempotency_key.is_none() {
            return Action::Continue;
        }

        let chunk = if body_size > 0 {
            self.get_http_request_body(0, body_size)
        } else {
            None
        };

        if let Some(ref mut digester) = self.digester {
            if let Some(ref data) = chunk {
                digester.update(data);
            }

            if end_of_stream {
                let fingerprint = digester.finalize();
                debug!(
                    "[HttpContext {}] Finalized BLAKE3 fingerprint: {}",
                    self.context_id, fingerprint
                );
                self.body_fingerprint = Some(fingerprint);

                // Await lease resolution from control plane or continue upstream
                return Action::Pause;
            }
        }

        // In streaming chunk mode, pause filter to buffer full body for deterministic hashing
        Action::Pause
    }

    fn on_http_response_headers(&mut self, _num_headers: usize, end_of_stream: bool) -> Action {
        debug!(
            "[HttpContext {}] on_http_response_headers, end_of_stream={}",
            self.context_id, end_of_stream
        );

        // Stamp gateway signature header indicating DIKE WASM filter processed request
        if self.idempotency_key.is_some() {
            self.set_http_response_header("x-dike-mesh-processed", Some("true"));
            if let Some(ref fp) = self.body_fingerprint {
                self.set_http_response_header("x-dike-payload-digest", Some(fp));
            }
        }

        Action::Continue
    }

    fn on_http_response_body(&mut self, body_size: usize, end_of_stream: bool) -> Action {
        debug!(
            "[HttpContext {}] on_http_response_body, size={}, end_of_stream={}",
            self.context_id, body_size, end_of_stream
        );
        Action::Continue
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = DikeFilterConfig::default();
        assert_eq!(config.idempotency_header, "idempotency-key");
        assert_eq!(config.dike_cluster, "dike-service");
        assert_eq!(config.timeout_ms, 2000);
    }

    #[test]
    fn test_custom_config_deserialization() {
        let json = r#"{"idempotency_header":"x-idempotency-key","dike_cluster":"custom-dike","timeout_ms":5000}"#;
        let config: DikeFilterConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.idempotency_header, "x-idempotency-key");
        assert_eq!(config.dike_cluster, "custom-dike");
        assert_eq!(config.timeout_ms, 5000);
    }

    #[test]
    fn test_root_context_lifecycle() {
        let mut root = DikeRootContext {
            config: DikeFilterConfig::default(),
        };
        assert!(root.on_vm_start(0));
        assert_eq!(root.get_type(), Some(ContextType::HttpContext));

        let _http_ctx = root.create_http_context(101).expect("http context created");
    }

    #[test]
    fn test_http_context_initialization() {
        let ctx = DikeHttpContext {
            context_id: 42,
            config: DikeFilterConfig::default(),
            idempotency_key: None,
            digester: None,
            body_fingerprint: None,
        };
        assert_eq!(ctx.context_id, 42);
        assert!(ctx.idempotency_key.is_none());
        assert!(ctx.digester.is_none());
        assert!(ctx.body_fingerprint.is_none());
    }
}
