/**
 * 出口 IP 质量。
 *
 * 只存 ip / country / city 是不够的：Google 与 X 对数据中心出口的判定是一票否决，
 * 指纹做得再完美也救不回来。所以必须把 usageType / hosting / proxy / mobile / ASN
 * 落库，让「这个代理能不能用来登账号」在列表里一眼可见。
 */
export const IP_QUALITY_SQL = `
ALTER TABLE proxies ADD COLUMN asn TEXT;
ALTER TABLE proxies ADD COLUMN as_name TEXT;
ALTER TABLE proxies ADD COLUMN org TEXT;
ALTER TABLE proxies ADD COLUMN reverse TEXT;
ALTER TABLE proxies ADD COLUMN usage_type TEXT;
ALTER TABLE proxies ADD COLUMN hosting INTEGER;
ALTER TABLE proxies ADD COLUMN is_proxy INTEGER;
ALTER TABLE proxies ADD COLUMN mobile INTEGER;
ALTER TABLE proxies ADD COLUMN anycast INTEGER;
ALTER TABLE proxies ADD COLUMN quality TEXT;
ALTER TABLE proxies ADD COLUMN quality_score INTEGER;
ALTER TABLE proxies ADD COLUMN quality_issues TEXT;
CREATE INDEX IF NOT EXISTS idx_proxies_quality ON proxies(quality);
`