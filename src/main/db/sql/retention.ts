/**
 * 登录态保留策略（账号维度）。
 *
 * Google / X 都把「登录态是否连续」当作设备信任信号，所以清理必须是可选的、
 * 并且要能保护关键会话键 —— 给每个环境一组可配置字段，
 * 而不是让用户手动点「清理」时把账号信任一起删掉。
 */
export const RETENTION_SQL = `
ALTER TABLE profiles ADD COLUMN session_max_age_days INTEGER;
ALTER TABLE profiles ADD COLUMN session_on_expire TEXT NOT NULL DEFAULT 'keep';
ALTER TABLE profiles ADD COLUMN session_protected_keys TEXT NOT NULL DEFAULT '[]';
`