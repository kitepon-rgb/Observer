# ADR 0070: planned rolloverをSupervisor processへ接続する

日付: 2026-07-16

## Status

Accepted for implementation。既存のgeneration budget、host rollover journal、
provider bindingを再利用し、planned rolloverだけを外部Supervisor processへ接続する。
parent rebind、watch／provider fault receipt、
Claude live deliveryは別TODOとし、本変更へ混ぜない。

## Context

`reserveGenerationInput`は8 completed cycleまたは262,144 model-visible bytes到達前にgenerationを
`rollover_requested`へ進め、Supervisor cycleは`rollover_required`を返す。host-neutral coreは旧host停止、
terminal確認、新host spawn、ready、generation activationを耐久journalで一stepずつ進められる。

しかし現行Supervisor processは`rollover_required`をterminal resultとして終了する。process restart時も
非active generationを先に回収せずproduction stepへ入るため、既存coreとprovider bindingが実運用callerへ
接続されていない。pending cycleを新generationで再開できず、P2-4とP4-2のplanned rolloverは未完である。

## Decision

1. Supervisor processは`rollover_required`を正常終了にせず、同じprocess leaseと同じverified provider
   transport内でgeneration provider bindingへ進む。
2. provider runtime所有物は、model operation用runtime、termination signal、terminal cleanupに加え、
   provider固有の`advanceGenerationRollover` callbackを持つ。callbackは既存
   `advanceGenerationHostProviderRollover`を一回だけ呼び、一回のcallでmutating provider commandを最大一件に保つ。
3. processはprovider runtime作成後と各production step後にgeneration stateを読む。`active`なら通常cycleへ、
   `rollover_requested | stopping | terminal_confirmed | starting`ならproduction stepを呼ばずrollover回収へ進む。
   target／watch／provider不一致、未知status、generation欠落はfail closedにする。
4. binding結果はexact schemaで検証し、次のように扱う。
   - `progressed`: 同じprocessで次の一stepへ進む。
   - `pending`: bounded poll後に同じjournalを再読する。stop／spawnを再送しない。
   - `activated`: generationが同じtarget／watch／providerの`active`へ遷移したことを再読確認して通常cycleへ戻る。
   - `unknown`: 別host探索、新spawn、自動restartへfallbackせず、固定errorでprocessを非0終了する。
5. crash後の新processは非active generationを先に検出し、既存journal／receiptから回収する。
   rollover前にpreparedだったcycleは削除せず、新generation activation後に同じfixed-through cycleを再構成する。
6. next generationのlaunch requestは、新しいwatch予約やユーザーauthorizationを捏造せず、既に認可済みのactive
   watch identity、provider、target、canonical runtime rootから純粋関数で再構成し、既存validatorを通す。
   request本文はrollover journalへ保存せず、既存どおりbounded digestだけを固定する。
7. Codexは同じinitialized app-server transportで旧thread terminal確認と
   新thread spawn／readyを行う。
   app-server process／connectionをgeneration handleにせず、rollover途中で再作成しない。
8. 公開process resultとtransition resultへraw thread／turn／job、launch handle、request本文、provider出力を含めない。
9. parent epoch不一致は引き続きmodel request前に`E_SUPERVISOR_PARENT_REBIND_REQUIRED`で止める。
   rebind transition／receiptとfault transition／receiptは後続TODOで独立実装する。

## Acceptance

- `rollover_required`後、bindingの
  `progressed -> pending -> activated`を同じruntimeで進め、
  activation後に同じprepared cycleのproduction stepへ戻る。
- process restart時にgenerationが
  `rollover_requested | stopping | terminal_confirmed | starting`なら、
  production stepを一度も呼ばずrolloverを回収する。
- pendingはbounded pollし、unknown／schema不正／identity mismatchはfail loudにする。
- activation後のgeneration再読がactiveでなければ通常cycleへ戻らない。
- Codex runtime callbackは同じsession、canonical launch request、target／watchへ束縛され、
  provider bindingを一call一回だけ呼ぶ。
- focused gateはSupervisor process、Codex process、generation provider binding、
  host lifecycleを実行する。
  TODO完了候補で関連gateを一度だけ実行し、full regressionとlive providerはPhase O2末へ集約する。
