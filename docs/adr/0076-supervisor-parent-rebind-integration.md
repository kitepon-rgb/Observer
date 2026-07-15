# ADR 0076: parent rebindをSupervisor processへ接続する

日付: 2026-07-16

## Status

Accepted for implementation。parent rebind authorization、provider binding、Supervisor processを接続する。
planned rollover、watch／provider fault、実Claude deliveryを同じtransactionへ混ぜない。
実thread／host switchとcrash境界はPhase O2 H gateまで完了扱いにしない。

## Context

Supervisor production stepはprepared cycleのparent proposalとcurrent generation epochが違う時、
model requestより前に`E_SUPERVISOR_PARENT_REBIND_REQUIRED`で停止する。parent rebind coreとClaude／Codex
provider bindingは実装済みだが、このmismatchをrecord-first authorizationへ変換するproduction caller、
process restart回収、activation後のprepared cycle再開が未接続である。

planned rolloverのprocess統合は同provider／同parent epochだけを扱い、runtime ownershipも
`advanceGenerationRollover`一件に固定されている。そのままparent rebindへ流用するとreason、journal、
provider transition、prepared cycleのgeneration identityが曖昧になる。

## Decision

1. `runSupervisorProductionStep`はprepared cycleを作成／再読した後、evidence収集とmodel operationより前に
   parent epochを照合する。不一致時はprocess所有の`prepareGenerationParentRebind` callbackを一回呼び、
   `authorizeGenerationParentRebind`のexact resultを検証してからsanitized
   `rebind_required` production resultを返す。callback欠損、provider capability欠損、result不正は
   authorization前またはmodel request前にfail loudにする。
2. prepared cycle、fixed-through cursor、proposed parentは削除・書換えない。authorization後は旧generationへ
   evidence収集、reservation、model requestを一度も行わない。new epoch activation後、同じpending cycleを
   `runFixedThroughReplay`で再構成し、新generation identityで初めてmodel operationを作る。
3. provider runtime ownershipへ次の二callbackを追加し、planned rollover callbackと分離する。
   - `prepareGenerationParentRebind({ cycleId, proposedParent })`: provider transition capabilityを副作用前に確認し、
     host-neutral authorizationをrecord-firstする。
   - `advanceGenerationParentRebind()`: pending prepared cycleから同じauthorizationとcanonical launch requestを
     再構成し、rebind provider bindingを一回だけ呼ぶ。
4. Supervisor processは開始時と`rebind_required`後にparent rebind statusをplanned rollover statusより先に読む。
   両journalの同居、journalなしの非active generation、target／watch／provider／generation不一致をfail closedにする。
   `progressed`は即時継続、`pending`はbounded poll、`activated`はgeneration／watch／journal再読、`unknown`は
   固定errorで非0終了とする。
5. processのcurrent providerはactivation後のactive generation／watchからだけ更新する。cross-provider途中の
   watch monitorはrebind journalに固定された`from_provider | to_provider`だけを許し、任意provider変化を受け入れない。
   provider managerはstableなtermination signalと、activation後のcurrent provider runtimeを提供する。
6. Codex production runtimeはこのwaveでは`codex -> codex`だけをcapabilityとして認める。同じinitialized
   app-server sessionをold terminal、new thread spawn／ready、activation後のmodel cycleに使う。
   `codex -> claude`はClaude verification／delivery runtimeがまだH未受入なので、authorization前に
   `provider_unavailable`としてfail loudにする。generic processとprovider bindingのcross-provider fixtureを、
   実host対応済みという証拠に読み替えない。
7. process restart時はpending prepared cycleから同じcycle ID／proposed parentを読み、authorizationを冪等回収して
   provider bindingだけを先に進める。別cycle、別proposal、別launch request、別handleを探索しない。
8. 公開production／process resultへauthorization本文、cursor、thread／job handle、launch request、provider outputを
   含めない。内部`rebind_required`はactivation完了までprocess terminal成功へ丸めない。

## Non-goals

- planned rollover journal／callbackの汎用renameまたは統合。
- watch／provider fault receipt、自動restart、takeover、別handle探索。
- Claude live request、cross-provider live switch、credential、login、network、publish、deploy、意図的障害試験。

## Acceptance

- production focused fixtureでparent mismatchがauthorizationを一回recordし、evidence／model callbackを呼ばず
  `rebind_required`を返す。capability欠損と不正receiptはstate mutation前後を曖昧にせずfail loudになる。
- process focused fixtureで`rebind_required -> progressed -> pending -> activated`を同じleaseで進め、
  同じprepared cycleのproduction stepへ戻る。
- restart時にrebind journalがあればproduction stepより先に回収し、planned rollover journalとの同居、unknown、
  provider／identity不一致を拒否する。
- generic fakeでsame-providerとcross-providerのcurrent provider更新を固定し、Codex runtime fixtureでは同じsession、
  canonical request、same-provider capability、cross-provider authorization前拒否を固定する。
- focused gateはSupervisor production step／process／Codex processとparent rebind binding/coreだけを実行する。
  TODO完了候補で関連gateを一度、full regressionとlive H gateはPhase O2末に一度だけ行う。
