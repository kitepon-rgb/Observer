# ADR 0115: Observerの継続理解とClaude対話transportを分離する

日付: 2026-07-16

## Status

Accepted。ADR 0114のClaude background job経路に対するblocked判定は当時の証拠として維持する。
ただし、その経路をClaude Observerの唯一の実装候補とした再開条件をsupersedeし、Aitermの公開
`claude_agent`を新しいproduction transport候補とする。

## 訂正する二つの誤り

1. Throughline L2は親会話のhost-bound completed evidenceであり、Observer自身の継続理解を保持する
   memoryではない。L2を読めることを理由にObserver sessionを毎cycle作り直してはならない。
2. completed turnごとにfreshなAI requestへ評価させる方式はObserverではない。Observerは同providerの
   一つの利用者可視sessionとして立ち、completed turnを受け取るたびに同じsession内で理解を更新する。

## 正規責務

- **Observer AI session:** 親と同じprovider familyの永続対話session。completed turnを順次受け取り、
  文脈を蓄積して理解し、必要な時だけ助言を返す。利用者は通常のagent sessionとして閲覧できる。
- **Throughline:** 親の確定turn、thread／host switch、rollbackを示す証拠とcursorを提供する。Observerの
  思考状態や会話contextを代替しない。
- **Supervisor:** AIではないNode制御process。新しいcompleted turnだけを同じObserver sessionへ配送し、
  exact-once、timeout後回収、crash recovery、generation lifecycle、Mailbox publishを管理する。
  助言内容を生成せず、毎cycleのfresh evaluatorを起動しない。
- **Mailbox:** Observerが採用した助言を親へ最大一回配送する。親からObserverへのcontext供給経路ではない。

一つのactive generation内では同じprovider sessionへfollow-upする。planned rolloverは物理sessionを更新
できるが、同じ論理Observerとしてcursor、bounded summary／state、未完了operationをtransactionalに
引き継ぐ。rolloverをcompleted turnごとのstateless化に使ってはならない。

## Claude transport

Claude background jobへ非対話replyする旧候補は、Claude Code 2.1.210で公開delivery／exact result readが
不足しblockedとなった。新候補はAitermが提供する永続PTY上の対話型`claude_agent`である。

production採用には、公開Aiterm契約だけで次を満たす必要がある。

- promptなし起動と一意なsession handle
- 同一sessionへの初回／follow-up入力
- Stop完了相関とexact assistant result回収
- timeout時に再送せず同一sessionから回収
- interrupt、terminal確認、close
- user-visibleな対話session
- 通常Claude settings／hookを変更しないlaunch isolation

`claude -p`のcycle反復、Claude private protocol／transcript／debug log、別providerへのfallbackは採用しない。

## Consequences

- P5-1b3は旧background public surfaceのcharacterizationとして完了済みとする。
- P5-1b4の前に、P5-1b3eとしてAiterm `claude_agent`の非H契約・fixture・実装を独立repoで閉じる。
- ObserverのClaude production callerはAiterm公開toolだけを使い、Supervisorの認知主体化やThroughline L2
  のmemory化を行わない。
- 実Claude model request、認証、hook実火はH gateのまま維持する。
