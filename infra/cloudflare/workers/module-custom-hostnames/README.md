# OpenOPC module hostname worker

This Worker has two fixed-origin routing modes:

- A platform hostname shaped as
  `r-<canonical-release-uuid>.<OPENOPC_MODULE_APP_BASE_DOMAIN>` routes directly
  to
  `<OPENOPC_MODULE_HOST_ORIGIN>/v1/module-host/platform/releases/<release-id><asset-path>`.
  It does not call the custom-domain resolver or require a Cloudflare Custom
  Hostnames account, suffix, binding, or API token.
- Any other hostname uses the existing custom-hostname resolver. It accepts only
  an active binding and immutable release route, then forwards to the fixed
  `OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN`.

Both modes require `INTERNAL_SERVICE_KEY`. The platform mode also requires the
non-secret, environment-owned `OPENOPC_MODULE_APP_BASE_DOMAIN` and
`OPENOPC_MODULE_HOST_ORIGIN` variables. Module manifests and incoming requests
cannot select an origin or release identity.

## Staging setup

The required Worker route pattern for platform releases is
`*.<OPENOPC_MODULE_APP_BASE_DOMAIN>/*`. The Worker itself accepts only an exact
`r-<canonical-release-uuid>` label for direct platform routing. Provision the
matching wildcard DNS record and certificate separately in staging. Do not use
an apex route or an attacker-controlled suffix.

After this commit is approved for staging:

1. Configure `OPENOPC_MODULE_APP_BASE_DOMAIN` and
   `OPENOPC_MODULE_HOST_ORIGIN` as Worker variables. Bind the internal key
   without committing its value:

   ```powershell
   wrangler secret put INTERNAL_SERVICE_KEY
   ```

2. Provision the staging wildcard DNS record, certificate, and Worker route for
   `*.<OPENOPC_MODULE_APP_BASE_DOMAIN>/*`, then deploy the Worker through the
   approved operations workflow.
3. Verify a canonical release hostname reaches exactly one fixed-origin request,
   carries the matching `X-OpenOPC-Module-Release`, strips caller credentials and
   forged module identity headers, preserves request bodies and query strings,
   redirects HTTP to HTTPS, and returns a generic 502 when the origin is down.
4. Verify uppercase or noncanonical UUIDs, extra labels, the base-domain apex,
   sibling or attacker suffixes, and invalid scheme/port/wildcard configuration
   fail closed without contacting an upstream.
5. If custom hostnames are enabled, retain the existing API and Worker settings,
   bind `OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN`, configure
   `OPENOPC_MODULE_CUSTOM_HOSTNAME_SUFFIX`, and verify create, DNS validation,
   certificate activation, active routing, release update fencing, and disable
   before any production change.

The Worker sends `INTERNAL_SERVICE_KEY` to both the resolver and the fixed
module-host upstream. It strips caller credentials and both spoofable module
identity headers before setting only the identity appropriate to the selected
route, and never returns tenant or provider details for a miss.

This commit creates no DNS records, certificates, Worker secrets, routes, or
deployments. Those remain explicit, later staging operations.
