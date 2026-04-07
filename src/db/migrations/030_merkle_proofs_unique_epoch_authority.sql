-- Add UNIQUE constraint on (epoch, authority) for ON CONFLICT support in keeper-bot
ALTER TABLE merkle_proofs ADD CONSTRAINT uq_merkle_proofs_epoch_authority UNIQUE (epoch, authority);
