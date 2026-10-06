import { CORE_SQL } from './sql/core'
import { AUTOMATION_SQL } from './sql/automation'
import { SESSION_SQL } from './sql/session'
import { IP_QUALITY_SQL } from './sql/ip-quality'
import { RETENTION_SQL } from './sql/retention'
import { ACCOUNTS_SQL } from './sql/accounts'
import { WEBAUTHN_SQL } from './sql/webauthn'
import { TLS_SQL, TLS_STABLE_SQL, TLS_SORTED_SQL } from './sql/tls'
import { EXTENSIONS_SQL } from './sql/extensions'
import { TRASH_SQL } from './sql/trash'
import { EXT_STORE_SQL } from './sql/ext-store'
import { INTEGRITY_SQL } from './sql/integrity'

export interface Migration {
  id: number
  name: string
  sql: string
}

/** 版本化 SQL 迁移。新增迁移请追加到数组末尾。 */
export const MIGRATIONS: Migration[] = [
  { id: 1, name: 'core', sql: CORE_SQL },
  { id: 2, name: 'automation_and_team', sql: AUTOMATION_SQL },
  { id: 3, name: 'session_policy', sql: SESSION_SQL },
  { id: 4, name: 'ip_quality', sql: IP_QUALITY_SQL },
  { id: 5, name: 'session_retention', sql: RETENTION_SQL },
  { id: 6, name: 'accounts_extra', sql: ACCOUNTS_SQL },
  { id: 7, name: 'webauthn_credentials', sql: WEBAUTHN_SQL },
  { id: 8, name: 'tls_observations_and_baselines', sql: TLS_SQL },
  { id: 9, name: 'tls_ja3_stable', sql: TLS_STABLE_SQL },
  { id: 10, name: 'tls_ja3_sorted_and_ext_order', sql: TLS_SORTED_SQL },
  { id: 11, name: 'extensions_permissions_desc', sql: EXTENSIONS_SQL },
  { id: 12, name: 'trash_soft_delete', sql: TRASH_SQL },
  { id: 13, name: 'extensions_store_source', sql: EXT_STORE_SQL },
  { id: 14, name: 'integrity_and_retention', sql: INTEGRITY_SQL }
]
