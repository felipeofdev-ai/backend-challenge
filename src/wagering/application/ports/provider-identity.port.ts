export interface ProviderIdentity {
  providerId: string;
  active: boolean;
}

/**
 * Port for trusted provider identity (challenge §2 — 0 scoring points).
 * Domain gate that the provider is known/active — not HTTP authentication.
 */
export interface ProviderIdentityPort {
  resolve(providerId: string): Promise<ProviderIdentity | null>;
}

/** Default: accept any non-empty providerId (open provider registry for the challenge). */
export class StaticProviderIdentityAdapter implements ProviderIdentityPort {
  async resolve(providerId: string): Promise<ProviderIdentity | null> {
    const id = providerId.trim();
    if (!id) return null;
    return { providerId: id, active: true };
  }
}
