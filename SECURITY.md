# Security policy

These apps are reference code for security boundaries, so a flaw in them can
be copied into many real services. We take reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately, either way:

- [Report a vulnerability](https://github.com/XRAY-INC/xray-workspace-app-template/security/advisories/new)
  through GitHub's private reporting, or
- email **security@xray.tech**.

Tell us what you found, how to reproduce it, and what an attacker could do with
it. We aim to acknowledge reports within three business days and to keep you
informed until a fix ships.

## In scope

- A way past any rule the apps claim to enforce: token verification, the embed
  handshake, tenant isolation, scope or role checks, the authorization
  callback's fail-closed handling, CSP.
- A place where the code or docs teach a pattern that is unsafe to copy.

A vulnerability in XRAY Workspace itself is in scope for the same addresses;
please say which one you mean.

## Out of scope

- The apps' in-memory storage, which is a teaching device and documented as
  such.
- Findings that need a stolen service key or embed key, unless the apps make
  the theft easier.
