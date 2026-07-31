#!/usr/bin/env python3
"""Apply the aggregator-portal entitlement gate to a LIVE Keycloak realm.

Mirrors infra/keycloak/realms/realm.json for stacks whose realm was already
imported (--import-realm only runs on an empty realm). Idempotent: drops and
recreates the aggregator-portal-browser flow tree each run.
"""
import json, os, sys, urllib.request, urllib.parse, urllib.error

KC = os.environ.get("KC_URL", "http://localhost:8080")
REALM = os.environ.get("KC_REALM", "bluedots")
USER = os.environ.get("KC_ADMIN_USERNAME", "admin")
PASS = os.environ["KC_ADMIN_PASSWORD"]

PORTAL_FLOW = "aggregator-portal-browser"
FLOW_ID = "9f3b1c52-7a41-4c8e-9d16-3b0f5a2e7c84"


def req(method, path, body=None, tok=None, raw=False):
    url = path if path.startswith("http") else f"{KC}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    if tok:
        r.add_header("Authorization", f"Bearer {tok}")
    if data:
        r.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(r) as resp:
            txt = resp.read().decode()
            return resp.status, (txt if raw else (json.loads(txt) if txt else None))
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def token():
    body = urllib.parse.urlencode(
        {"client_id": "admin-cli", "username": USER, "password": PASS, "grant_type": "password"}
    ).encode()
    r = urllib.request.Request(f"{KC}/realms/master/protocol/openid-connect/token", data=body)
    with urllib.request.urlopen(r) as resp:
        return json.load(resp)["access_token"]


TOK = token()
A = f"/admin/realms/{REALM}/authentication"


def executions(flow):
    return req("GET", f"{A}/flows/{urllib.parse.quote(flow)}/executions", tok=TOK)[1]


def find_exec(flow, display=None, provider=None):
    for e in executions(flow):
        if provider and e.get("providerId") == provider:
            return e
        if display and e.get("displayName") == display:
            return e
    return None


def set_req(flow, ex, requirement):
    ex = dict(ex)
    ex["requirement"] = requirement
    st, b = req("PUT", f"{A}/flows/{urllib.parse.quote(flow)}/executions", ex, tok=TOK)
    assert st in (202, 204), (st, b)


def add_exec(flow, provider, requirement, config=None, config_alias=None):
    st, b = req("POST", f"{A}/flows/{urllib.parse.quote(flow)}/executions/execution",
                {"provider": provider}, tok=TOK)
    assert st in (200, 201), (provider, st, b)
    ex = find_exec(flow, provider=provider)
    assert ex, f"execution {provider} not found in {flow}"
    set_req(flow, ex, requirement)
    if config:
        st, b = req("POST", f"{A}/executions/{ex['id']}/config",
                    {"alias": config_alias, "config": config}, tok=TOK)
        assert st in (200, 201), (config_alias, st, b)
    return ex


def add_subflow(parent, alias, description, requirement):
    st, b = req("POST", f"{A}/flows/{urllib.parse.quote(parent)}/executions/flow",
                {"alias": alias, "type": "basic-flow", "description": description}, tok=TOK)
    assert st in (200, 201), (alias, st, b)
    ex = find_exec(parent, display=alias)
    assert ex, f"subflow {alias} not found in {parent}"
    set_req(parent, ex, requirement)
    return ex


def gate(parent, alias, description, cond_config, cond_alias, deny_msg, deny_alias):
    """A CONDITIONAL sub-flow: one user-attribute condition + Deny access."""
    add_subflow(parent, alias, description, "CONDITIONAL")
    add_exec(alias, "conditional-user-attribute", "REQUIRED", cond_config, cond_alias)
    add_exec(alias, "deny-access-authenticator", "REQUIRED",
             {"denyErrorMessage": deny_msg}, deny_alias)


NO_AGG_ID = {"attribute_name": "aggregator_id", "attribute_expected_value": ".+",
             "regex": "true", "include_group_attributes": "false", "not": "true"}
NOT_APPROVED = {"attribute_name": "decision_made", "attribute_expected_value": "approved",
                "regex": "false", "include_group_attributes": "false", "not": "true"}
DENY_COORD = "This account does not have access to the Aggregator portal."
DENY_APPROVED = "Your Aggregator registration has not been approved yet."
OTP_CHOICE = {"otpChoice.codeLength": "6", "otpChoice.ttl": "300",
              "otpChoice.maxRetries": "3", "otpChoice.phoneAttribute": "phoneNumber"}

