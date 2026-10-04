# Общий client и UI с platform injection

Spec: [утверждённый фундамент](../specs/2026-10-02-orca-shared-foundation-design.md), §3/4/6/8/12.
Исполнение inline, один whole-range reviewer в конце; пользователь просит крупные блоки и минимум промежуточных suites.

## Global Constraints

- Перенос существующего UI без редизайна/нового Web приложения; общие компоненты/CSS/i18n/assets имеют одного владельца.
- Client/UI browser-safe, CLI не зависит от React; type-only/orphan/symlink import edges проверяются.
- Typed client получает transport; host-verified identity остаётся вне JSON. Explicit project/revision, same request id при retry, bounded observer reconnect и late generation guard.
- Desktop window/dialog/update функции — PlatformAdapter; старый window.orca остаётся совместимым preload API. UI получает binding через injection, HMR optional capability checks сохранены.
- По ходу только значимый reconnect/dedup/late regression и types; полный verify/build/UI ручная проверка/pack whole-end. UI user check без автоматических кликов.

### Task 1: Browser-safe typed operator client

**Files:** contracts operator command map/snapshot; packages/client transport/state/http/tests.
**Interfaces:** `OrcaClient.call(group, method, args, {projectId, revision})`; prepared request повторяет identity. `OperatorTransport` hello/call/select/snapshot/events/close и binary/writer ports. Client state содержит отдельные selection/language, cursor и connection generation.
- [x] RED reconnect duplicate identity и late response generation; implement common client/transport.
- [x] GREEN focused client checks/types; no React dependency.

### Task 2: Shared UI и Desktop platform bridge

**Files:** packages/ui components/styles/i18n/assets; browser-safe legacy API/platform types; Desktop bootstrap/shared wrappers/vite/tests; DESIGN/docs.
**Interfaces:** существующий renderer получает `getUiApi()` из injected client + PlatformAdapter. Desktop bootstrap собирает bindings из старого preload, сохраняет optional APIs при HMR. Новые operator bridge методы предоставляются только verified main frame, используют owner ledger/revision/event snapshot.
- [x] Move existing UI intact, update test roots/imports and canonical paths; no duplicate components.
- [x] Bind Desktop shared operator session to same command graph, mutation preflight before backup; close client drops leases only.
- [x] Browser boundaries/types и целевой reconnect check; docs/commit одним блоком.

Фактические проверки: client identity/late RED missing module → GREEN2/2; actual browser graph guard обнаружил provider type edge, перенесён обратно в Desktop → GREEN; focused client/boundaries/real endpoint4/4, Desktop startup/editor/chat integration51/51. Client/UI/runtime/headless types PASS; Desktop ambient SVG include и optional projectId исправлены в следующем блоке, окончательный types receipt whole-end. Whole-end full verify/build/review/pack после F.
