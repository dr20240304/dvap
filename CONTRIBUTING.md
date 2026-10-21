# Contributing

Thanks for helping. DVAP is a teaching lab, so the bar is: **each bug is realistic, switchable, tested, and fixable with one flag.**

## Setup
```bash
git clone https://github.com/dr20240304/dvap.git && cd dvap
npm install
npm test            # vitest, in-process stack on random ports
npm run typecheck
make tooling-test   # Python black-box tests (starts its own stack)
```
Docker alternative: `make d-up-attack`, then `make d-test`. `make rehearse` runs every demo beat, vulnerable and hardened.

## Adding or changing a bug
1. Gate the fix behind `hardened('Vn')` (`src/common/harden.ts`); the default stays vulnerable.
2. Add a vitest test that shows the attack working by default and blocked with `DVAP_HARDEN=Vn`. Python tooling tests are welcome for black-box checks.
3. Add a row to `docs/BUG_CATALOG.md` (flow step, bug, code location, tests). Say honestly where a mapping to OWASP or a public issue is your own judgement.
4. If it changes a demo beat, update the page in `docs/demos/` and `scripts/rehearse.sh`.

## Ground rules
- Learning only: no real credentials, no real endpoints, no zero-days. Public incidents and advisories are fine; name bug classes and issue numbers, not small downstream projects.
- Keep the services dependency-light; the lab should build offline once the base image is cached.
- Match the surrounding code's style (see `.editorconfig`).
