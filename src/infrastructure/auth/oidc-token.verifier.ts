/**
 * OIDC / Keycloak JWT verification via JWKS (challenge §2 — 0 scoring points, presentation polish).
 */
import * as jose from "jose";

export interface OidcVerifyResult {
  sub: string;
  claims: Record<string, unknown>;
}

export class OidcTokenVerifier {
  private jwks: jose.JWTVerifyGetKey | null = null;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly jwksUri: string;

  constructor(options?: {
    issuer?: string;
    audience?: string;
    jwksUri?: string;
    /** Test injection — local JWKS, skips remote fetch */
    localJwks?: jose.JWTVerifyGetKey;
  }) {
    this.issuer =
      options?.issuer ??
      process.env["KEYCLOAK_ISSUER"] ??
      "http://localhost:8080/realms/jungle-gaming";
    this.audience = options?.audience ?? process.env["KEYCLOAK_AUDIENCE"] ?? "wagering-api";
    this.jwksUri =
      options?.jwksUri ??
      process.env["KEYCLOAK_JWKS_URI"] ??
      `${this.issuer}/protocol/openid-connect/certs`;
    if (options?.localJwks) {
      this.jwks = options.localJwks;
    }
  }

  private getJwks(): jose.JWTVerifyGetKey {
    if (!this.jwks) {
      this.jwks = jose.createRemoteJWKSet(new URL(this.jwksUri));
    }
    return this.jwks;
  }

  async verify(bearerToken: string): Promise<OidcVerifyResult> {
    const { payload } = await jose.jwtVerify(bearerToken, this.getJwks(), {
      issuer: this.issuer,
      audience: this.audience,
    });
    const sub = typeof payload.sub === "string" ? payload.sub : "";
    if (!sub) {
      throw new Error("OIDC token missing sub");
    }
    return { sub, claims: payload as Record<string, unknown> };
  }

  get configSummary(): { issuer: string; audience: string; jwksUri: string } {
    return { issuer: this.issuer, audience: this.audience, jwksUri: this.jwksUri };
  }
}
