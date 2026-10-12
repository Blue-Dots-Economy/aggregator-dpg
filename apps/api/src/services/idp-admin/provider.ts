/**
 * Provider key under which this deployment's IdP logins are recorded in
 * `user_identities` (migration 0027). The only place the provider name is
 * spelled: switching IdP is an adapter change plus a new key here. Kept out of
 * the adapter factory so stores can import it without the Keycloak client.
 */
export const IDP_PROVIDER = 'keycloak';
