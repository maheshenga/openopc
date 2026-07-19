# Multimedia Product Scope Cancellation

**Status:** Accepted

**Date:** 2026-07-20

## Decision

Kortix will not build or ship first-party finished-product pages for video generation, voice production, professional 3D modeling, digital-human production, or batch remix.

The cancellation includes:

- first-party Studio routes and navigation;
- built-in capability IDs and discovery descriptors;
- dedicated provider adapters, callbacks, seed data, and worker ownership;
- first-party database models or timelines created solely for those products;
- roadmap items and follow-on implementation plans for those pages.

Image Studio remains the only first-party Studio product. Existing jobs, assets, IAM, billing, workflow, SDK, desktop, mobile, and team foundations remain in scope.

## Extension boundary

Generic capability descriptors, asset contracts, sandbox execution, and Developer Center module interfaces remain extensible. A reviewed developer module may declare a module-owned workload, but it does not become a first-party Kortix multimedia page and must not claim the first-party Studio route family, built-in provider ownership, or privileged execution.

## Compatibility

No runtime multimedia implementation is being removed because these first-party products were not enabled. Existing absence tests and capability allowlists remain required. Reintroducing any cancelled first-party multimedia product requires a new explicit product decision, design review, security review, implementation plan, and production acceptance gate.
