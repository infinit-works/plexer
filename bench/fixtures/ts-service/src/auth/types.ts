export interface SessionClaims {
  sub: string;
  tenantId: string;
  exp: number;
  kid: string;
}

export interface Verifier {
  verify(token: string, nowSeconds?: number): Promise<SessionClaims>;
}

export interface JwkKey {
  kid: string;
  publicPem: string;
  retiredAt?: number;
}
