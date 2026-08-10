# OpenOPC Module Local QA Host

The Developer SDK intentionally accepts only a canonical HTTPS module origin with no port. The first-party QA host keeps that boundary intact while forwarding an iframe module to a loopback development server.

1. Install `mkcert` and run `powershell -ExecutionPolicy Bypass -File scripts/module-qa-cert.ps1 -Hostname image.openopc.test`. Add `-UpdateHosts` only from an elevated PowerShell when the hosts entry is required.
2. Start the module dev server on a loopback HTTP port, for example `http://127.0.0.1:4173`.
3. Start the host with `bun scripts/module-qa-host.ts --hostname image.openopc.test --upstream http://127.0.0.1:4173 --cert .local/module-qa-certs/image.openopc.test.pem --key .local/module-qa-certs/image.openopc.test-key.pem`.
4. Use `https://image.openopc.test` as the iframe and SDK bootstrap origin. The readiness endpoint is `https://image.openopc.test/.well-known/openopc-module-qa`.

The host rejects non-loopback upstreams, non-HTTPS public origins, ports in the module origin, localhost/IP public names, and missing certificate files. It does not install certificates or edit the hosts file automatically; those actions are explicit in the PowerShell helper. This is local QA tooling only and is not a production ingress or deployment mechanism.

For the first-party embedded-browser smoke, run `pnpm.cmd exec bun apps/web/scripts/e2e/module-bootstrap-browser-smoke.ts`. The smoke builds a minimal sandboxed iframe fixture and verifies the canonical bootstrap/token bridge, the scoped model request, a streaming chat abort, an explicit CORS/preflight boundary probe, cookie omission, attacker-origin rejection, and cleanup. Its ephemeral certificate is pinned to the test browser process; it does not disable the SDK HTTPS or canonical-origin checks. Use the `mkcert` host above for manual module development and real iframe work.
