# ADR 0122: Aiterm Claude exact launch recoveryの訂正

日付: 2026-07-16

## Status

Accepted。ADR 0118のlaunch response loss回収判断を訂正する。

## Context

ADR 0118は、保存済みsessionへの`claude_turn(recover)`が`operation_not_found`を返した時に、
`claude_agent`実行済みとしてlaunch journalを`spawned`へ進めた。しかしこのreasonはturn dispatch receiptが
無いことしか示さず、launch要求がAitermへ到達せずsession自体が存在しない場合にも同じ結果になる。
そのためObserverは存在しない`claude.session`をspawn済みとして耐久化し得る。

## Decision

1. launch requestから決定的な`launch_operation_id`を作り、初回のpromptless managed `claude_agent`へ渡す。
2. response loss後は、同じsession名、runtime root、managed flag、`launch_operation_id`を持つ
   `claude_agent`要求だけをreplayする。Aiterm 0.14.0候補の公開契約は、provider、session、相関ID、
   launch引数digestが完全一致する既存sessionだけを同じstructured receiptへ回収し、CLIを再送しない。
   session不在なら同じ呼出しが一度だけ新規起動になる。
3. `claude_turn(recover)`と`operation_not_found`はmodel turn recoveryだけに限定し、launch recoveryから除去する。
4. replay結果は初回と同じ`aiterm.agent-launch-result.v1` exact validatorを通す。text解析、旧background Claude、
   Codex、別sessionへのfallbackは行わない。
5. ADR 0118の他の決定、すなわちrecord-first journal、明示拒否のterminal化、spawn receipt先行耐久化、
   readyとmodel結果の分離は維持する。

## Acceptance

- 初回とrecoveryが同じ`launch_operation_id`付き`claude_agent`入力を使う。
- transport response loss後のrecoveryが`claude_turn`を呼ばず、exact launch receiptだけでspawnedへ進む。
- 相関IDを公開しないAiterm tool schemaをhandshakeで拒否する。
- malformed／identity不一致receiptをspawnedへ降格しない。
- focused／related gate後、P5-1b4dのPhase gateへ統合する。live Claude、publish、pushは行わない。

## Evidence

- Aiterm側: commit `affc2df`。focused 6/6、related 96/96、full 269/269。
- Observer focused: runtime／transportの既存9件と追加負系2件、合計11 passed・0 failed・0 skipped。
- Observer P5-1b4d related: 変更対象8 test moduleで48 passed・0 failed・0 skipped。
- static: `npm run check` green。
- Observer Phase full regressionと独立重監査はP5-1b4d最終gateへ集約し、本ADR単独では反復しない。
- 実Claude request、publish、push: 未実施。

## Parent refutation

1. 同名sessionだけで別launchを誤採用しないか。
   - Aitermがcaller相関IDとlaunch引数digestを完全一致で要求し、Observerもそのschema欠落をhandshake拒否するため棄却。
2. response loss後にmodel promptを再送しないか。
   - replay対象はpromptなし`claude_agent`だけで、model turnの`claude_turn(issue)`は呼ばないため棄却。
3. malformed receiptをspawnedへ降格しないか。
   - session identity不一致fixtureでjournalが`launching`に留まることを固定したため棄却。

## Rollback

本訂正waveをrevertし、`launch_operation_id`のhandshake／spawn／recovery配線とfixture、本ADRを除去する。
ただしADR 0118の誤った`claude_turn` launch probeへ戻すことは安全なrollbackではないため、revert後の
launch response lossはfail loudのまま運用し、Observerをproduction readyとは扱わない。
