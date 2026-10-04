# Независимые product releases и native roots

Spec: [утверждённый фундамент](../specs/2026-10-02-orca-shared-foundation-design.md), §7/10/12.
Inline; по просьбе пользователя крупный связанный блок, целевые native/release checks, один итоговый verify/review/pack.

## Global Constraints

- Node24 test native modules и Electron Desktop install roots физически раздельны; pack Electron не ломает Node tests.
- Desktop сохраняет root/version/tag vX.Y.Z/feed/Latest/codenames; CLI/Web имеют собственные manifest/branch/tag. Нет version bumps, tags, публикаций или remote ruleset mutations.
- Product-aware guards и release fixtures проверяют independent версии и make_latest=false для CLI/Web. Web manifest появится в следующем проекте.
- Installed headless JS вне workspace с реальным PTY/Git без DISPLAY; импорт не запускает daemon. Весь verify и локальный pack/open только по whole-end.

### Task 1: Native isolation и artifact checks

**Files:** scripts native setup/resolver/installed smoke runner, Node test hooks, CI.
**Interfaces:** Node test root `.native/node-<abi>-<platform>-<arch>` с own npm install; Desktop node-pty остаётся Electron. Test resolver направляет node-pty/subpaths в Node root; installed artifact own node_modules.
- [x] Installer + реальные Node PTY smoke/root identity; reusable test hook для Desktop/UI.
- [x] CI использует Node root, installed Linux artifact smoke после build; final pack не меняет Node root.

### Task 2: Product release policy/guards/docs

**Files:** product policy, check-git-flow/codenames + fixtures, local ruleset configs, docs.
**Interfaces:** `release/cli/X.Y.Z`, `release/web/X.Y.Z`, `cli/vX.Y.Z`, `web/vX.Y.Z`, independent manifest versions; nonDesktop make_latest=false и запрет Desktop update assets.
- [x] RED CLI/Web branches/tags/independent versions; implement product guard preserving Desktop checks.
- [x] GREEN targeted release fixtures/types; docs/commit, затем один whole-end review/verify/artifact/pack/PR.

Фактические checks: new product branches/tag RED1→GREEN; release/codename/policy16/16 EXIT0. Отдельный Node native install root и настоящий PTY1/1 EXIT0. Runtime/client/UI/headless types PASS, final corrected Desktop node+web types EXIT0. Installed latest Linux artifact и Node smoke после Electron pack — whole-end.
