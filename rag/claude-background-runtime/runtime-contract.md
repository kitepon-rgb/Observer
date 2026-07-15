# Claude background runtime契約

- 出典: https://code.claude.com/docs/en/agent-view
- 取得日: 2026-07-15
- 確度: official-primary。Agent viewはresearch previewのためversion更新時に再検証が必要。
- raw: [agent-view.md](raw/agent-view.md)

## Observer実行層へ採る事実

- `claude --bg --name <name> <prompt>`はbackground sessionを起動し、短いsession IDと管理commandをstdoutへ返す。
- 通常の識別行は`backgrounded · <short-id> · <name>`。supervisor未起動時は、その前に
  `Starting background service…`が出ることがあるため、先頭行固定ではなく識別行をexactに一件抽出する。
- background sessionは実行cwdで開始する。Observer runtimeはspawn processの`cwd=request.host.cwd`を固定する。
- session IDは`claude agents`、`attach`、`logs`、`stop`の公開handleである。
- background supervisorはCLI更新後に再起動し得る。version互換とhandle回収を別々に検証し、親process lifetimeへ依存しない。

## 採らない推測

- spawn成功後に`agents --json`を一回読めば必ず即時表示される、とは扱わない。
- nameだけをjob handleにしない。stdoutで得たshort IDを先に耐久化し、そのIDだけを一覧で相関する。
- terminal `done`をObserverの結果回収済みとは扱わない。
