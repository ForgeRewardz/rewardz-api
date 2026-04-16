// Shared Solana base58 pubkey regex. Solana pubkeys are 32 bytes which
// encode to 43-44 base58 characters, but a few mainnet encoders emit 32-
// character keys for low-order accounts, so the lower bound is relaxed.
// The alphabet excludes 0, O, I, l per Bitcoin's base58 alphabet.
//
// This lives in one place so that ADMIN_WALLETS (config.ts),
// /auth/verify (routes/auth.ts), and league/join (routes/protocols.ts)
// all agree on what a valid pubkey looks like. Previous duplication
// (three copies) had already started to drift — see code-review notes
// on task 20.
export const BASE58_PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
