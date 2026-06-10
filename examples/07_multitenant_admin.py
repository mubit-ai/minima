"""Example 7 — Provision a tenant, then call as that tenant.

Multi-tenant mode lets one Costit deployment serve many orgs, each on its OWN Mubit
instance, with per-org keys. The provisioning key (admin credential) mints those keys; the
org's Mubit key is never sent per call.

Start the service in multi-tenant mode first:

    COSTIT_MULTITENANT=true \
    COSTIT_PROVISIONING_KEY=dev-provisioning-secret \
    COSTIT_TENANT_STORE=memory \
        uv run uvicorn costit.main:app --port 8080

Then:

    COSTIT_PROVISIONING_KEY=dev-provisioning-secret \
    ACME_MUBIT_KEY=<acme-mubit-data-plane-key> \
        uv run python examples/07_multitenant_admin.py

This script talks to the admin API with raw httpx (the typed client SDK doesn't wrap admin),
then uses the minted cstk_ key with the normal CostitClient.
"""

from __future__ import annotations

import os
import sys

import httpx
from costit_client import CostitClient, CostitError

URL = os.environ.get("COSTIT_URL", "http://localhost:8080")
PROV_KEY = os.environ.get("COSTIT_PROVISIONING_KEY")
ORG = "acme"


def main() -> None:
    if not PROV_KEY:
        sys.exit("set COSTIT_PROVISIONING_KEY (must match the running service)")

    admin_headers = {"x-costit-provisioning-key": PROV_KEY}

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
            sys.exit("service is not in multi-tenant mode (set COSTIT_MULTITENANT=true)")
        resp.raise_for_status()
        created = resp.json()
        # The full cstk_ key is shown exactly once; only a hash is persisted.
        cstk_key = created["costit_api_key"]
        print(f"provisioned org '{created['org_id']}' key_id={created['key_id']}")
        print(f"  (cstk key returned once; len={len(cstk_key)} — store it securely)")

        # 2. List tenants (summaries only — never secrets).
        listed = http.get("/v1/admin/tenants", headers=admin_headers).json()
        print(f"  tenants now: {[t['org_id'] for t in listed['tenants']]}")

    # 3. Call the normal API as that tenant, using the minted key.
    with CostitClient(URL, api_key=cstk_key) as costit:
        try:
            rec = costit.recommend(
                {"task": "Classify this email as spam or not.", "task_type": "classification"},
                cost_quality_tradeoff=2,
                namespace="prod",
            )
            print(f"\nas tenant '{ORG}': recommended {rec.recommended_model.model_id} "
                  f"(basis={rec.decision_basis})")
        except CostitError as exc:
            print(f"\ntenant call failed: {exc}")

        # A wrong/blank key would 401 here — the tenant boundary is the cstk_ key.

    print("\n(to revoke: DELETE /v1/admin/tenants/acme with the provisioning key)")


if __name__ == "__main__":
    main()