# --- tear down any previous attempt -----------------------------------------
# Unbind first: Keycloak refuses to delete a flow a client still points at.
_clients = req("GET", f"/admin/realms/{REALM}/clients?clientId=aggregator-portal", tok=TOK)[1]
_cid = _clients[0]["id"]
_rep = req("GET", f"/admin/realms/{REALM}/clients/{_cid}", tok=TOK)[1]
if _rep.get("authenticationFlowBindingOverrides"):
    # An empty map is silently ignored on update; an empty string clears it.
    _rep["authenticationFlowBindingOverrides"] = {"browser": ""}
    req("PUT", f"/admin/realms/{REALM}/clients/{_cid}", _rep, tok=TOK)
    _now = req("GET", f"/admin/realms/{REALM}/clients/{_cid}", tok=TOK)[1]
    print(f"  unbound aggregator-portal override -> {_now.get('authenticationFlowBindingOverrides')}")

# Children are not cascade-deleted, and a stale alias blocks recreation.
for f in req("GET", f"{A}/flows", tok=TOK)[1]:
    if f["alias"].startswith("aggregator-portal-"):
        st, _ = req("DELETE", f"{A}/flows/{f['id']}", tok=TOK)
        print(f"  removed flow {f['alias']} -> HTTP {st}")

# --- build the flow tree, in execution order --------------------------------
st, b = req("POST", f"{A}/flows", {
    "id": FLOW_ID, "alias": PORTAL_FLOW, "providerId": "basic-flow",
    "topLevel": True, "builtIn": False,
    "description": "aggregator-portal only; bound by flow ID. Adds a portal-entitlement gate to aggregator-otp-browser.",
}, tok=TOK)
assert st in (200, 201), (st, b)
print(f"  created flow {PORTAL_FLOW}")

# The ALTERNATIVE pair must live one level down: Keycloak ignores every
# ALTERNATIVE at a level that also holds REQUIRED/CONDITIONAL executions.
AUTH = "aggregator-portal-auth"
add_subflow(PORTAL_FLOW, AUTH, "Cookie or OTP forms (ALTERNATIVE pair).", "REQUIRED")
add_exec(AUTH, "auth-cookie", "ALTERNATIVE")

FORMS = "aggregator-portal-otp-forms"
add_subflow(AUTH, FORMS,
            "Identifier resolution, entitlement gate, then OTP channel choice.", "ALTERNATIVE")
add_exec(FORMS, "otp-identifier-form", "REQUIRED")
gate(FORMS, "aggregator-portal-gate-otp-coordinator",
     "Deny before OTP dispatch: no aggregator_id, so not a coordinator.",
     NO_AGG_ID, "aggregator-portal-cond-no-aggregator-id", DENY_COORD,
     "aggregator-portal-deny-not-coordinator")
gate(FORMS, "aggregator-portal-gate-otp-approved",
     "Deny before OTP dispatch: decision_made is absent, pending or rejected.",
     NOT_APPROVED, "aggregator-portal-cond-not-approved", DENY_APPROVED,
     "aggregator-portal-deny-not-approved")
add_exec(FORMS, "otp-channel-choice-form", "REQUIRED", OTP_CHOICE,
         "aggregator-portal-otp-choice-config")

gate(PORTAL_FLOW, "aggregator-portal-gate-sso-coordinator",
     "Coordinator gate on the auth-cookie path (shared-realm SSO bypass).",
     NO_AGG_ID, "aggregator-portal-cond-no-aggregator-id-sso", DENY_COORD,
     "aggregator-portal-deny-not-coordinator-sso")
gate(PORTAL_FLOW, "aggregator-portal-gate-sso-approved",
     "Approval gate on the auth-cookie path.",
     NOT_APPROVED, "aggregator-portal-cond-not-approved-sso", DENY_APPROVED,
     "aggregator-portal-deny-not-approved-sso")

# --- bind to the aggregator-portal client only ------------------------------
clients = req("GET", f"/admin/realms/{REALM}/clients?clientId=aggregator-portal", tok=TOK)[1]
cid = clients[0]["id"]
actual_id = [f for f in req("GET", f"{A}/flows", tok=TOK)[1] if f["alias"] == PORTAL_FLOW][0]["id"]
rep = req("GET", f"/admin/realms/{REALM}/clients/{cid}", tok=TOK)[1]
rep["authenticationFlowBindingOverrides"] = {"browser": actual_id}
st, b = req("PUT", f"/admin/realms/{REALM}/clients/{cid}", rep, tok=TOK)
assert st in (200, 204), (st, b)
print(f"  bound aggregator-portal browser flow -> {actual_id} (pinned id honoured: {actual_id == FLOW_ID})")

print("\nFinal structure:")
for e in executions(PORTAL_FLOW):
    print(f"  lvl{e['level']} idx{e['index']} | {e.get('displayName')} | {e['requirement']} | {e.get('providerId') or 'SUBFLOW'}")
