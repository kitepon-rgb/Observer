# ADR 0060: observation cycleを外部Supervisorの単一所有へ固定する

日付: 2026-07-15

## Status

Accepted for corrective implementation。本ADRは[ADR 0055](0055-provider-exact-result-journal-contract.md)の
「一generation一Codex turnをStop continuationで複数cycleに使う」部分と、
[ADR 0058](0058-cycle-request-delivery-contract.md) Decision 3-4, 6の`turn/steer`配送をsupersedeする。
canonical cycle request、record-first model operation、provider receipt recovery、cleanup順序は維持する。

## Context

製品契約§5はObserver AI自身がMCP `observer_wait`／`observer_read`を呼び、監査後のStop continuationで
同じturnを次cycleへ進めるとしていた。一方、実装済み`runSupervisorCycle`は同じcommitted cursorから
Throughline wait／read、pending cycle、evidence input、model operation、apply、cursor commitを所有する。

両方を動かすと同じparent changeを二重取得し、AIが見たturn集合をSupervisorのinput digestへ束縛できない。
さらにMCP waitは`after_cursor`必須だが`observer.child_start.v1`はcursorを持たず、AI所有loopは保存cursorから
正規開始できない。

Codex `turn/steer`はactive in-flight turnだけを対象にする。cycle終了後、次のparent changeまでSupervisorが
最大一時間waitする間、Stop hook自体はlong-pollできない。同一turnをcontinuationすると空回りするか、AIにwaitを
戻して二重所有になる。production caller未実装の現在なら、単一所有へ補正しても既存稼働経路は壊れない。

## Decision

1. Throughline wait／read、committed cursor、pending cycle、evidence収集、canonical cycle input、model operation、
   provider result、Mailbox apply、cursor commitは外部Supervisor runtimeだけが所有する。
2. Observer AIは一回の`observer.cycle_request.v1`を評価し、`observer.ai_output.v1`一件を返すだけとする。
   targetのThroughline cursorを知らず、`observer_wait`／`observer_read`を呼ばない。hostへ両MCP toolを公開しない。
3. Observer MCP read／wait serverは公開Throughline adapterとして残すが、production AI loopのownerにはしない。
   diagnostics／compatibility surfaceとしての存廃はPhase O2完了前に別Taskで裁定し、黙って削除しない。
4. Codexの一物理generationは一つのpersistent threadとするが、一cycleは新しい`turn/start`一件とする。
   issue前に保存済みthreadをreadし、thread／session／cwd一致、active inProgress turnが無いことを確認する。
   exact `turn/start` ACK後だけ`thread + session + cycle turn + cwd`をprovider journalへaccepted保存する。
5. Codex result recoveryは同じcycle turnだけをreadする。`inProgress`はpending、`completed`のexact final itemだけを
   completedとし、`failed | interrupted`、別turn、複数候補、本文変化は成功へ丸めない。Codex Stop sealと
   `after_item_id` baselineはcycle分離に使わない。
6. generic `dispatching`＋provider acceptedのrecoveryだけは同じreceiptをacceptedとして再提示する。
   generic `accepted`ではprovider状態を観測し、未完ならpending、結果があればcompletedを返す。
   acceptedを常に再提示して結果pollを永久に飛ばしてはならない。
7. Claudeも外部Supervisor所有とし、一cycle一promptを同じlogical generationへ配送する。Claude Codeの公開
   background／resume面、request ACK、session相関、隔離Stop captureをlive H gateで実証するまでproduction issueを
   `provider_unavailable`にする。TUI automation、private daemon protocol、別job spawnへfallbackしない。
8. project-local Stop hookはmatching provider resultのcaptureだけを行い、次cycleのblock continuationを返さない。
   次cycle開始は外部SupervisorのThroughline waitが所有する。親Mailbox配送用Stop hookは別責務として維持する。
9. production callerは一target一process／一cycle一step、明示watch認可、record-first journal、cancel／fault停止を守る。
   daemon自動restart、暗黙watch、provider request retryを追加しない。

## Consequences

- Supervisorが見たexact evidenceとproviderへ送ったinput digestを一意に相関できる。
- AIのMCP long-poll実測はhost transport capabilityの証拠として残るが、production cycle ownershipの証拠には使わない。
- Codexは同じthreadでcontextを維持しつつcycle turnを分離でき、Stop continuationのidle問題を持たない。
- Claude公開deliveryが成立しなければ両host対応を偽装せず、Phase O2は未完のまま止まる。

## Acceptance

- product contractとAI prompt／host allowlistがSupervisor単一所有へ一致する。
- Codex focused fixtureでthread context read、active turn拒否、一回の`turn/start`、ACK後accepted、
  dispatching receipt recovery、accepted pending、completed exact item、terminal failureを固定する。
- `turn/steer`をcycle deliveryから除去し、Stop continuationをproduction AI loopへ接続しない。
- production caller、Claude live request、hook trust、credential／networkは後続Task／H gateに残す。
