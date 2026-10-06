/** 为 extensions 表补充 permissions 和 description 列 */
export const EXTENSIONS_SQL = `
ALTER TABLE extensions ADD COLUMN permissions TEXT;
ALTER TABLE extensions ADD COLUMN description TEXT;
`