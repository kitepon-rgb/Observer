# ADR 0123: Claude caller recovery補正

日付: 2026-07-16

## Status

Accepted。P5-1b4d最終反証で検出したP1二件を補正した。

## Context

`recoverAitermClaudeSpawn`はexact launch replayを実装したが、初期production callerは
`spawnAitermClaudeObserver`しか呼ばず、既存`starting` watchも新規予約で拒否していた。
そのためlaunch response loss後のjournalが`launching`に残ると、公開callerから回収できない。

またClaude runtimeはparent rebindの各stepで`authorizeGenerationParentRebind`を再実行する。
最初のstepでgenerationが`stopping`へ進んだ後、coreはcurrent identityを`active | rebind_required`に
限定しているため、同じauthorizationの回収前に失敗する。

## Decision

1. Aiterm Claude専用のinitial prepareだけは、callerが`expected_previous_watch_id`へ現在watch IDを
   明示した時に限り、同じtarget／project／Claude providerに属する`starting | launching | active` watchを
   同じwatch IDのlaunch requestへ再束縛する。通常の新規startはlive watchを従来どおり拒否する。
   terminal watch、別provider、別projectは従来どおり新規予約またはfail loudとする。
2. callerは`spawnAitermClaudeObserver`が既存`launching` journalを示した時だけ
   `recoverAitermClaudeSpawn`へ進み、同じ`launch_operation_id`付き`claude_agent` exact replayを使う。
   明示拒否、別receipt、別sessionへのfallbackは行わない。
3. `authorizeGenerationParentRebind`はjournalを先に読む。journalが無い時だけactive generation／bindingから
   新規authorizationを作る。journalがある時は、保存済みfrom/to identityと同じcycle／proposed parentから
   authorizationを再構成し、保存digest完全一致を要求して既存authorizationを返す。
4. raw parent thread、cursor、Aiterm receiptをjournalへ追加保存しない。既存digest-only境界を維持する。

## Acceptance

- callerのspawn response lossが`spawn → recover → activate`で同じreceiptへ収束する。
- Aiterm prepare retryが同じpending/active watchを同一requestへ戻し、別identityを拒否する。
- parent rebindが`stopping`以降に同じauthorizationを回収でき、異なるcycle／parentは拒否する。
- focused failureを先に再現し、補正後のrelated、static、Phase full、独立反証へ束縛する。
- live Claude、publish、push、credential、Latticeは対象外とする。

## Evidence

- focused: characterization追加直後17/20 green・3 fail、補正後20/20 green。
- related: 変更対象8 test moduleで50/50 green、fail 0、skip 0。
- static: `npm run check`と`git diff --check` green。
- Phase full: 最初の再実行は本変更外の期限時計fixture 2件だけが失敗した。所有repoの独立TODOで
  production無変更の固定時計補正をcommit `0893cd6`へ分離後、393/393 green、fail 0、skip 0。
- 最終裁定は[ADR 0124](0124-aiterm-claude-generation-lifecycle-acceptance.md)へ固定する。

## Rollback

本補正のcaller resume分岐、journal-first authorization回収、fixture、本ADRを同じ独立commitでrevertする。
ただし回収不能な旧経路をproduction readyへ戻さない。
