package rbac_test

import data.rbac
import rego.v1

# Every shared vector gives the expected decision. The same file runs in
# packages/rbac/src/__tests__/vectors.test.ts against the TypeScript mirror.
test_shared_vectors if {
	every v in data.rbac_vectors {
		got := rbac.decision with input as v.input
		got == v.expected
	}
}

test_vectors_present if count(data.rbac_vectors) > 0

test_empty_input_denies if {
	got := rbac.decision with input as {}
	got.allow == false
}
