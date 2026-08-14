# Third-party notices

## Infinite Canvas upstream

This module is a platform-adapted distribution of [tigerowo/infinite-canvas](https://github.com/tigerowo/infinite-canvas), pinned at revision `6d0bed4eb1ad9f1ec4fe0ec635b267bcb3bc901b` from 2026-08-11. The upstream project is licensed under AGPL-3.0; the original license text is included in `LICENSE` and provenance details are recorded in `UPSTREAM.md`.

The platform port keeps the upstream canvas interaction concepts and the bundled 3D Director web asset, while replacing account, provider configuration, and backend calls with OpenOPC sandbox services. No upstream server, credential, or provider endpoint is shipped in this module.

The Director asset includes the following upstream notice and model attribution:

- `director/models/ue-mannequin-retopology.license.txt`
- William Luque, UE Mannequin (Retopology), Sketchfab Standard license

The module does not bundle any provider credentials. Platform-managed credentials remain outside the module boundary.
