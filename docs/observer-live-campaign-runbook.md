# Observer dual-host live campaign runbook

日付: 2026-07-16

## Scope

P3-4c／P5-1bで、Claude receiptとCodex `task_complete`からhost-neutralなcompleted
chain、親へのcontinuation、65秒超wait、明示停止を各host一回ずつ実証する。Claudeは旧background
jobではなく、Aitermの同じpersistent PTY sessionへ初回／follow-upを渡すproduction routeだけを使う。
本runbookは実行順と停止条件を固定するが、live campaignの実行承認ではない。

## 1. 非H preflight

実Observer packageから次を一回実行する。

```sh
observer campaign preflight \
  --throughline-command "/absolute/campaign-prefix/bin/throughline" \
  --aiterm-command "/absolute/campaign-prefix/bin/aiterm-mcp" \
  --codex-command "$(command -v codex)" \
  --state-root "/absolute/campaign-state"
```

- `status=h_required`: product、Throughline 0.6.3の実`observer-read`、
  Aiterm 0.14.0 stdio
  initializeと`claude_agent`／`claude_turn`／`pty_close` exact schema、Codex app-server、hook候補、
  canonical cwdだけがgreen。live成功ではない。
- `status=blocked`: `blocked.check`と`blocked.code`を所有TODOへ記録し、修正後に
  同じpreflightを再実行する。後続のH操作へ進まない。

preflightはAiterm MCP processをread-only initialize後に閉じるが、Claude session、Codex app-server、
model request、host config read／write、hook trust、credential、intentional faultを実行しない。

## 2. H承認境界

実行前に、次をまとめてオーナーへ説明し明示承認を得る。

- 目的: 両hostの公開面と実hookでcompleted chainを実証する。
- 影響: campaign-local prefixへ3製品candidateを導入し、Claude設定とCodex hook設定へ候補を
  一時適用する。各host一回のparent／Observer session launch、初回／follow-upに必要なbounded model
  turn、65秒超wait、明示停止を行う。
- rollback: `apply-observer-hook-config --restore <archive>`で変更前の存在有無、内容、mode、uid／gidを
  原子的に復元し、hook trustを解除し、起動済みhandleを正規stopしてterminalを確認する。
- 別承認: timeout、crash、通信断などのintentional fault trancheは通常campaignに含めない。

承認前はconfig適用、hook trust、provider起動、model request、長時間wait、明示停止を
一つも実行しない。

## 3. campaign-local candidate

global packageは同じversionでも公開surfaceが古い場合があるため使い回さない。
Observer、Throughline、Aitermの受入済みrepo HEADをそれぞれpackし、
`$HOME/.local/share/observer-campaigns/<campaign-id>`の0700専用npm prefixへ
`--ignore-scripts`でinstallする。hook commandの固定境界に合わせ、campaign rootは
空白、quote、control characterを含まないabsolute pathにする。prefix外のglobal packageを
更新しない。

- Observer packageはdotagentsの`verify-observer-package`でprefixと
  expected version 0.0.0を検証する。
- Throughlineは同prefixの`observer-read`がcampaign projectのexact JSONを返す。
- Claude parentを保持するAiterm controller processはcampaign専用の短い0700 `TMPDIR`と
  `PATH=<campaign-prefix>/bin:$PATH`で起動し、global tmux serverを再利用しない。
  macOSでは実物`<TMPDIR>/claude-tmux-sockets/claude.sock`を103 bytes以下にし、launch前に実測する。
  settings内のbare `throughline process-turn`も同じcandidateへ解決する。read側だけcandidateへ向け、
  capture側をglobal packageへ残してはならない。
- Aitermはpreflightのstdio initialize／tool schemaを唯一のversion・surface gateとする。
- candidate tarball、prefix、campaign project、private stateはrollback確認後に削除する。

## 4. campaign実行順

開始直前にproject fingerprintと対象versionをdigest／固定versionだけで記録する。
config本文、raw ID、prompt、host logは保存しない。

1. Claude用とCodex用の独立campaign projectを作り、各project fingerprintを固定する。
2. 次を一回実行し、返されたabsolute archive、0600、本人owner、固定manifestを確認する。

   ```sh
   apply-observer-hook-config --apply \
     --observer-hook <campaign-prefix>/bin/observer-parent-stop-hook \
     --state-root <campaign-state>
   ```

   Claude、Codexの
   candidateを別々に手書きしない。preflight、両parent caller、両Stop hookは同じstate rootへ束縛し、
   state root省略や既定値への暗黙fallbackを許さない。
