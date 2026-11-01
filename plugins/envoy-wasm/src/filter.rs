//! HTTP Header and Streaming Body Digest Interceptor for DIKE Envoy WASM Filter.
//!
//! Inspects Idempotency-Key headers, computes incremental BLAKE3 digests across body chunks,
//! and determines stream progression (Pause vs Continue).

use blake3::Hasher;

#[derive(Debug)]
pub struct RequestDigester {
    hasher: Hasher,
    method: String,
    path: String,
    bytes_hashed: usize,
    finalized_hash: Option<String>,
}

impl RequestDigester {
    /// Initialize digester with HTTP method and path
    pub fn new(method: &str, path: &str) -> Self {
        let mut hasher = Hasher::new();
        // Seed hasher with Method + Path separator
        hasher.update(method.as_bytes());
        hasher.update(b"\n");
        hasher.update(path.as_bytes());
        hasher.update(b"\n");

        Self {
            hasher,
            method: method.to_string(),
            path: path.to_string(),
            bytes_hashed: 0,
            finalized_hash: None,
        }
    }

    /// Append body chunk bytes to the streaming digest
    pub fn update(&mut self, chunk: &[u8]) {
        if self.finalized_hash.is_none() {
            self.hasher.update(chunk);
            self.bytes_hashed += chunk.len();
        }
    }

    /// Finalize and return hex-encoded 64-character BLAKE3 hash
    pub fn finalize(&mut self) -> String {
        if let Some(ref hash) = self.finalized_hash {
            return hash.clone();
        }

        let hash_output = self.hasher.finalize();
        let hex = hash_output.to_hex().to_string();
        self.finalized_hash = Some(hex.clone());
        hex
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn bytes_hashed(&self) -> usize {
        self.bytes_hashed
    }

    pub fn is_finalized(&self) -> bool {
        self.finalized_hash.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_digester_single_chunk() {
        let mut d = RequestDigester::new("POST", "/v1/charge");
        d.update(b"{\"amount\":100}");
        let hash = d.finalize();

        assert_eq!(hash.len(), 64);
        assert_eq!(d.bytes_hashed(), 14);
        assert!(d.is_finalized());
    }

    #[test]
    fn test_digester_multiple_chunks_match_single_chunk() {
        let mut d1 = RequestDigester::new("POST", "/v1/charge");
        d1.update(b"{\"amount\":");
        d1.update(b"100}");
        let hash1 = d1.finalize();

        let mut d2 = RequestDigester::new("POST", "/v1/charge");
        d2.update(b"{\"amount\":100}");
        let hash2 = d2.finalize();

        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_different_path_produces_different_hash() {
        let mut d1 = RequestDigester::new("POST", "/v1/charge");
        d1.update(b"{\"amount\":100}");
        let hash1 = d1.finalize();

        let mut d2 = RequestDigester::new("POST", "/v1/refund");
        d2.update(b"{\"amount\":100}");
        let hash2 = d2.finalize();

        assert_ne!(hash1, hash2);
    }
}

