#!/usr/bin/env python3
"""
Kaizen — Lightning AI setup + smoke check.

Verifies auth, resolves the teamspace, lists existing studios, and prints
a start-studio hint. Run this after copying .env.example → .env and
filling in credentials.

Usage:
  set -a; source .env; set +a
  python training/scripts/lightning_setup.py

Optional flags:
  --start-gpu L4      Start (or resume) the training studio on the given GPU.
  --stop              Stop the training studio to avoid ongoing charges.
  --studio NAME       Studio name to operate on (default: kaizen-training).
"""

from __future__ import annotations

import argparse
import os
import sys


TRAINING_STUDIO_DEFAULT = "kaizen-training"


def resolve_teamspace():
    from lightning_sdk.organization import Organization
    from lightning_sdk.teamspace import Teamspace

    org_name = os.environ.get("LIGHTNING_ORG")
    ts_name = os.environ.get("LIGHTNING_TEAMSPACE")
    if not org_name or not ts_name:
        print("✗ LIGHTNING_ORG / LIGHTNING_TEAMSPACE not set; check .env")
        sys.exit(2)
    org = Organization(name=org_name)
    ts = Teamspace(name=ts_name, org=org.name)
    return org, ts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start-gpu", type=str, default=None,
                    help="Machine type: L4, L4_X_2, A100, H100, etc. See `lightning machine list`.")
    ap.add_argument("--stop", action="store_true")
    ap.add_argument("--studio", type=str, default=TRAINING_STUDIO_DEFAULT)
    args = ap.parse_args()

    if not os.environ.get("LIGHTNING_API_KEY"):
        print("✗ LIGHTNING_API_KEY missing. Run: set -a; source .env; set +a")
        return 2

    from lightning_sdk import Studio, Machine

    org, ts = resolve_teamspace()
    print(f"org: {org.name}")
    print(f"teamspace: {ts.name}")

    studios = ts.studios
    print(f"studios ({len(studios)}):")
    for s in studios:
        print(f"  - {s.name}  status={s.status}")

    target = next((s for s in studios if s.name == args.studio), None)

    if args.stop:
        if not target:
            print(f"studio '{args.studio}' not found — nothing to stop")
            return 0
        print(f"→ stopping {args.studio}…")
        target.stop()
        print("✅ stopped")
        return 0

    if args.start_gpu:
        machine = getattr(Machine, args.start_gpu, None)
        if machine is None:
            print(f"✗ Unknown machine type '{args.start_gpu}'. Run: lightning machine list")
            return 2
        if target is None:
            print(f"→ creating studio '{args.studio}' on {args.start_gpu}…")
            studio = Studio(name=args.studio, teamspace=ts.name, org=org.name, create_ok=True)
            studio.start(machine=machine)
        else:
            print(f"→ switching '{args.studio}' to {args.start_gpu}…")
            target.switch_machine(machine=machine)
        print(f"✅ '{args.studio}' running on {args.start_gpu}")
        print(f"   ssh:  lightning studio ssh --name {args.studio} --teamspace {org.name}/{ts.name}")
        return 0

    print("\nno action requested. common next steps:")
    print(f"  # start training studio on an L4:")
    print(f"  python training/scripts/lightning_setup.py --start-gpu L4 --studio {args.studio}")
    print(f"  # then upload this repo (via studio ssh + git clone, or `lightning studio cp -r .`)")
    print(f"  # remember to stop when idle:")
    print(f"  python training/scripts/lightning_setup.py --stop --studio {args.studio}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
