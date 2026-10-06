/** 回收站：为可删除实体补充软删除列（deleted_at 非空即在回收站） */
export const TRASH_SQL = `
ALTER TABLE profiles ADD COLUMN deleted_at INTEGER;
ALTER TABLE proxies ADD COLUMN deleted_at INTEGER;
ALTER TABLE extensions ADD COLUMN deleted_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_profiles_deleted ON profiles(deleted_at);
CREATE INDEX IF NOT EXISTS idx_proxies_deleted ON proxies(deleted_at);
CREATE INDEX IF NOT EXISTS idx_extensions_deleted ON extensions(deleted_at);
`
