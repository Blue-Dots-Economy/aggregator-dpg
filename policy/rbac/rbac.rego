# Access decisions for aggregator-dpg.
#
# Query: POST /v1/data/rbac/decision with {"input": DecisionInput}
# (DecisionInput is defined in packages/rbac/src/interface.ts).
#
# Allowed when the actor is active, the capability is grantable, and through
# at least one organisation the actor can reach the target:
#   - the organisation's PermissionSet holds the capability,
#   - the actor's role holds it, or an unexpired grant adds it,
#   - personal data is never served through the Network Facilitator root.
#
# packages/rbac/src/evaluate.ts mirrors these rules; vectors.json runs
# against both.
package rbac

import rego.v1

not_grantable := {"orgs.block"}

cap := input.capability

# Owners reach their organisation and its subtree.
reaches(o) if {
	o.relation == "owner"
	not input.target
}

reaches(o) if {
	o.relation == "owner"
	o.id in input.target.orgChain
}

# Members (coordinators) reach only their own tenant in their own organisation.
reaches(o) if {
	o.relation == "member"
	member_tenant_ok
	member_org_ok(o)
}

member_tenant_ok if not input.target.tenantUserId

member_tenant_ok if input.target.tenantUserId == input.actor.userId

member_org_ok(_) if not input.target.orgChain

member_org_ok(o) if input.target.orgChain[0] == o.id

reachable contains o if {
	some o in input.actor.orgs
	reaches(o)
}

role_or_grant if cap in input.actor.roleCapabilities

role_or_grant if {
	some g in input.actor.grants
	g.capability == cap
	g.expiresAt > input.now
}

pii_blocked(o) if {
	cap == "profiles.view_pii"
	o.orgType == "network_facilitator"
}

allow if {
	input.actor.active
	not cap in not_grantable
	role_or_grant
	some o in reachable
	cap in o.capabilities
	not pii_blocked(o)
}

reasons contains "inactive" if not input.actor.active

reasons contains "not_grantable" if cap in not_grantable

reasons contains "no_reach" if count(reachable) == 0

reasons contains "not_in_role" if {
	count(reachable) > 0
	not role_or_grant
}

reasons contains "grant_expired" if {
	count(reachable) > 0
	not role_or_grant
	some g in input.actor.grants
	g.capability == cap
	g.expiresAt <= input.now
}

reasons contains "not_in_org_set" if {
	some o in reachable
	not cap in o.capabilities
}

reasons contains "pii_blocked_at_root" if {
	some o in reachable
	pii_blocked(o)
}

default allow := false

decision := {"allow": true, "reasons": []} if allow

decision := {"allow": false, "reasons": sort(reasons)} if not allow
