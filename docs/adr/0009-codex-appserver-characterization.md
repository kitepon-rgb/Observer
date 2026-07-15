# ADR 0009: Codex app-server候補の部分受入を固定する

日付: 2026-07-15

## Status

ADR 0008で要求したcharacterizationのうち、per-thread read-onlyとpersistent state回収を受け入れる。
CodexアプリUI可視性、65秒超wait、adapter crash後のturn再開、明示interrupt／停止は未完のため、
app-serverをproduction Observer hostとしてはまだ採用しない。

## Evidence

Codex CLI 0.144.3のapp-serverへ、隔離した一時git repoをcwdとして次を指定した。

- `thread/start`: `sandbox=read-only`、`approvalPolicy=never`、`ephemeral=false`
- `turn/start`: `sandboxPolicy={type: readOnly, networkAccess: false}`、`approvalPolicy=never`
- providerはOpenAI、modelは親環境のCodex family、永続先は通常の`~/.codex/sessions`

実測結果:

1. `thread/start` responseは`sandbox.type=readOnly`、`activePermissionProfile=null`を返した。
2. modelが`touch OBSERVER_WRITE_SHOULD_FAIL`を実行すると`Operation not permitted`で失敗し、
   続く存在確認はexit 0、親からの実ファイル確認でもsentinelは存在しなかった。
3. turnは17.694秒で`completed`となり、別app-server processの`thread/list`から同じpersistent threadを
   `source=vscode`、`ephemeral=false`として列挙できた。
4. 最初の自作client試行は120秒でtimeoutし、process終了後に別processの`thread/read`でturnを
   `interrupted`として回収した。失敗を成功へ丸めず、同一threadの耐久状態を確認した。
5. CodexアプリのUI目視はComputer Useの安全制約で対象appの読取自体が拒否され、未検証である。
   `source=vscode`と共有stateへの列挙をUI表示済みの証拠にはしない。

## Decision

1. Codex app-serverのper-thread read-onlyはP2-5の強制候補として受け入れる。
2. persistent thread IDはprovider handleの一部にできる。ただしapp-server process／active turnの回収に
   必要なhandleを合わせた複合durability設計が完了するまで、ADR 0007 wireを変更しない。
3. production採用前に、同一threadの65秒超wait、process crash後のresume、turn interrupt、
   Observer所有MCPだけのstate／Mailbox write、アプリUI可視性を追加で実測する。
4. timeoutしたturnはunknownやcompletedへ丸めず、`thread/read`のterminal状態を回収する。

## Consequences

- unrestricted親のnative subagentより安全なCodex host候補が実証された。
- app-server processのlifecycleとthread／turnの三者相関が新しい実装責務になる。
- UI可視性が確認できなければ、同じproviderという要件は満たしても「同じアプリで監視」のUXは未達のまま残る。
