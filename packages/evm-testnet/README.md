# `@neuro-pay/evm-testnet`

A repeatable local EVM for integration work: starts a forked chain on
demand, hands back an RPC URL, and provides the cheat codes that make a
chain behave like a fixture.

```ts
const chain = await startLocalChain();
const cheats = createCheats(chain.rpcUrl);

await cheats.setBalance(account, 10n ** 18n);
await cheats.dealToken(usdt, account, 1_000n * 10n ** 18n);

await withSnapshot(cheats, async () => {
  // destructive work; chain state is restored afterwards
});

await chain.stop();
```

## Why a fork and not a blank chain

The obvious design is a blank chain plus deploy scripts. It does not
work here.

Three of the things the integration list has to exercise — ERC-1271
verification, the session keystore, and revoke — run inside **Altana's
own contracts**, which this project consumes through
`@altananetwork/sdk` and has neither the source nor the bytecode for.
There is nothing to deploy. Forking puts every contract at its real
address: Permit2, the real ERC-20 with its real `decimals()`, and the
Altana deployments.

What the fork adds on top of a public testnet is what makes it a test
environment rather than a staging environment: instant blocks, unlimited
gas, assignable balances, impersonation, and snapshot/revert.

## What it can and cannot prove

This is the part worth reading before writing a suite against it.

**Forkable** — anything that is an `eth_call`, or a transaction this
process signs and sends itself:

- Permit2's deployment and `permitWitnessTransferFrom`
- the token's `decimals()`, `balanceOf`, `approve`, `transferFrom`
- the keystore's `isValidKey` authority read
- ERC-1271 `isValidSignature` against an already-deployed account

**Not forkable** — `grantSession`, `revokeSession`, `provisionWallet`,
and `provisionRail`. These do not send transactions through the
configured RPC at all: the SDK submits them to **Altana's hosted relay**,
which signs and broadcasts to the real network. Pointing `rpcUrl` at a
fork changes where reads go and has no effect on where the relay writes;
a grant attempted against a fork fails inside the relay's
`wallet_prepareCalls`, because the account it is asked to prepare for
does not exist on the chain the relay can see.

That boundary is architectural, not a configuration gap. The relay-bound
half can only ever be verified against the real network.

## Determinism

Repeatable in the sense that matters most: **a destructive test can run
as often as you like**. `withSnapshot` restores chain state, so an
operation you get one shot at on a real chain becomes an ordinary test.

Not repeatable in the sense of byte-identical state across runs, and the
reason is a property of the network rather than a choice made here.
Determinism needs a pinned fork block, and the public BNB testnet
endpoints are **pruned** — state more than roughly a thousand blocks old
answers `missing trie node`. `forkBlockNumber` is supported and is the
right thing to use, but it only works against an archive endpoint:

```bash
FORK_RPC_URL=https://<archive-endpoint> pnpm test:chain
```

Without one the fork follows the head, so a suite must establish
whatever state it depends on rather than assuming it. That is why the
cheat codes are the interesting half of this package.

## Inherited state is real state

A fork carries everything the real network has, including things you did
not expect. The one that has already cost debugging time: **anvil's
well-known dev accounts are not clean EOAs on BNB testnet**. Somebody has
EIP-7702-delegated them, so `eth_getCode` returns a 23-byte `0xef0100…`
designator. Permit2 branches on `owner.code.length`, so with code present
it skips `ecrecover` entirely and calls ERC-1271 on the delegate — which
fails, with an empty revert that says nothing about why.

Clear it before treating a dev account as an EOA:

```ts
await cheats.setCode(account, "0x");
```

## Running

Needs a way to run anvil and a fork endpoint. Either runner works; the
native binary is preferred when present because it starts in ~50ms
against a container's ~1s.

```bash
brew install foundry        # or https://getfoundry.sh
# ...or just have Docker running; the foundry image is pulled on demand
```

```bash
FORK_RPC_URL=https://data-seed-prebsc-1-s1.bnbchain.org:8545 pnpm test:chain
```

`FORK_RPC_URL` is also read directly out of `apps/api/.env` by the chain
vitest configs, so it only has to be set once. Vitest does not load
`.env` files into `process.env` by itself — Vite reads them but exposes
only `VITE_`-prefixed keys — so without that wiring the obvious place to
put the value is the one place the tests cannot see it.

`EVM_TESTNET_RUNNER=native|docker|none` pins the runner and
`FOUNDRY_IMAGE` overrides the container image. Turbo strips the
environment by default; these four plus `EVM_TESTNET_REQUIRE` are on the
`passThroughEnv` allowlist in `turbo.json` and nothing else reaches the
suites.

To drive the API against a chain by hand:

```bash
pnpm --filter @neuro-pay/evm-testnet chain
```

## Skipping is not failing

When no runner or no fork URL is available, the chain suites **skip with
a reason** rather than failing. A suite that hard-fails on a missing
binary trains people to ignore it or delete it; one that prints
"install foundry or start Docker, then re-run" gets run.

The tradeoff is that a green `pnpm test` does not by itself mean the
chain suites passed — they are not part of it, and a skipped chain run
reports "successful" while executing zero tests.

That is what `EVM_TESTNET_REQUIRE=1` is for. With it set, a missing
runner or fork endpoint is a hard failure naming exactly what is absent
instead of a warning that scrolls past:

```bash
EVM_TESTNET_REQUIRE=1 pnpm test:chain
```

Set it in CI. Leave it unset locally, where skipping is the right
behaviour for someone who never opted in.
