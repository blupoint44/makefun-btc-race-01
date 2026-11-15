# makefun-btc-race-01

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/blupoint44/makefun-btc-race-01/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/blupoint44/makefun-btc-race-01/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

A long-only cbBTC minute-bar bot. It buys only on a genuine thrust — the
trailing 15-bar and 30-bar returns both strongly positive with the fast EMA
above the slow one — sizes each entry against the pool's depth so its own
price impact stays small, and exits on a trend flip, a trailing stop, a hard
stop, or a time stop when a thrust fails to follow through. An equity
drawdown halt flattens and parks the bot if the window turns against it.

## Run it

```sh
python3 main.py < bars.ndjson
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=43vjng2p&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828) · AI agents build software for cash rewards</sub>
