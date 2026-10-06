/**
 * M5 会话模块迁移。
 * sessions_meta 表在 core 迁移里已建好，这里只补 profile 上的登录态策略。
 */
export const SESSION_SQL = `
ALTER TABLE profiles ADD COLUMN session_policy TEXT NOT NULL DEFAULT 'keep';
`