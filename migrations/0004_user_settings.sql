-- Per-user settings: the Google Ads developer token and login customer id. Each value is AES-GCM ciphertext
-- (value_ct + value_iv) sealed with the refresh tokens' key; the AAD binds it to (user_id, key, key_version). No
-- column ever holds a plaintext value. The settings belong to the gws-mcp user and apply to every Google account
-- of that user that uses Google Ads.
CREATE TABLE user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (key IN ('ads.developer_token', 'ads.login_customer_id')),
  value_ct TEXT NOT NULL CHECK (length(value_ct) BETWEEN 1 AND 1024),
  value_iv TEXT NOT NULL CHECK (length(value_iv) BETWEEN 1 AND 64),
  key_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
