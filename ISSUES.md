# Candidate backlog

These are draft engineering tasks, not active Drips Wave issues. Confirm the
repository's Wave status and add issues through the Drips maintainer dashboard
only after approval. Assign complexity there; do not treat labels or point
estimates in this file as Wave configuration.

## Standardize Horizon upstream errors

The search flow classifies Horizon failures, `getNetworkStats` wraps failures
in a generic error, and most other service methods expose the SDK's raw errors.
Define a consistent typed error contract for the public Horizon service methods.

Acceptance criteria:

- Preserve the upstream status, cause, and operation where available.
- Distinguish rate limits, timeouts, not-found responses, and other upstream
  failures without turning failures into empty success results.
- Keep expected not-found behavior explicit for lookup methods.
- Add mocked tests for each error category and affected service method.
- Document the error contract.

## Add focused tests for remaining Horizon queries

Extend service-level coverage for the existing asset, order-book, trade, and
account-transaction query methods.

Acceptance criteria:

- Verify each query forwards its inputs and pagination settings to Horizon.
- Cover successful empty responses and rejected upstream requests.
- Use mocked SDK responses; tests must not require live network access.
- Keep the public API documentation aligned with the tested behavior.

