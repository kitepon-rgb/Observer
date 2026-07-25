# ADR 0145: Observerの公開製品identityとrelease readiness

- Status: Proposed
- Date: 2026-07-25
- 対象: source remote、npm package、初回version、license、CI、release gate
- Factory plan: `observer-core-integration` / `oci-0010`・`oci-0020`・`oci-0030`

## 事実

- Observerはオーナーが自作コア製品として開発した製品であり、機能baselineはHEAD `1493b35`で
  `npm test` 412/412、`npm run check`、`observer diagnostics`、`npm pack --dry-run`がgreenである。
- packageは`name=observer`、`version=0.0.0`、`private=true`で、description、license、
  repository metadata、lockfile、release ancestor gateを持たない。
- Git remote、tag、registry releaseがなく、rollback可能なrelease lineageが成立していない。
- npmのunscoped `observer`は第三者package 0.0.2が既に所有している。`@quolu/observer`は
  2026-07-25時点でregistryに存在しない。
- GitHubの`kitepon-rgb/Observer`は2026-07-25時点で存在しない。
- CIはUbuntu・Node 22のtest/checkだけで、v1 required platformであるmacOSのpackage gateを持たない。
- product manifestの製品IDは`observer`である。npm distribution IDはこのwire product IDと同一である必要はない。
- 現在のversion文字列`0.0.0`はpackage、product diagnostics、MCP server、host client identity、
  live preflight、fixture、runbookへ複数固定されている。

## 提案Decision

1. **公開source remoteを`https://github.com/kitepon-rgb/Observer`とする。**
   既定branchは`main`、repository visibilityはpublicとする。既存local historyを正本として初回pushし、
   履歴を書き換えない。
2. **npm distribution IDを`@quolu/observer`とする。** wire product IDと
   `observer.product_manifest.v1#name`は`observer`のまま維持し、package manifestの`name`だけを
   `@quolu/observer`へ分離する。
3. **初回公開versionを`0.1.0`とする。** 完成済み機能をprototypeの`0.0.0`から正式な更新系列へ移すが、
   factory wire v6 rollout前に1.0.0の互換保証を先取りしない。
4. **licenseをMITとする。** rootへ`LICENSE`を追加し、package metadataと公開READMEを同じ裁定へ揃える。
5. **公開前にrelease readinessを機械gate化する。**
   - `package.json`から`private`を除去し、description、license、repository、homepage、bugs、
     publishConfigを固定する。
   - package lockを正本化する。
   - versionのsource/runtime/test/runbook固定値を0.1.0へ一括移行し、package identityと
     product identityの分離をdiagnostics testで固定する。
   - Linuxのhost-neutral testに加え、macOS・Node 22のCIを必須にする。
   - `prepublishOnly`で、publish対象commitが`origin/main`の祖先かつworktree cleanであることを拒否gateにする。
   - test、check、pack、隔離prefix install、5 binary、product/MCP diagnostics、rollbackを公開前に実測する。
6. **remote作成、push、tag、npm publish、global installはH操作とする。**
   本ADRのStatusをAcceptedへ変え、目的・影響・rollbackをControlへ束縛した後だけ実行する。

## 非目標

- Observerの新機能追加
- Linux、WSL、Windows nativeをsupported platformへ昇格すること
- unscoped `observer` packageの取得、fork、置換
- 旧commitや`0.0.0`時代のacceptance証拠を書き換えること
- factory wire v6 rolloutを製品releaseと同時に無監査で行うこと

## 実装受入

- package metadata、diagnostics、MCP、host adapter、preflight、fixture、runbookが0.1.0で一致する。
- `npm test`、`npm run check`、`npm pack --dry-run`、隔離install/verify/rollbackがgreen。
- release gateが未push HEADとdirty worktreeをそれぞれfail closedにする。
- GitHub ActionsがUbuntuとmacOSで同じproduct suiteを通す。
- 公開後に`npm view @quolu/observer@0.1.0`、global version、product diagnostics、
  MCP diagnostics、5 binaryを正規入口から確認できる。

## Rollback

- publish前はlocal commitをrevertし、`0.0.0` candidateへ戻す。
- publish後は0.1.0をunpublishせずdeprecated指定し、global installを直前versionまたはabsent状態へ戻す。
- factory clientはwire v5を維持し、Observerをrequiredへ昇格しない。
