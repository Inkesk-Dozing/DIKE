/**
 * Cryptographic HMAC-SHA256 & Ed25519 Attestation Receipt Signer for DIKE
 * Produces and validates verifiable cryptographic attestations proving that
 * replayed or stored responses originated legitimately from the DIKE engine without tampering.
 * Constant-time comparison ensures zero side-channel timing attack leakage.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import crypto from 'crypto';

export type AttestationAlgorithm = 'hmac-sha256' | 'ed25519';

export interface AttestationPayload {
  readonly tenantId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly statusCode: number;
  readonly timestamp: number;
}

export interface AttestationReceipt {
  readonly version: string;
  readonly algorithm: AttestationAlgorithm;
  readonly signature: string;
  readonly timestamp: number;
  readonly headerValue: string;
}

export interface AttestationSignerConfig {
  readonly algorithm?: AttestationAlgorithm | undefined;
  /**
   * Secret key for HMAC-SHA256 (minimum 32 bytes recommended),
   * OR Ed25519 private key in PEM format / KeyObject.
   */
  readonly secretKey: string | Buffer | crypto.KeyObject;
  /**
   * Optional Ed25519 public key in PEM format / KeyObject for verification.
   * If using HMAC, secretKey is used for verification.
   */
  readonly publicKey?: string | Buffer | crypto.KeyObject | undefined;
  /**
   * Key ID identifier embedded in receipts (e.g. 'k1'). Defaults to 'v1'.
   */
  readonly keyId?: string | undefined;
}

export const ATTESTATION_HEADER_NAME = 'x-dike-attestation';

export class AttestationReceiptSigner {
  private readonly algorithm: AttestationAlgorithm;
  private readonly secretKey: string | Buffer | crypto.KeyObject;
  private readonly publicKey?: string | Buffer | crypto.KeyObject | undefined;
  private readonly keyId: string;

  constructor(config: AttestationSignerConfig) {
    this.algorithm = config.algorithm ?? 'hmac-sha256';
    this.secretKey = config.secretKey;
    this.publicKey = config.publicKey;
    this.keyId = config.keyId ?? 'v1';

    if (!this.secretKey) {
      throw new Error('AttestationReceiptSigner requires a secretKey.');
    }
  }

  /**
   * Formats the payload into an immutable canonical byte sequence:
   * tenantId || key || fingerprint || statusCode || timestamp
   */
  public canonicalize(payload: AttestationPayload): string {
    return [
      payload.tenantId,
      payload.key,
      payload.fingerprint,
      payload.statusCode.toString(),
      payload.timestamp.toString(),
    ].join('|');
  }

  /**
   * Signs the canonical payload using either HMAC-SHA256 or Ed25519.
   */
  public sign(payload: Omit<AttestationPayload, 'timestamp'> & { timestamp?: number }): AttestationReceipt {
    const timestamp = payload.timestamp ?? Date.now();
    const fullPayload: AttestationPayload = {
      tenantId: payload.tenantId,
      key: payload.key,
      fingerprint: payload.fingerprint,
      statusCode: payload.statusCode,
      timestamp,
    };

    const canonical = this.canonicalize(fullPayload);
    let signatureHex: string;

    if (this.algorithm === 'hmac-sha256') {
      const hmac = crypto.createHmac('sha256', this.secretKey);
      hmac.update(canonical, 'utf-8');
      signatureHex = hmac.digest('hex');
    } else if (this.algorithm === 'ed25519') {
      // For Ed25519 in Node.js crypto.sign, algorithm parameter is null
      const sigBuf = crypto.sign(null, Buffer.from(canonical, 'utf-8'), this.secretKey as any);
      signatureHex = sigBuf.toString('hex');
    } else {
      throw new Error(`Unsupported attestation algorithm: ${this.algorithm}`);
    }

    const headerValue = `${this.keyId};alg=${this.algorithm};sig=${signatureHex};ts=${timestamp}`;

    return {
      version: this.keyId,
      algorithm: this.algorithm,
      signature: signatureHex,
      timestamp,
      headerValue,
    };
  }

  /**
   * Verifies an attestation receipt against a payload in constant-time.
   */
  public verify(payload: AttestationPayload, headerOrReceipt: string | AttestationReceipt): boolean {
    let headerStr: string;
    if (typeof headerOrReceipt === 'string') {
      headerStr = headerOrReceipt;
    } else {
      headerStr = headerOrReceipt.headerValue;
    }

    // Format: keyId;alg=...;sig=...;ts=... OR v1;sig=...;ts=...
    const parts = headerStr.split(';');
    if (parts.length < 3) {
      return false;
    }

    let extractedAlg: AttestationAlgorithm = 'hmac-sha256';
    let extractedSig = '';
    let extractedTs = 0;

    for (const part of parts) {
      const [k, v] = part.split('=');
      if (!k || !v) continue;
      const keyTrimmed = k.trim().toLowerCase();
      const valTrimmed = v.trim();

      if (keyTrimmed === 'alg') {
        extractedAlg = valTrimmed.toLowerCase() as AttestationAlgorithm;
      } else if (keyTrimmed === 'sig') {
        extractedSig = valTrimmed;
      } else if (keyTrimmed === 'ts') {
        extractedTs = parseInt(valTrimmed, 10);
      }
    }

    if (!extractedSig || !extractedTs || Number.isNaN(extractedTs)) {
      return false;
    }

    // Verify canonical payload
    const canonical = this.canonicalize({
      ...payload,
      timestamp: extractedTs,
    });

    if (extractedAlg === 'hmac-sha256') {
      const hmac = crypto.createHmac('sha256', this.secretKey);
      hmac.update(canonical, 'utf-8');
      const expectedSigHex = hmac.digest('hex');

      const expectedBuf = Buffer.from(expectedSigHex, 'hex');
      const actualBuf = Buffer.from(extractedSig, 'hex');

      if (expectedBuf.length !== actualBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, actualBuf);
    } else if (extractedAlg === 'ed25519') {
      const keyForVerify = this.publicKey ?? this.secretKey;
      try {
        const sigBuf = Buffer.from(extractedSig, 'hex');
        return crypto.verify(
          null,
          Buffer.from(canonical, 'utf-8'),
          keyForVerify as any,
          sigBuf
        );
      } catch {
        return false;
      }
    }

    return false;
  }
}
