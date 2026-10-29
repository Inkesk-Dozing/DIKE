/**
 * Monotonically Increasing Fencing Tokens & Zombie Writer Defenses
 * Provides mathematical validation, monotonic token ordering, and zombie writer mitigation across tiers.
 * Proprietary Software - (c) 2026 Kushagra Bhardwaj & Mrinal Prakash
 */

import { FencingTokenViolationError } from './types.js';

export interface FencingVerificationResult {
  readonly valid: boolean;
  readonly activeToken: bigint;
  readonly candidateToken: bigint;
  readonly reason?: string | undefined;
}

export class FencingTokenGuard {
  /**
   * Asserts that a candidate token is strictly greater than or equal to the active lease token.
   * Throws FencingTokenViolationError if a zombie writer attempt is detected.
   */
  public static assertValid(key: string, activeToken: bigint, candidateToken?: bigint | undefined): void {
    if (candidateToken === undefined) {
      return;
    }

    if (candidateToken < activeToken) {
      throw new FencingTokenViolationError(key, activeToken, candidateToken);
    }
  }

  /**
   * Evaluates candidate token validity without throwing, returning a structured verification result.
   */
  public static verify(activeToken: bigint, candidateToken?: bigint | undefined): FencingVerificationResult {
    const candidate = candidateToken ?? 0n;
    if (candidateToken !== undefined && candidateToken < activeToken) {
      return {
        valid: false,
        activeToken,
        candidateToken: candidate,
        reason: `Zombie writer rejected: candidate token (${candidate.toString()}) is less than active fencing token (${activeToken.toString()}).`,
      };
    }

    return {
      valid: true,
      activeToken,
      candidateToken: candidate,
    };
  }

  /**
   * Calculates the next monotonically increasing fencing token.
   */
  public static nextToken(currentToken?: bigint | undefined): bigint {
    if (currentToken === undefined || currentToken < 1n) {
      return 1n;
    }
    return currentToken + 1n;
  }
}
