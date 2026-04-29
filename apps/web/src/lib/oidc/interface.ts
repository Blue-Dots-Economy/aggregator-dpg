/**
 * OIDC identity-provider contract.
 *
 * The portal BFF speaks only to this surface. A different IdP (Auth0,
 * FusionAuth, etc.) can be plugged in by writing a new subclass — no other
 * portal code changes.
 */

export interface AuthorizationUrlInput {
  state: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  scope?: string;
}

export interface ExchangeCodeInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  state: string;
  expectedState: string;
  expectedNonce: string;
  /** Full set of callback query params. Required so iss/session_state etc.
   *  reach the OIDC client for RFC 9207 verification. */
  callbackParams?: Record<string, string>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accessTokenExp: number;
  refreshTokenExp: number;
  scope?: string;
}

export interface IdClaims {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  name?: string;
  preferredUsername?: string;
}

export interface LogoutUrlInput {
  idToken: string;
  postLogoutRedirectUri: string;
}

export type OidcResult<T> = { ok: true; value: T } | { ok: false; error: OidcError };

export type OidcError =
  | { code: 'DISCOVERY_FAILED'; message: string }
  | { code: 'STATE_MISMATCH'; message: string }
  | { code: 'TOKEN_EXCHANGE_FAILED'; message: string }
  | { code: 'TOKEN_VERIFY_FAILED'; message: string }
  | { code: 'REFRESH_FAILED'; message: string };

/**
 * Abstract identity-provider port.
 */
export abstract class IdentityProviderAdapter {
  abstract buildAuthorizationUrl(input: AuthorizationUrlInput): Promise<string>;
  abstract exchangeCode(
    input: ExchangeCodeInput,
  ): Promise<OidcResult<{ tokens: TokenSet; claims: IdClaims }>>;
  abstract refresh(refreshToken: string): Promise<OidcResult<TokenSet>>;
  abstract buildLogoutUrl(input: LogoutUrlInput): Promise<string>;
}
