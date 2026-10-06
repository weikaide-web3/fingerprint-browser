/** Chrome 应用商店扩展支持：来源标记 + 商店 ID */
export const EXT_STORE_SQL = `
ALTER TABLE extensions ADD COLUMN source TEXT NOT NULL DEFAULT 'unpacked';
ALTER TABLE extensions ADD COLUMN store_id TEXT;
CREATE INDEX IF NOT EXISTS idx_ext_store ON extensions(store_id);
`
