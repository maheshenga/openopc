# OpenOPC module custom-hostname worker

This Worker is the fixed-origin edge for verified developer-module hostnames.
It resolves the request hostname through the OpenOPC internal resolver, accepts
only an active binding and an immutable release route, then forwards to the
single configured `OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN`.

## Staging setup

1. Apply the API migration and configure the API with the Cloudflare account,
   zone, custom-hostname API token, CNAME target, HTTPS origin, and explicit
   OpenOPC-controlled hostname suffix settings. The suffix must be the same
   environment-specific value used by this Worker.
2. Deploy the API and verify that a test binding reaches `active` only after
   authoritative TXT and CNAME checks plus Cloudflare certificate activation.
3. Deploy this Worker and bind secrets without committing their values:

   ```powershell
   wrangler secret put OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN
   wrangler secret put INTERNAL_SERVICE_KEY
   # Set OPENOPC_MODULE_CUSTOM_HOSTNAME_SUFFIX as an environment variable in
   # wrangler.toml or the deployment command; it is not a secret.
   wrangler deploy
   ```

4. Configure the Cloudflare Custom Hostnames route for the Worker in staging.
   Use the CNAME target returned by the API. Do not add a module-supplied
   origin, query-selected upstream, provider token, DNS credential, or Worker
   secret to a module manifest.
5. Exercise create, DNS verification, active routing, release update fencing,
   and disable from the authenticated OpenOPC API before any production route
   is changed. Cloudflare/Terraform/Worker changes are operational actions and
   are intentionally outside repository tests.

The Worker sends `INTERNAL_SERVICE_KEY` to both the resolver and the fixed
module-host upstream. It strips caller credentials and spoofable binding/host
forwarding headers before setting its own binding identity, and never returns
tenant or provider details for a miss.
