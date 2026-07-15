# ADR 0058: 一cycle一requestをcanonical入力とprovider固有ACKへ束縛する

日付: 2026-07-15

## Status

Accepted for Codex fixture implementation。Claudeのbackground sessionへ非対話でreplyする公開shell APIは
Claude Code 2.1.210に存在しないため、Claude production deliveryはlive H gateまで未実装のまま残す。

## Context

[ADR 0055](0055-provider-exact-result-journal-contract.md)はprovider resultをStop境界へ束縛したが、
cycle入力を同じClaude job／Codex turnへ一度だけ配送する入口は未接続である。host lifecycleがrunningであることは
request受理の証拠ではなく、generic model operationを`accepted`へ進めてはならない。

Codex app-server 0.144.3は、active turnへ追加入力する公開`turn/steer`を持つ。`expectedTurnId`はactive turnと
一致しなければ失敗し、成功結果は同じ`turnId`を返す。Claude Code 2.1.210のagent viewはTUIのpeek／attachから
replyできるが、`claude agents`のshell surfaceはlist／attach／stop等だけで非対話sendを公開しない。
`claude -p --resume`はconversation resumeであり、稼働中background jobへのreply ACKと同じ契約だと実証されていない。

また、provider journalへacceptedを保存した後、generic journalをacceptedへ進める前にcrashすると、generic側は
`dispatching`、provider側は`accepted`になる。provider recoveryがこの状態を`pending`と返すとSupervisorは正しく
拒否するため、保存済みreceiptを`accepted`として再提示しなければならない。

## Decision

1. 一cycleのmodel-visible入力はhost-neutralな`observer.cycle_request.v1`一件をcanonical JSONへしたUTF-8文字列とする。
   fieldは`schema`、`instruction:"analyze_evidence_snapshot"`、`output_schema:"observer.ai_output.v1"`、
   strict検証済み`evidence: observer.evidence_snapshot.v1`だけを持つ。
2. `observer.cycle_input.v1`は、その文字列を非永続`value`として持ち、`model_visible_bytes`をexact UTF-8 byte数、
   `input_digest`を`observer.cycle_input.v1\0<value>`のSHA-256とする。provider adapterは送信直前にvalue、digest、bytesを
   再照合する。prompt、snapshot本文、raw provider requestはjournalへ保存しない。
3. Codexの一回のissueは次の順序へ固定する。
   - 保存済みgeneration handleのthread／turnだけを`thread/read(includeTurns=true)`で読む。
   - thread ID、session ID、cwd、active turn ID／statusをexact照合し、request前の最後の`agentMessage.id`を
     `after_item_id` baselineとする。候補が無ければnullとする。
   - 同じthreadへ`turn/steer({threadId,input:[{type:"text",text:value}],expectedTurnId})`を一回だけ送る。
   - exact `{turnId: expectedTurnId}` ACKを得た後だけ、thread／session／turn／cwd／baseline handleを
     provider journalへatomic保存し、generic callbackへaccepted receiptを返す。
4. `thread/read`、`turn/steer`、ACK parse、provider journal保存のthrow／timeoutを丸めない。ACK不明または
   ACK後・journal前crashではgeneric `dispatching`を残し、新しいsteer、別turn、`turn/start`へfallbackしない。
5. generic `dispatching` recoveryでmatching provider journalが既にacceptedなら、同じreceiptを
   `outcome:"accepted"`として再提示する。generic `accepted`から同じacceptedを再提示することも冪等である。
   Stop未sealを`pending`と返すのは、callerがprovider receiptを既に耐久化済みと確認できる場合に限る。
6. Codex Stop seal／result readはADR 0055を維持する。`turn/steer` ACK自体をcycle完了証拠にせず、
   matching Stop session／turnとbaseline以後のexact itemが揃うまでcompletedへ進めない。
7. Claudeはcanonical cycle requestを同じ形で使うが、background jobへの公開非対話reply ACKが実証されるまで
   issue callbackをproductionへ接続しない。TUI自動操作、private daemon protocol、transcript直書き、
   `claude -p --resume`の推測利用、別job spawnをfallbackにしない。
8. Claudeのlive H gateでは、隔離`--settings` Stop hook、job `sessionId`／Stop `session_id`、同じjobへの
   一request一ACK、request後のStop captureを一度のfixtureで実証する。成立しなければClaude adapterを
   `provider_unavailable`で止め、対応済みと扱わない。

## Crash matrix

- baseline read前／後・steer前: generic dispatching。recover only、新規steer禁止。
- steer受理後・ACK不明: generic dispatching。provider operation missingとして停止する。
- ACK後・provider accepted保存前: generic dispatching。handle探索や再送を行わない。
- provider accepted保存後・generic accepted前: provider receiptをacceptedとして再提示する。
- generic accepted後・Stop前: matching acceptedまたはpending。requestを再送しない。
- Stop seal後: ADR 0055のexact item readへ進む。

## Acceptance

- cycle request builderがsnapshotを再検証し、exact canonical value／digest／bytesを返す。
- Codex focused fixtureがbaseline null／last agent item、thread／session／cwd／turn mismatch、非active turn、
  exact steer params／ACK、送信一回、ACK不明時journal未作成を固定する。
- provider accepted後・generic accepted前のrecoveryが同じreceiptをacceptedとして返す。
- Codex fixtureは実model、network、credential、hook trustを使わない。
- Claudeは公開send surfaceとsession相関がlive H gateでgreenになるまで未完を維持する。
