"""Example 7 — Provision a tenant, then call as that tenant.

Multi-tenant mode lets one Minima deployment serve many orgs, each on its OWN Mubit
instance, with per-org keys. The provisioning key (admin credential) mints those keys; the
org's Mubit key is never sent per call.

Start the service in multi-tenant mode first:

    MINIMA_MULTITENANT=true \
    MINIMA_PROVISIONING_KEY=dev-provisioning-secret \
    MINIMA_TENANT_STORE=memory \
        uv run uvicorn minima.main:app --port 8080

Then:

    MINIMA_PROVISIONING_KEY=dev-provisioning-secret \
    ACME_MUBIT_KEY=<acme-mubit-data-plane-key> \
        uv run python examples/07_multitenant_admin.py

This script talks to the admin API with raw httpx (the typed client SDK doesn't wrap admin),
then uses the minted mnim_ key with the normal MinimaClient.
"""

from __future__ import annotations

import os
import sys

import httpx
from minima_client import MinimaClient, MinimaError

URL = os.environ.get("MINIMA_URL", "http://localhost:8080")
PROV_KEY = os.environ.get("MINIMA_PROVISIONING_KEY")
ORG = "acme"


def main() -> None:
    if not PROV_KEY:
        sys.exit("set MINIMA_PROVISIONING_KEY (must match the running service)")

    admin_headers = {"x-minima-provisioning-key": PROV_KEY}

    with httpx.Client(base_url=URL, timeout=10.0) as http:
        # Clean slate: a duplicate org_id returns 409, so delete any prior one.
        http.delete(f"/v1/admin/tenants/{ORG}", headers=admin_headers)

        # 1. Provision the org. The org's Mubit key is passed BY REFERENCE (env:NAME) so the
        #    raw secret never lands in the registry.
        resp = http.post(
            "/v1/admin/tenants",
            headers=admin_headers,
            json={
                "org_id": ORG,
                "mubit_endpoint": os.environ.get("ACME_MUBIT_ENDPOINT", "http://127.0.0.1:3000"),
                "mubit_api_key_ref": "env:ACME_MUBIT_KEY",
                "mubit_transport": "http",
            },
        )
        if resp.status_code == 404:
            sys.exit("service is not in multi-tenant mode (set MINIMA_MULTITENANT=true)")
        resp.raise_for_status()
        created = resp.json()
        # The full mnim_ key is shown exactly once; only a hash is persisted.
        mnim_key = created["minima_api_key"]
        print(f"provisioned org '{created['org_id']}' key_id={created['key_id']}")
        print(f"  (mnim_ key returned once; len={len(mnim_key)} — store it securely)")

        # 2. List tenants (summaries only — never secrets).
        listed = http.get("/v1/admin/tenants", headers=admin_headers).json()
        print(f"  tenants now: {[t['org_id'] for t in listed['tenants']]}")

    # 3. Call the normal API as that tenant, using the minted key.
    with MinimaClient(URL, api_key=mnim_key) as minima:
        try:
            rec = minima.recommend(
                {"task": "Classify this email as spam or not.", "task_type": "classification"},
                cost_quality_tradeoff=2,
                namespace="prod",
            )
            print(f"\nas tenant '{ORG}': recommended {rec.recommended_model.model_id} "
                  f"(basis={rec.decision_basis})")
        except MinimaError as exc:
            print(f"\ntenant call failed: {exc}")

        # A wrong/blank key would 401 here — the tenant boundary is the mnim_ key.

    print("\n(to revoke: DELETE /v1/admin/tenants/acme with the provisioning key)")


if __name__ == "__main__":
    main()
