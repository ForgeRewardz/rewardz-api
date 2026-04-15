# f8-fixture-gen

Generates `tests/fixtures/game-prng.json` — the source of truth that
`tests/services/game-service.test.ts` uses to verify the TypeScript port
of `compute_player_hit` / `compute_motherlode_hit` / the checkpoint reward
formula in `mvp-smart-contracts/program/src/game_round.rs`.

Uses the same `sha3::Keccak256` crate that the on-chain program pulls in,
so regenerating this file reflects the canonical on-chain behaviour.

## Regenerating

```bash
cd tools/f8-fixture-gen
cargo run --release > ../../tests/fixtures/game-prng.json
```

`cargo` is required; the generator has no Solana dependencies and builds
on a stock stable toolchain in ~15 seconds.

## Scope

The generator mirrors three pure functions:

- `compute_player_hit(slot_hash, round_id, settle_ts, authority, hit_rate_bps)`
- `compute_motherlode_hit(slot_hash, round_id, probability_bps)`
- `reward_amount(is_hit, points_deployed, total_points_deployed, hit_rate_bps, tokens_minted)`

The fixture also carries a Keccak-256 sanity digest for the empty input
so the TS test will fail loudly if the embedded `keccak256.ts` regresses
to NIST SHA3-256 (the two primitives share state but differ by one
padding byte).
