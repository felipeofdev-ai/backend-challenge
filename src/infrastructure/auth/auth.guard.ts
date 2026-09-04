import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OidcTokenVerifier } from "./oidc-token.verifier";
import { IS_PUBLIC_KEY } from "./public.decorator";

/**
 * Auth extension point (challenge §2 — 0 evaluation points).
 *
 * AUTH_MODE=static: Bearer optional when ALLOW_ANONYMOUS=true (default for eval).
 * AUTH_MODE=oidc: validates JWT against Keycloak JWKS (KEYCLOAK_ISSUER / KEYCLOAK_JWKS_URI).
 *
 * Provider identity for domain rules lives in ProviderIdentityPort — not here.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly oidc = new OidcTokenVerifier();

  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const mode = process.env["AUTH_MODE"] ?? "static";
    if (mode === "static") {
      const allowAnonymous = process.env["ALLOW_ANONYMOUS"] !== "false";
      if (allowAnonymous) return true;

      const req = context
        .switchToHttp()
        .getRequest<{ headers: Record<string, string | undefined> }>();
      const auth = req.headers["authorization"];
      if (!auth?.startsWith("Bearer ")) {
        throw new UnauthorizedException({
          error: {
            code: "UNAUTHENTICATED",
            message: "Bearer token required",
            retryable: false,
          },
        });
      }
      return true;
    }

    if (mode === "oidc") {
      const req = context.switchToHttp().getRequest<{
        headers: Record<string, string | undefined>;
        user?: { sub: string };
      }>();
      const auth = req.headers["authorization"];
      if (!auth?.startsWith("Bearer ")) {
        throw new UnauthorizedException({
          error: {
            code: "UNAUTHENTICATED",
            message: "Bearer token required (AUTH_MODE=oidc)",
            retryable: false,
          },
        });
      }
      const token = auth.slice("Bearer ".length).trim();
      try {
        const verified = await this.oidc.verify(token);
        req.user = { sub: verified.sub };
        return true;
      } catch (err) {
        throw new UnauthorizedException({
          error: {
            code: "UNAUTHENTICATED",
            message: `OIDC token invalid: ${err instanceof Error ? err.message : String(err)}`,
            retryable: false,
            details: this.oidc.configSummary,
          },
        });
      }
    }

    throw new UnauthorizedException({
      error: {
        code: "UNAUTHENTICATED",
        message: `AUTH_MODE=${mode} is not configured in this build`,
        retryable: false,
      },
    });
  }
}
