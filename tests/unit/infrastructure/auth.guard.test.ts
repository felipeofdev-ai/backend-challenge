import { describe, expect, test } from "bun:test";
import { Reflector } from "@nestjs/core";
import * as jose from "jose";
import { AuthGuard } from "../../../src/infrastructure/auth/auth.guard";
import { OidcTokenVerifier } from "../../../src/infrastructure/auth/oidc-token.verifier";

function fakeContext(opts: {
  public?: boolean;
  authorization?: string;
}): Parameters<AuthGuard["canActivate"]>[0] {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        headers: {
          ...(opts.authorization !== undefined ? { authorization: opts.authorization } : {}),
        },
      }),
    }),
  } as never;
}

describe("Phase 10 · Auth extension (Keycloak/OIDC)", () => {
  test("AUTH_MODE=static + ALLOW_ANONYMOUS allows traffic (0 scoring points)", async () => {
    process.env["AUTH_MODE"] = "static";
    process.env["ALLOW_ANONYMOUS"] = "true";
    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector);
    expect(await guard.canActivate(fakeContext({}))).toBe(true);
  });

  test("AUTH_MODE=static + ALLOW_ANONYMOUS=false requires Bearer", async () => {
    process.env["AUTH_MODE"] = "static";
    process.env["ALLOW_ANONYMOUS"] = "false";
    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector);
    await expect(guard.canActivate(fakeContext({}))).rejects.toThrow();
    expect(await guard.canActivate(fakeContext({ authorization: "Bearer test-token" }))).toBe(true);
  });

  test("AUTH_MODE=oidc rejects garbage Bearer", async () => {
    process.env["AUTH_MODE"] = "oidc";
    process.env["KEYCLOAK_ISSUER"] = "http://localhost:8080/realms/jungle-gaming";
    process.env["KEYCLOAK_AUDIENCE"] = "wagering-api";
    process.env["KEYCLOAK_JWKS_URI"] = "http://127.0.0.1:1/jwks";
    const reflector = {
      getAllAndOverride: () => false,
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector);
    await expect(
      guard.canActivate(fakeContext({ authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.x" })),
    ).rejects.toThrow();
  });

  test("OidcTokenVerifier accepts locally signed JWT (JWKS contract)", async () => {
    const { privateKey, publicKey } = await jose.generateKeyPair("RS256");
    const issuer = "http://localhost:8080/realms/jungle-gaming";
    const audience = "wagering-api";
    const jwk = await jose.exportJWK(publicKey);
    jwk.kid = "test-key";
    jwk.alg = "RS256";
    jwk.use = "sig";

    const token = await new jose.SignJWT({ preferred_username: "provider-bot" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setSubject("provider-bot")
      .setIssuer(issuer)
      .setAudience(audience)
      .setExpirationTime("2h")
      .sign(privateKey);

    const verifier = new OidcTokenVerifier({
      issuer,
      audience,
      localJwks: jose.createLocalJWKSet({ keys: [jwk] }),
    });
    const verified = await verifier.verify(token);
    expect(verified.sub).toBe("provider-bot");
  });

  test("@Public routes bypass auth", async () => {
    process.env["AUTH_MODE"] = "oidc";
    const reflector = {
      getAllAndOverride: () => true,
    } as unknown as Reflector;
    const guard = new AuthGuard(reflector);
    expect(await guard.canActivate(fakeContext({}))).toBe(true);
  });
});
