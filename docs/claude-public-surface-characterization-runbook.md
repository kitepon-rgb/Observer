# Claude public surface characterization runbook

日付: 2026-07-16

## Scope

P5-1b3bで、Claude production callerを実装する前に、公開非対話request、job/session相関、
隔離Stop capture、terminal exact result readの成立／不成立を一回だけ確定する。
本runbookは実行順と停止条件を固定するが、Claude起動またはmodel requestの承認ではない。

## 1. 非H readiness

characterization harness完成後、実Observer packageからread-only preflightを一回実行する。
preflightは少なくとも次を固定する。

```sh
observer-claude-characterization readiness \
  --claude-command "$(command -v claude)"
```

`status=ready_for_h`はversionと公開help surfaceが一致したことだけを表し、live成功ではない。

- Observer product versionとcharacterization executableのpackage内absolute path
- `claude --version`が対象固定versionであること
- `claude --help`の`--bg`、`--settings`、`--setting-sources`、`--safe-mode`
- `claude agents --help`の`--json`、`--all`と、非対話`send`／`reply` surfaceの有無
- isolated settings候補、result-capture hook、sanitized receipt出力先のschemaと権限
- project fingerprint、正規stop／observe入口、cleanup手順

preflightはhost config、credential、agent stateを読まず、Claude session、background job、
model request、hook trustを開始しない。結果が`ready_for_h`でなければHへ進まない。

## 2. H承認境界

実行前に次をまとめてオーナーへ説明し、明示承認を得る。

- 目的: Claude公開面がproduction callerの必要条件を満たすか、一回のjobで確定する。
- 影響: isolated temporary settingsを明示してClaude background jobを一つ起動し、
  model requestを一回行い、公開observe／stopとStop hookを発火させる。
- rollback: 同じjobを正規stopしてterminalを確認し、一時settings／receiptを削除し、
  project fingerprintとcampaign前host config不変を確認する。
- 非対象: user／project／local config変更、credential/login、publish、push、dual-host campaign、
  crash／通信断／timeout注入などのintentional fault。

承認前はbackground launch、model request、hook trust、明示stopを実行しない。

## 3. 実行順

1. preflight receipt、Observer package digest、Claude固定version、project fingerprintを確認する。
2. owner-only temporary directoryへ、characterization harnessが生成したisolated settings、
   canonical capture path、raw-free hook diagnostic receipt pathだけを配置する。既存host configは
   変更しない。

   ```sh
   observer-claude-characterization prepare \
     --work-root "$OWNER_ONLY_CAMPAIGN_ROOT" \
     --expected-cwd "$OBSERVER_PACKAGE_ROOT"
   ```
3. `--setting-sources ""`とisolated `--settings`を明示し、一つのClaude background jobを
   固定・非秘密fixture promptで起動する。raw handleはprocess内だけに保持する。
4. launch ACKと`claude agents --all --json`を同じprocess内でstrict parseし、job/session digestを作る。
5. 公開非対話`send`／`reply` surfaceがreadinessで確認できた場合だけ、同じjobへ一requestを送り、
   exact ACKを記録する。存在しなければ`reply_surface=unsupported`とし、推測command、
   `claude -p --resume`、private protocol、TUI自動操作へ進まない。
6. hook diagnostic receiptでhook invocation、Stop payload、cwd、session digest、result captureを
   独立に照合する。canonical resultが不正でもhook未発火へ丸めない。
7. 公開terminal result readがある場合だけ同じjobから再読し、Stop captureとexact一致を確認する。
   無ければ`terminal_exact_result=unsupported`とし、raw `logs`やprivate stateへfallbackしない。
8. 同じjobを公開observeし、非terminalなら一回だけ正規stopする。terminalを確認するまで
   新しいjobやrequestを開始しない。
9. temporary settings／receiptをcleanupし、残存processなし、project fingerprint不変、
   campaign前host config不変を確認する。

## 4. 判定

sanitized H receiptは次の七項目を独立に記録する。

- `reply_surface`
- `hook_invocation`
- `job_session_correlation`
- `stop_capture`
- `result_capture`
- `terminal_exact_result`
- `cleanup`

各値は`confirmed | unsupported | blocked`だけとする。production callerへ進めるのは、
必要なdelivery／result contractがすべて`confirmed`で、cleanupも`confirmed`の場合だけである。
公開面そのものが無い場合はcharacterizationとしては`unsupported`を確定できるが、
production callerの成功条件にはならない。

## 5. 即時停止条件

- version、package digest、settings候補、hook executableがpreflight receiptと異なる。
- spawn ACK、job、session、Stop payloadを一意に相関できない。
- isolated settings以外のhook／plugin／project customizationが発火した。
- raw ID、prompt、config本文、host log、credentialがsanitized receiptへ混入した。
- terminal、cleanup、project fingerprintのどれかが不明になった。
- fallbackを使わなければ成功にできない。

失敗後は同じhandleのobserve／stop／cleanupだけを行う。再spawn、別provider、fixture成功への
置換を禁止する。
