import type { Security } from '../../core/types.js';
import {
  createStatementCache,
  parseJsonArray,
  toJson,
  toNullableText,
  toNumber,
  toText,
  type SqliteDatabase,
} from '../index.js';

/** The ticker dictionary (§25) — `ambiguity` is what stops META-ANALYSIS → META. */
export interface SecurityRepo {
  upsertMany(securities: Security[]): void;
  all(): Security[];
  byTicker(ticker: string): Security | null;
}

interface SecurityRow {
  ticker: string;
  name: string;
  aliases: string;
  exchange: string;
  ambiguity: string;
  indices: string;
  sector: string | null;
  priority: number;
}

const COLUMNS = `ticker, name, aliases, exchange, ambiguity, indices, sector, priority`;

function toSecurity(row: SecurityRow): Security {
  const ambiguity = row.ambiguity;
  return {
    ticker: toText(row.ticker),
    name: toText(row.name),
    aliases: parseJsonArray<string>(row.aliases),
    exchange: toText(row.exchange),
    ambiguity: ambiguity === 'safe' || ambiguity === 'blocked' ? ambiguity : 'ambiguous',
    indices: parseJsonArray<string>(row.indices),
    sector: toNullableText(row.sector),
    priority: toNumber(row.priority, 50),
  };
}

export function createSecurityRepo(db: SqliteDatabase): SecurityRepo {
  const stmts = createStatementCache(db);

  const upsertOne = (s: Security): void => {
    stmts.get(`
      INSERT INTO securities (${COLUMNS})
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(ticker) DO UPDATE SET
        name = excluded.name,
        aliases = excluded.aliases,
        exchange = excluded.exchange,
        ambiguity = excluded.ambiguity,
        indices = excluded.indices,
        sector = excluded.sector,
        priority = excluded.priority
    `).run(
      s.ticker.toUpperCase(),
      s.name,
      toJson(s.aliases ?? []),
      s.exchange ?? '',
      s.ambiguity,
      toJson(s.indices ?? []),
      s.sector,
      s.priority,
    );
  };

  const upsertManyTx = db.transaction((securities: Security[]) => {
    for (const s of securities) upsertOne(s);
  });

  return {
    upsertMany(securities: Security[]): void {
      if (securities.length === 0) return;
      upsertManyTx(securities);
    },

    all(): Security[] {
      return stmts
        .get<SecurityRow>(`SELECT ${COLUMNS} FROM securities ORDER BY priority DESC, ticker ASC`)
        .all()
        .map(toSecurity);
    },

    byTicker(ticker: string): Security | null {
      const row = stmts
        .get<SecurityRow>(`SELECT ${COLUMNS} FROM securities WHERE ticker = ?`)
        .get(ticker.trim().toUpperCase());
      return row ? toSecurity(row) : null;
    },
  };
}
