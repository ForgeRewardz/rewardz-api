// Produces JSON fixtures for F8 TS port of compute_player_hit /
// compute_motherlode_hit / checkpoint reward formula. Mirrors the on-chain
// code in `mvp-smart-contracts/program/src/game_round.rs` byte-for-byte.

use sha3::{Digest, Keccak256};
use std::fmt::Write;

fn hex32(b: &[u8; 32]) -> String {
    let mut s = String::with_capacity(64);
    for byte in b.iter() {
        write!(&mut s, "{:02x}", byte).unwrap();
    }
    s
}

fn compute_player_hit(
    slot_hash: &[u8; 32],
    round_id: u64,
    settle_timestamp: i64,
    authority: &[u8; 32],
    hit_rate_bps: u16,
) -> (bool, u64) {
    let mut hasher = Keccak256::new();
    hasher.update(slot_hash);
    hasher.update(&round_id.to_le_bytes());
    hasher.update(&settle_timestamp.to_le_bytes());
    hasher.update(authority);
    let hash = hasher.finalize();
    let value = u64::from_le_bytes(hash[0..8].try_into().unwrap());
    (value % 10_000 < hit_rate_bps as u64, value)
}

fn compute_motherlode_hit(
    slot_hash: &[u8; 32],
    round_id: u64,
    probability_bps: u16,
) -> (bool, u64) {
    let mut hasher = Keccak256::new();
    hasher.update(slot_hash);
    hasher.update(&round_id.to_le_bytes());
    hasher.update(b"motherlode");
    let hash = hasher.finalize();
    let value = u64::from_le_bytes(hash[0..8].try_into().unwrap());
    (value % 10_000 < probability_bps as u64, value)
}

fn checked_pro_rata(amount: u64, numerator: u64, denominator: u64) -> u64 {
    if denominator == 0 {
        return 0;
    }
    ((amount as u128 * numerator as u128) / denominator as u128) as u64
}

fn reward_amount(
    is_hit: bool,
    points_deployed: u64,
    total_points_deployed: u64,
    hit_rate_bps: u16,
    tokens_minted: u64,
) -> u64 {
    if !is_hit {
        return 0;
    }
    let proportional = checked_pro_rata(total_points_deployed, hit_rate_bps as u64, 10_000);
    let expected = if proportional >= points_deployed {
        proportional
    } else {
        points_deployed
    };
    if expected == 0 {
        return 0;
    }
    checked_pro_rata(tokens_minted, points_deployed, expected)
}

// Five stable test wallets and two slot hashes. The Rust process_settle_round
// writes slot_hash from the SlotHashes sysvar so any 32-byte sequence is a
// valid off-chain fixture — we pick two distinct hashes for coverage.
fn wallets() -> Vec<(&'static str, [u8; 32])> {
    let raw: &[(&str, &str)] = &[
        ("So11111111111111111111111111111111111111112", "So11111111111111111111111111111111111111112"),
        ("BPFLoaderUpgradeab1e11111111111111111111111", "BPFLoaderUpgradeab1e11111111111111111111111"),
        ("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
        ("Sysvar1111111111111111111111111111111111111", "Sysvar1111111111111111111111111111111111111"),
        ("Stake11111111111111111111111111111111111111", "Stake11111111111111111111111111111111111111"),
    ];
    raw.iter()
        .map(|(label, b58)| {
            let decoded = bs58::decode(b58).into_vec().unwrap();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&decoded[..32]);
            (*label, arr)
        })
        .collect()
}

