# Security

Themis is a policy kernel: a defect here is a security defect by definition.

**Report privately.** Use GitHub's private vulnerability reporting on this
repository ("Security" → "Report a vulnerability"), or email the maintainer
listed on the npm package `themis-policy`. Do not open a public issue for a
vulnerability.

**What to expect.** Acknowledgement within 3 business days; a fix and a
release for confirmed issues in the kernel, the policies, the preview-token
scheme, or an adapter, with credit if you want it.

**Supported versions.** The latest 0.x release of each package, in both
languages. Both implementations are released together and must pass the same
conformance vectors, so a fix lands in both.

**Scope notes.** Themis decides; it does not authenticate. A deployment is
responsible for establishing the requestor's identity, scopes and tenant
before evaluation, and for storing preview-token secrets safely.
