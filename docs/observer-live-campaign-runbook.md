# Observer dual-host live campaign runbook

日付: 2026-07-16

## Scope

P3-4c／P5-1bで、Claude receiptとCodex `task_complete`からhost-neutralなcompleted
chain、親へのcontinuation、65秒超wait、明示停止を各host一回ずつ実証する。
本runbookは実行順と停止条件を固定するが、live campaignの実行承認ではない。

## 1. 非H preflight

実Observer packageから次を一回実行する。

```sh
observer campaign preflight \
  --claude-command "$(command -v claude)" \
  --codex-command "$(command -v codex)"
```

- `status=h_required`: product、CLI version、Observer MCP read-only面、hook候補、
  canonical cwdだけがgreen。live成功ではない。
- `status=blocked`: `blocked.check`と`blocked.code`を所有TODOへ記録し、修正後に
  同じpreflightを再実行する。後続のH操作へ進まない。

preflightはprovider／app-server、model request、host config read／write、hook trust、
credential、intentional faultを実行しない。

## 2. H承認境界

実行前に、次をまとめてオーナーへ説明し明示承認を得る。

- 目的: 両hostの公開面と実hookでcompleted chainを実証する。
- 影響: Claude設定とCodex hook設定へ候補を適用し、各host一回のmodel request、
  65秒超wait、明示停止を行う。
- rollback: 変更前configを権限保持backupから原子的に復元し、hook trustを解除し、
  起動済みhandleを正規stopしてterminalを確認する。
- 別承認: timeout、crash、通信断などのintentional fault trancheは通常campaignに含めない。

承認前はconfig適用、hook trust、provider起動、model request、長時間wait、明示停止を
一つも実行しない。

## 3. campaign実行順

開始直前にproject fingerprintと対象versionをdigest／固定versionだけで記録する。
config本文、raw ID、prompt、host logは保存しない。

1. Claude／Codexのhost configを個別backupし、mode／ownerと復元可能性を確認する。
2. preflightが生成する正規Stop hook候補をClaude、Codexの順に適用し、各hostでtrustを確認する。
3. Claudeを一回だけbackground launchする。返されたhandleはcampaign内メモリだけに保持する。
4. Claude completed-turn receipt、job/session相関、Stop hook capture、65秒超wait、
   明示stop terminal、親continuationを固定証拠名へ縮約する。
5. Claude handleのterminal確認後にだけCodex app-serverを一回起動する。
6. Codex task-complete receipt、thread/turn/cwd相関、Stop hook capture、65秒超wait、
   interrupt/stop terminal、親continuationを固定証拠名へ縮約する。
7. 両hostのterminalとproject fingerprint不変を確認し、hook設定をbackupへrollbackする。
8. rollback後のconfig構造、mode／owner、hook不在またはcampaign前状態を検証する。

成功にはpreflight receiptが列挙する`required_evidence`全件と、両host一回ずつの
launch／terminal、rollback検証が必要である。fixture receiptや片host成功で代用しない。

## 4. 即時停止条件

次のいずれかで新規launchとmodel requestを止める。

- preflightが`blocked`、または実行直前にversion／package digestが変わった。
- config backup、mode／owner、hook trust、正規stop入口のどれかを確認できない。
- spawn結果を既知handleへ相関できない、または同じhandleの回収入口を失った。
- project fingerprintが変化した。
- raw host log、prompt、config本文、raw ID、token、cookie、credentialがreceiptへ混入した。
- terminal不明、rollback不明、またはprovider errorをfallbackで隠す必要が生じた。

## 5. recoveryとrollback

- spawn結果不明時は同じcampaign／同じhandle・sessionだけを照会する。再spawn、別provider、
  fixture成功へのfallbackをしない。
- terminal不明時は新規作業を起動せず、正規observe／stopで同一handleを回収する。
- config適用後の失敗は新規model requestより先にbackupを復元し、構造、mode／owner、
  campaign前hook状態を検証する。
- rollback自体が不明なら成功扱いせず、対象hostと最後に確認できた状態を報告して止まる。

## 6. 収集禁止

`raw_host_log`、`prompt_body`、`host_config_body`、`raw_session_id`、`raw_thread_id`、
`raw_job_id`、`token`、`cookie`、`credential`は文書、receipt、commit、BugHubへ保存しない。
相関はObserverが生成するdigestと固定証拠名だけで行う。
