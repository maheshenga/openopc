# Third-party notices

This module directly adapts the upstream image-studio GIF prompt contract and
4x3 sprite-grid encoding workflow at commit
`7768f3f8d7f47e04c6d18572837a086c7a533161`. The adapted source is retained in
this module under the GNU Affero General Public License, version 3 (AGPL-3.0).

The upstream project is the public repository owned by `tianjiangqiji`, at
commit `7768f3f8d7f47e04c6d18572837a086c7a533161`. The source and license were
reviewed from that exact commit before adaptation.

The complete upstream license text is included in
[`UPSTREAM-LICENSE-AGPL-3.0.txt`](./UPSTREAM-LICENSE-AGPL-3.0.txt). The
OpenOPC-specific host bridge, service contract, and UI integration are newly
added platform code; they do not accept provider URLs, provider credentials, or
module-supplied network destinations.

The module UI and manifest intentionally use the neutral product name
"Image Studio". No upstream product branding is used as the module name.
