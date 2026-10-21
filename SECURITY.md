# Security policy

DVAP (Damn Vulnerable Agentic Payments) is **intentionally vulnerable**. It is a teaching lab: every bug listed in
[`docs/BUG_CATALOG.md`](docs/BUG_CATALOG.md) is there on purpose, switchable with `DVAP_HARDEN`, and covered by a test.

## Please do not
- deploy it, expose it to a network, or point it at real systems, accounts or credentials;
- report the catalogued bugs as vulnerabilities. They are the exercise.

Everything runs on localhost with fictional money. The services bind to `127.0.0.1` by default (`HOST=0.0.0.0` is set only inside the Docker containers, whose ports are published on `127.0.0.1`).

## What is worth reporting
Anything that is **not** one of the intended bugs, for example:
- a way out of the lab (a service listening beyond localhost by default, a path that touches your host files or network);
- a bug in a fix (`DVAP_HARDEN=...` on, and the attack still works), or a fix that breaks the happy path;
- a dependency with a known vulnerability that affects people running the lab.

Please [open a GitHub issue](https://github.com/dr20240304/dvap/issues). This is an educational project, not a production system: reports are welcome, but fixes are best effort and may be slow or declined, especially when the "bug" is part of the exercise.

## Using the lab and its exploit scripts
Use them against your own instance only. The scripts in `tooling/exploits/` and `scripts/` exist to teach; they hold no real targets.