3. campaign root直下の短い0700 `r`を`TMPDIR`とし、最終socket pathが103 bytes以下であることを
   確認する。`PATH=<campaign-prefix>/bin:$PATH`も持つAiterm controllerの
   公開`claude_agent`でClaude parentを
   一回だけ作り、seed completed turnを確定する。続けて
   controllerのforeground sessionで次を起動する。

   ```sh
   observer parent claude run <claude-project> \
     --throughline-command <campaign-prefix>/bin/throughline \
     --aiterm-command <campaign-prefix>/bin/aiterm-mcp \
     --state-root <campaign-state> --timeout-seconds 600 --poll-interval-ms 1000
   ```

4. 初回exact result後、Observerのwait開始から65秒超経過してから、同じ
   Claude parent sessionへ
   follow-up completed turnを送る。同じObserver sessionのfollow-up exact result、
   completed receipt、
   session／generation相関、Stop hook capture、親continuationを固定証拠名へ縮約する。
5. 同じforeground callerへSIGINTを送り、同じClaude sessionの`pty_close` terminalとcaller terminalを
   回収する。再spawnや旧background jobへfallbackしない。
6. Claude terminal確認後、Codex公開app-serverで別projectのparent threadを一回だけ作り、seed
   `task_complete`を確定する。controllerのforeground sessionで次を起動する。

   ```sh
   observer parent codex run <codex-project> \
     --throughline-command <campaign-prefix>/bin/throughline \
     --codex-command <absolute-codex> \
     --state-root <campaign-state> --timeout-seconds 600 --poll-interval-ms 1000
   ```

7. 初回result後、wait開始から65秒超経過して同じparent threadへfollow-up completed turnを送り、
   task-complete receipt、thread／turn／cwd相関、Stop hook capture、親continuationを固定証拠名へ縮約する。
8. 同じforeground callerへSIGINTを送り、interrupt／stop terminalとcaller terminalを回収する。
9. 両project fingerprint不変を確認し、step 2のexact archiveを
   `apply-observer-hook-config --restore <archive>`へ一回渡す。configの存在有無、内容digest、mode、uid／gidが
   campaign前と一致することを確認してからcampaign-local package／stateを削除する。

成功にはpreflight receiptが列挙する`required_evidence`全件と、両host一回ずつの
launch／terminal、rollback検証が必要である。fixture receiptや片host成功で代用しない。

## 5. 即時停止条件

次のいずれかで新規launchとmodel requestを止める。

- preflightが`blocked`、または実行直前にversion／package digestが変わった。
- config backup、mode／owner、hook trust、正規stop入口のどれかを確認できない。
- preflight、parent caller、Stop hookのstate rootが一致しない。
- Claude parent controllerのPATH先頭がcampaign prefixでなく、captureとreadのThroughline実行物が
  一致しない。
- Aiterm controllerがglobal tmux socketを再利用し、caller processと異なるstale PATHをsessionへ継承する。
- campaign専用runtimeでも、実物`<TMPDIR>/claude-tmux-sockets/claude.sock`のpathがhostの
  Unix-domain socket上限を超える。
- spawn結果を既知handleへ相関できない、または同じhandleの回収入口を失った。
- project fingerprintが変化した。
- raw host log、prompt、config本文、raw ID、token、cookie、credentialがreceiptへ混入した。
- terminal不明、rollback不明、またはprovider errorをfallbackで隠す必要が生じた。

## 6. recoveryとrollback

- spawn結果不明時は同じcampaign／同じhandle・sessionだけを照会する。再spawn、別provider、
  fixture成功へのfallbackをしない。
- terminal不明時は新規作業を起動せず、正規observe／stopで同一handleを回収する。
- config適用後の失敗は新規model requestより先に同じarchiveを`--restore`へ渡し、存在有無、内容digest、
  mode、uid／gid、campaign前hook状態を検証する。手動tar展開や部分コピーで代用しない。
- rollback自体が不明なら成功扱いせず、対象hostと最後に確認できた状態を報告して止まる。

## 7. 収集禁止

`raw_host_log`、`prompt_body`、`host_config_body`、`raw_session_id`、`raw_thread_id`、
`raw_job_id`、`token`、`cookie`、`credential`は文書、receipt、commit、BugHubへ保存しない。
相関はObserverが生成するdigestと固定証拠名だけで行う。
