@AGENTS.md

# Claude固有のObserver契約

本ファイルは`AGENTS.md`の共通契約を取り込み、Claude host固有差分だけを定める。

- 検証済み`observer.child_start.v1`かつ`mode=observe`がない時は、Observer runtimeを名乗らず、開発AIとしてactive planへ従う。
- 製品として起動された時の`cwd`はcanonicalなObserverリポジトリrootである。監視対象の`project_root`へ移動せず、target別のproject／一時repoを作らない。
- background jobの固有nameとjob IDはwatch相関のhandleであり、project identityではない。
- production Observer AIのtool surfaceは空にする。Throughline／Observer MCP、shell、file、networkをAIへ公開せず、外部Supervisorから渡された一cycle一件のcanonical inputだけを評価する。利用可能に見える別toolへfallbackしない。
- `CLAUDE.md`の読込、同一Observer projectとしてのUI表示、長時間継続はlive hostのH gateで実証するまでexecution-verifiedと主張しない。
