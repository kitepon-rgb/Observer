# ADR 0121: parent rebind close receipt durability

日付: 2026-07-16

## Status

Accepted。P5-1b4dの親受入で見つけた契約不足を補正する。

## Context

Aiterm Claude planned rolloverは、`pty_close`のstructured `closed | already_closed` receiptを
`generation-host-rollover` journalの`stop_command_receipt_digest`へ保存していた。一方、同じAiterm公開面を
使うsame-provider parent rebindは、adapterが受け取ったcommand receiptを捨て、host-neutral terminal receiptだけを
`generation-parent-rebind` coreへ渡していた。

この非対称はADR 0120の「close command receiptをhost-neutral generation transactionへ耐久化してから
新session startを認可する」という受入条件を満たさない。最初のdelegated fixture reportはこの穴を含むため、
Control上では親補正によりsupersedeとして棄却し、補正後workspaceをretry Runで再検証する。

## Decision

1. `observer.generation_parent_rebind.v1` journalへ`stop_command_receipt_digest`を追加する。
2. command receiptはplain objectかつcanonical JSON 16 KiB以下だけを受理し、SHA-256 digestだけを保存する。
3. terminalの初回確定でdigestを保存し、retryでは同じterminal receiptと同じcommand receiptの完全一致を要求する。
4. background Claude／Codexのcommand receiptなし経路は`null`を維持する。
5. 旧v1 journalのfield欠落は`null`として読み、次の正規transitionでfieldを持つ同じv1形式へ書き戻す。
6. Aiterm parent-rebind adapterは`stopAitermClaudeObserver`の`stop_command_receipt`を捨てず、core terminal確認へ渡す。

## Acceptance

- 修正前focused 0/2: adapterのreceipt欠落と旧journal migration欠落を再現。
- 修正後focused 2/2: exact receipt相関、異なるretry receipt拒否、旧v1 journal読取／書戻しを確認。
- P5-1b4d補正後focused: 44/44 green、`npm run syntax`、`git diff --check` green。
- related／full／独立重監査はP5-1b4d完了候補で頻度規約どおり各一度だけ行う。

## Non-goals

- cross-provider parent rebindを有効化しない。
- raw Aiterm receiptをjournal、Mailbox、Throughlineへ保存しない。
- SupervisorへAI cognitionやcompleted-turn理解を追加しない。
