# ADR 0074: parent rebind recovery contextをrequest digestへ束縛する

日付: 2026-07-16

## Status

Accepted for corrective implementation。provider binding受入前の親reviewで再現したcore欠陥を先に直す。

## Problem

`readGenerationParentRebindStatus`はraw-free statusだけを返し、record-first authorization receiptと、
`spawn_authorized`以降に固定したlaunch request digestをcaller入力へ再照合しない。このままprovider bindingが
crash recoveryを行うと、同じprovider／target／watchでも別runtime rootのvalid requestを使って
Codex `turn/start`またはClaude job回収へ進める。

加えてCodexの`spawn_observed`回収はprovider journalの`thread_created | running | turn_start_unknown`を
区別する必要がある。`turn_start_unknown`後にactivation commandを再発行してはならない。

## Decision

1. coreへraw-free `readGenerationParentRebindRecoveryContext`を追加する。authorization receiptを毎回exact digest／
   identity照合し、`spawn_authorized`以降はcanonical launch request本文の完全一致digestを必須にする。
2. `rebind_required | stop_authorized | terminal_observed`ではlaunch requestはまだrecord-first固定前なので、
   authorizationだけを照合する。start authorizationは既存`authorizeReboundGenerationStart`だけがrequest digestを固定する。
3. provider bindingはstatus読取でなくrecovery contextだけを正規入口にする。別request、欠損authorization、
   schema／identity不一致はprovider command前にfail loudにする。
4. Codex `spawn_observed`ではまず`recoverCodexGenerationReady`を読む。`thread_created`だけが一回の
   `activateCodexGenerationObserver`を許し、`running`はready receipt回収、`turn_start_unknown`その他は
   unknownとして再送しない。
5. old Codex stop／terminalは`stopCodexObserver`の相関済みparent terminal receiptをそのままcoreへ渡す。
   generation用raw-free terminal observationから不完全なparent receiptを捏造しない。

## Acceptance

- spawn authorization後にruntime rootだけ違うrequestをprovider command前に拒否する。
- `thread_created -> turn/start`は一回、`running -> ready recovery`はread-only、`turn_start_unknown`はunknownとなる。
- old Codex terminal receiptはthread／turn／terminal時刻を失わずcore validatorを通る。
- focused correction後にprovider binding TODOの関連gateを一度だけ実行する。
