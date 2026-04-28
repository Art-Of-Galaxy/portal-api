const { Pool } = require('pg');

const parseBoolean = (value) => {
  if (typeof value !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL }
  : {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASS,
      database: process.env.DB_NAME || process.env.MYSQL_DB,
    };

if (process.env.DB_SSL) {
  poolConfig.ssl = parseBoolean(process.env.DB_SSL)
    ? { rejectUnauthorized: false }
    : false;
}

const pool = new Pool({
  ...poolConfig,
  max: 10,
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL idle client error:', err);
});

function convertMysqlPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function adaptResult(result) {
  if (result.command === 'SELECT') {
    return result.rows;
  }

  if (result.command === 'INSERT') {
    return {
      insertId: result.rows?.[0]?.id ?? null,
      rowCount: result.rowCount,
      rows: result.rows,
    };
  }

  return {
    rowCount: result.rowCount,
    rows: result.rows,
  };
}

const poll = {
  query(sql, values, callback) {
    const params = Array.isArray(values) ? values : [];
    const cb = typeof values === 'function' ? values : callback;
    const convertedSql = convertMysqlPlaceholders(sql);

    const queryPromise = pool
      .query(convertedSql, params)
      .then(adaptResult);

    if (typeof cb === 'function') {
      queryPromise.then((result) => cb(null, result)).catch((err) => cb(err));
      return;
    }

    return queryPromise;
  },
  end() {
    return pool.end();
  },
};

module.exports = { poll };
