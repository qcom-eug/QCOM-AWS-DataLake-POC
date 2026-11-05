const { GlueClient, GetTableCommand } = require('@aws-sdk/client-glue');
const {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} = require('@aws-sdk/client-athena');

const glue = new GlueClient({});
const athena = new AthenaClient({});

// ALLOWED is a JSON map of { "<database>": ["<table>", ...] } so only known tables can be queried
const ALLOWED = JSON.parse(process.env.ALLOWED_TABLES || '{}');
const WORKGROUP = process.env.ATHENA_WORKGROUP;
const MAX_LIMIT = 100;

const response = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// Supports API Gateway HTTP API (query string / JSON body) and direct invocation
const readParams = (event) => {
  const qs = event.queryStringParameters || {};
  let body = {};
  if (typeof event.body === 'string') {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      body = {};
    }
  }
  return { ...event, ...qs, ...body };
};

const findDatabase = (table, database) => {
  const matches = Object.keys(ALLOWED).filter(
    (db) => ALLOWED[db].includes(table) && (!database || db === database),
  );
  return matches.length === 1 ? matches[0] : undefined;
};

const listSchema = async (database, table) => {
  const { Table } = await glue.send(new GetTableCommand({ DatabaseName: database, Name: table }));
  return {
    database,
    table,
    columns: (Table.StorageDescriptor?.Columns || []).map((c) => ({ name: c.Name, type: c.Type })),
    partitionKeys: (Table.PartitionKeys || []).map((c) => ({ name: c.Name, type: c.Type })),
  };
};

const listRows = async (database, table, limit) => {
  const { QueryExecutionId } = await athena.send(
    new StartQueryExecutionCommand({
      QueryString: `SELECT * FROM "${database}"."${table}" LIMIT ${limit}`,
      WorkGroup: WORKGROUP,
    }),
  );

  for (let i = 0; i < 40; i++) {
    const { QueryExecution } = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId }));
    const state = QueryExecution.Status.State;
    if (state === 'SUCCEEDED') break;
    if (state === 'FAILED' || state === 'CANCELLED') {
      throw new Error(`Athena query ${state}: ${QueryExecution.Status.StateChangeReason || ''}`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    if (i === 39) throw new Error('Athena query timed out');
  }

  const result = await athena.send(new GetQueryResultsCommand({ QueryExecutionId }));
  const [header, ...data] = result.ResultSet.Rows;
  const names = header.Data.map((d) => d.VarCharValue);
  const rows = data.map((r) =>
    Object.fromEntries(names.map((n, idx) => [n, r.Data[idx]?.VarCharValue ?? null])),
  );
  return { database, table, count: rows.length, rows };
};

exports.handler = async (event) => {
  const params = readParams(event);
  const { table, database } = params;
  const action = (params.action || 'schema').toLowerCase();

  if (!table) return response(400, { error: 'table is required' });
  if (!['schema', 'rows'].includes(action)) {
    return response(400, { error: "action must be 'schema' or 'rows'" });
  }

  const db = findDatabase(table, database);
  if (!db) {
    return response(404, {
      error: 'Unknown or ambiguous table; pass database if needed',
      available: ALLOWED,
    });
  }

  try {
    if (action === 'schema') return response(200, await listSchema(db, table));
    const limit = Math.min(Math.max(parseInt(params.limit, 10) || 10, 1), MAX_LIMIT);
    return response(200, await listRows(db, table, limit));
  } catch (err) {
    console.error(err);
    return response(500, { error: err.message });
  }
};
