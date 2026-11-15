import { createVerify } from "node:crypto";
import type { JwkKey, SessionClaims, Verifier } from "./types.ts";

/**
 * Verifies signed JSON web tokens against a rotating set of public keys
 * while permitting a configurable clock skew tolerance window.
 */
export class TokenVerifier implements Verifier {
  private readonly keysById = new Map<string, JwkKey>();
  private readonly skewToleranceSec: number;

  constructor(keys: JwkKey[], skewToleranceSec = 30) {
    this.skewToleranceSec = skewToleranceSec;
    this.rotateKeys(keys);
  }

  rotateKeys(keys: JwkKey[]): void {
    this.keysById.clear();
    for (const key of keys) {
      this.keysById.set(key.kid, key);
    }
  }

  async verify(token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<SessionClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new Error("Malformed token segments");
    }
    const [encodedHeader, encodedPayload, encodedSig] = parts;
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    const jwk = this.keysById.get(header.kid);
    if (!jwk) {
      throw new Error(`Unknown signing key id: ${header.kid}`);
    }

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    if (!verifier.verify(jwk.publicPem, Buffer.from(encodedSig, "base64url"))) {
      throw new Error("Invalid token signature");
    }

    const claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as SessionClaims;
    if (claims.exp + this.skewToleranceSec < nowSeconds) {
      throw new Error("Token expired beyond clock skew tolerance");
    }
    return claims;
  }
}

export function extractBearerToken(headerValue: string | undefined): string {
  if (!headerValue?.startsWith("Bearer ")) {
    throw new Error("Missing Bearer authorization header");
  }
  return headerValue.slice("Bearer ".length).trim();
}