fn main() {
    let slot_hash_a: [u8; 32] = {
        let mut a = [0u8; 32];
        for i in 0..32 {
            a[i] = i as u8;
        }
        a
    };
    let slot_hash_b: [u8; 32] = {
        let mut a = [0u8; 32];
        for i in 0..32 {
            a[i] = (0xA5 ^ i as u8) as u8;
        }
        a
    };

    println!("{{");
    println!("  \"generator\": \"f8-fixture-gen\",");
    println!("  \"keccak_variant\": \"Keccak-256 (pre-NIST, sha3::Keccak256)\",");

    // Keccak-256 sanity vector — the empty string digests to
    // c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
    let sanity = {
        let mut h = Keccak256::new();
        h.update(b"");
        h.finalize()
    };
    println!("  \"keccak_empty\": \"{}\",", {
        let mut s = String::new();
        for b in sanity.iter() { write!(&mut s, "{:02x}", b).unwrap(); }
        s
    });

    println!("  \"slot_hashes\": [\"{}\", \"{}\"],", hex32(&slot_hash_a), hex32(&slot_hash_b));

    // player_hit cases
    println!("  \"player_hit\": [");
    let cases = [
        (&slot_hash_a, 1u64, 0i64, 5000u16),
        (&slot_hash_a, 1u64, 1_700_000_000i64, 5000u16),
        (&slot_hash_a, 2u64, 1_700_000_000i64, 5000u16),
        (&slot_hash_b, 42u64, 42i64, 2500u16),
        (&slot_hash_b, 42u64, 42i64, 10000u16),
        (&slot_hash_b, 42u64, 42i64, 0u16),
        (&slot_hash_b, i64::MAX as u64, i64::MAX, 5000u16),
    ];
    let ws = wallets();
    let mut first = true;
    for (slot_hash, round_id, settle_ts, hit_bps) in cases.iter() {
        for (label, auth) in ws.iter() {
            let (hit, digest_u64) = compute_player_hit(slot_hash, *round_id, *settle_ts, auth, *hit_bps);
            if !first { println!(","); } else { first = false; }
            print!(
                "    {{\"slotHashHex\": \"{}\", \"roundId\": \"{}\", \"settleTimestamp\": \"{}\", \"walletAddress\": \"{}\", \"hitRateBps\": {}, \"expectedIsHit\": {}, \"digestU64\": \"{}\"}}",
                hex32(slot_hash), round_id, settle_ts, label, hit_bps, hit, digest_u64
            );
        }
    }
    println!("\n  ],");

    // motherlode cases
    println!("  \"motherlode_hit\": [");
    let mcases = [
        (&slot_hash_a, 1u64, 100u16),
        (&slot_hash_a, 1u64, 0u16),
        (&slot_hash_a, 1u64, 10000u16),
        (&slot_hash_b, 42u64, 500u16),
        (&slot_hash_b, 999u64, 250u16),
    ];
    let mut first = true;
    for (slot_hash, round_id, prob_bps) in mcases.iter() {
        let (hit, digest_u64) = compute_motherlode_hit(slot_hash, *round_id, *prob_bps);
        if !first { println!(","); } else { first = false; }
        print!(
            "    {{\"slotHashHex\": \"{}\", \"roundId\": \"{}\", \"probabilityBps\": {}, \"expectedIsHit\": {}, \"digestU64\": \"{}\"}}",
            hex32(slot_hash), round_id, prob_bps, hit, digest_u64
        );
    }
    println!("\n  ],");

    // reward_amount cases. Cover: miss → 0; hit with proportional clamp;
    // hit with points_deployed clamp; zero expected → 0; single player.
    println!("  \"reward_amount\": [");
    let rcases: &[(bool, u64, u64, u16, u64)] = &[
        (false, 500, 1000, 5000, 1000),          // miss → 0
        (true, 500, 1000, 5000, 1000),           // proportional = 500, expected = 500, reward = 1000
        (true, 100, 1000, 5000, 1000),           // proportional = 500, expected = 500, reward = 200
        (true, 600, 1000, 5000, 1000),           // proportional = 500, expected = 600, reward = 1000
        (true, 1, 1, 5000, 1000),                // proportional = 0, expected = 1, reward = 1000
        (true, 0, 0, 5000, 1000),                // expected = 0 → 0
        (true, 1_000_000_000, 10_000_000_000, 2500, 1_000_000_000), // big nums
        (true, 250, 1000, 10000, 1000),          // expected = 1000, reward = 250
    ];
    let mut first = true;
    for (is_hit, pd, total, bps, mint) in rcases.iter() {
        let r = reward_amount(*is_hit, *pd, *total, *bps, *mint);
        if !first { println!(","); } else { first = false; }
        print!(
            "    {{\"isHit\": {}, \"pointsDeployed\": \"{}\", \"totalPointsDeployed\": \"{}\", \"hitRateBps\": {}, \"tokensMinted\": \"{}\", \"expectedReward\": \"{}\"}}",
            is_hit, pd, total, bps, mint, r
        );
    }
    println!("\n  ]");
    println!("}}");
}
