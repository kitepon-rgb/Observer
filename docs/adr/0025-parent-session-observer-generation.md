# ADR 0025: 一親session epochへ一論理Observerを束縛し物理sessionを世代交代する

## Status

Accepted for lifecycle design。state machine、threshold、host実証は未実装。

## Context

ADR 0002は一target一watchを守るため、親thread再作成時にも別Observerを自動追加しないと裁定した。
しかし一つの物理Claude job／Codex threadをwatch終了まで延命すると、長寿命の親sessionまたは多数の観測cycleで
Observer側の会話・tool contextが無制限に成長する。一方、cycleごとの使い捨てsessionは起動costとUI上のthread数を
増やし、同じproviderで伴走する製品UXを弱める。

必要なのはwatch、親sessionに対応する論理Observer、provider上の物理sessionを別のlifecycleとして扱うことである。

## Decision

1. 一target一active watchの契約は維持する。watchは最初の利用者明示指示から明示停止またはfaultまでの監視認可である。
2. providerとThroughlineのparent thread digestでparent session epochを識別し、一epochへ一つの論理Observerだけを束縛する。
3. 親sessionが切り替わった時は、旧epochの物理generationをterminalへ閉じた証拠を保存してから、同じwatchを
   新epochの論理Observerへrebindする。旧／新epochを並走させず、新しいwatchを作らない。
4. 一つの論理Observerはcontext budgetに応じて複数の物理host generationへ世代交代できるが、activeなgenerationは
   常に一つとする。旧generationのterminalが不明なら新世代を起動せずwatchをfaultedにする。
5. generation rolloverはdurableなcompleted cycle countと累積bounded input bytesをhard ceilingにする。
   providerが公開する信頼可能なcontext usageは補助証拠にできるが、非公開token量の推測だけへ依存しない。
   数値thresholdはP4-2で一cycleのsnapshot上限を固定した後、独立実装ADRで決める。
6. 世代間で引き継ぐのはcursor、dedupe／cooldown receipt、boundedな未解決仮説と相関IDだけとする。
   raw親会話、prompt全文、model出力全文、tool logをdurable memoryとして保存しない。
7. parent rebindとplanned context rolloverは明示起動済みwatchの正常lifecycleであり、fault／crash後の自動再起動ではない。
   三者を別transitionとreceiptで表し、失敗を正常rolloverへ丸めない。
8. 全generationの`cwd`とアプリ上のproject identityはcanonical Observer rootのままとし、target別のfolder／repoを作らない。

本ADRはADR 0002 Decision 5の「別Observerを自動追加しない」を、同時並行の別watchを増やさないという意図を
維持しつつ、parent session epochごとの論理Observer rebindへ置き換える。それ以外の明示起動、同provider、
二重watch拒否、明示停止、fault後の自動再起動禁止は変更しない。

## Rejected alternatives

- 一project一物理Observerを永続化する案: context肥大とparent間の文脈混入をboundedにできない。
- 一観測cycle一sessionにする案: 起動cost、provider消費、UI thread増加が大きく、伴走者としての連続性が弱い。
- 時間だけで機械的に交代する案: 実際のcontext量と無関係であり、bytes／cycle ceilingより根拠が弱い。
- 会話要約だけを次sessionへ渡す案: 要約が第二の可変正本になり、cursor／receiptと相関しない記憶を作る。

## Consequences

- 親sessionとの対応は利用者に説明しやすく、長寿命sessionでも物理contextをboundedにできる。
- app上には世代ごとのthread／jobが残り得るが、すべて同じObserver projectに属し、target別projectは増えない。
- generation state、rollover threshold、terminal回収、rebind testがP2-4の新しい未完TODOになる。
- P4-2のbounded evidence設計がthreshold確定の前提になる。
