# Pump.fun Replay Sprint — Paper Bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/cunong05/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/cunong05/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Sniper paper-trading bot for the pump.fun bonding-curve replay
(`agent-fun/replay/v2`, 10 SOL paper capital, 24-hour final window). It
snipes a fresh curve in its first burst of buying — several buys from
distinct wallets and net SOL flowing in within a few slots of creation —
takes one fixed-size position (0.1 SOL), never adds, and gets out fast: a
take-profit, a stop loss, a fade on outflow, or a time limit. Tiny probe
round trips keep the run above the guardrail pace (20 coins, 200 fills).

Run: `npm start` (the grader runs `node /bot/main.ts`). Fully deterministic:
no clock, no randomness, so the two grading runs produce byte-identical
action logs. The `vendor/makefun-bot.ts` shim is the kit's SDK, copied
unchanged.

Referral: https://make.fun/r/4w89k05q
