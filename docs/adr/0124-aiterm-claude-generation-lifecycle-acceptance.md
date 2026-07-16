# ADR 0124: Aiterm Claude generation lifecycle受入

日付: 2026-07-16

## Status

Accepted。P5-1b4dと親TODO P5-1b4の非H実装を完了とする。実Claudeを使うproduction受入は
P5-1b5 dual-host live Hへ残す。

## Accepted scope

1. Observer AIは同providerの利用者可視な永続sessionであり、通常completed cycleは同じsessionへ継続投入する。
   Throughline L2はcompleted-turn証拠であってObserver cognitionの代替ではない。
2. Supervisorは非AIのdelivery、exact-once、recovery、CAS、generation activation、Mailbox制御だけを担う。
3. planned rolloverとsame-provider parent rebindでは、旧Aiterm Claude sessionのstructured closeを耐久化してから
   generation固有の別sessionをpromptless `claude_agent`で起動する。
4. launch response lossは同じ`launch_operation_id`と引数identityを持つ`claude_agent` exact replayだけで回収する。
   `claude_turn(operation_not_found)`、旧background Claude、Codex、別sessionへfallbackしない。
5. initial callerの再開は、明示`expected_previous_watch_id=current watch`と同一target／project／Claude providerを
   満たす`starting | launching | active`だけに限定する。通常の二重startは拒否する。
6. parent rebind journal作成後は、保存済みidentityと同じcycle／proposed parentから同じauthorizationを再構成し、
   generationが`stopping`以降でも新規authorizationを発行しない。
7. cross-provider rebind、実host crash、login、credential、publish、push、端末設定変更は本受入に含めない。

## Gate evidence

- Aiterm exact launch replay: commit `affc2df`、focused 6/6、related 96/96、full 269/269。
- Observer correction characterization: 17/20 green・3 failから、補正後focused 20/20 green。
- Observer related: 変更対象8 test moduleで50/50 green、fail 0、skip 0。
- static: `npm run check`、`git diff --check` green。
- Observer Phase full: 393/393 green、fail 0、skip 0。
- full初回の391/393は、routing契約より前に実時計で期限切れとなる既存fixture 2件だけが失敗した。
  productionを変更せず同じ固定時計へ束縛し、独立commit `0893cd6`で根治してからfullを再開した。

## Independent refutation and parent decision

Phase完了候補の独立反証はP0 0件、P1 3件、P2 0件でrejectを返した。

1. initial host runtimeにexact recoveryはあるがproduction callerが呼ばず、既存watch予約も再開を拒否する。
   実在するP1として採用し、明示watch再束縛と`spawn -> exact recover -> activate`を実装した。
2. same-provider parent rebindが各stepでauthorizationを再発行し、最初のstop後にcurrent identity検証で停止する。
   実在するP1として採用し、journal-firstの同一authorization回収へ訂正した。
3. 補正前workspaceのgateを最終証拠に使えないという指摘を採用した。Throughline black-box再実行は本TODOの
   変更scope外であり要求しない一方、変更scopeのfocused／related／static／Phase fullを補正後workspaceへ再束縛した。

同じTODOへの独立重監査は反復しない。親が採用したP1をfocused、related、fullと実diffで閉じ、未実装を
live成功へ読み替えない。

## Rollback

本受入と同じP5-1b4d実装commitをrevertする。Aiterm側0.14.0／`affc2df`、P5-1b4cまでの通常cycle、
Codex lifecycleは維持する。revert後はClaude rollover／parent rebind／launch response lossをproduction readyと扱わない。
