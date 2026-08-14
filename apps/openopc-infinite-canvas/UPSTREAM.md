# Upstream provenance

This OpenOPC module is adapted from the public Infinite Canvas project:

- Repository: https://github.com/tigerowo/infinite-canvas
- Pinned revision: `6d0bed4eb1ad9f1ec4fe0ec635b267bcb3bc901b`
- Upstream version line: `v0.5.2` plus the pinned unreleased commit
- Source snapshot date: 2026-08-11
- License: GNU Affero General Public License v3.0 (`AGPL-3.0`)

The complete upstream license text is distributed in `LICENSE`. Additional
attribution for the bundled Director model is distributed in
`THIRD_PARTY_NOTICES.md` and next to the model asset.

## OpenOPC adaptation boundary

The module keeps the upstream canvas concepts, project interchange shape,
media workflows, and the bundled same-origin Director application. The user
interface and runtime were adapted to a static React sandbox that can be hosted
by OpenOPC.

The upstream Go/Next.js backend, account system, provider configuration, direct
provider endpoints, and credential handling are not included. Privileged text
and image operations use the public OpenOPC Developer SDK and operation-scoped
capability tokens. Project JSON synchronization uses the OpenOPC data document
service. Browser media recovery remains installation-namespaced in IndexedDB
until OpenOPC exposes a generic installation-scoped binary asset service.

No provider credential, provider base URL, or authorization header is bundled
or accepted by the module.
