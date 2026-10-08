# Access decisions for aggregator-dpg.
#
# Query: POST /v1/data/rbac/decision with {"input": DecisionInput}
# (DecisionInput is defined in packages/rbac/src/interface.ts).
#
# Answers "does the actor hold this capability". Allowed when the actor is
# active, the capability is grantable, the role holds it or an unexpired grant
# adds it, and at least one of the actor's organisations holds it in its
# PermissionSet — never personal data through the Network Facilitator root.
#
# Reach (which targets) is not decided here: the API's scope checks answer it
# after this decision, with 404 (design decision D3).
#
# packages/rbac/src/evaluate.ts mirrors these rules; vectors.json runs
# against both.
package rbac

import rego.v1

not_grantable := {"orgs.block"}

cap := input.capability

holding contains o if {
	some o in input.actor.orgs
	cap in o.capabilities
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

default allow := false

allow if {
	input.actor.active
	not cap in not_grantable
	role_or_grant
	some o in holding
	not pii_blocked(o)
}

reasons contains "inactive" if not input.actor.active

reasons contains "not_grantable" if cap in not_grantable

reasons contains "no_organisation" if count(input.actor.orgs) == 0

reasons contains "not_in_role" if not role_or_grant

reasons contains "grant_expired" if {
	not role_or_grant
	some g in input.actor.grants
	g.capability == cap
	g.expiresAt <= input.now
}

reasons contains "not_in_org_set" if {
	count(input.actor.orgs) > 0
	count(holding) == 0
}

reasons contains "pii_blocked_at_root" if {
	count(holding) > 0
	every o in holding {
		pii_blocked(o)
	}
}

decision := {"allow": true, "reasons": []} if allow

decision := {"allow": false, "reasons": sort(reasons)} if not allow
