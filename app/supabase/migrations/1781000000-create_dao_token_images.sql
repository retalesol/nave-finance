-- Token image URIs stored off-chain (keyed by DAO address + mint pubkey).
-- The on-chain TokenRegistry only stores name/symbol/decimals; images live here.
CREATE TABLE IF NOT EXISTS dao_token_images (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dao_address    text NOT NULL,
  mint           text NOT NULL,
  image_uri      text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dao_address, mint)
);

-- Index for fast per-DAO lookups.
CREATE INDEX IF NOT EXISTS dao_token_images_dao_address_idx ON dao_token_images (dao_address);

-- Allow any authenticated or anonymous read (images are public).
ALTER TABLE dao_token_images ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public_read_token_images"
  ON dao_token_images FOR SELECT
  USING (true);

-- Inserts/updates are allowed from the anon key (founder stores image on creation).
CREATE POLICY "anon_upsert_token_images"
  ON dao_token_images FOR INSERT
  WITH CHECK (true);

CREATE POLICY "anon_update_token_images"
  ON dao_token_images FOR UPDATE
  USING (true);
