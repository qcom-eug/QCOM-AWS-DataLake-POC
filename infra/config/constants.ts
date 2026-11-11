export const SERVICE_NAME = 'qcom-datalake-poc';

export interface TableConfig {
  name: string;
  columns: { name: string; type: string }[];
}

export interface DatabaseConfig {
  name: string;
  tables: TableConfig[];
}

// 2 databases x 2 tables each
export const DATABASES: DatabaseConfig[] = [
  {
    name: 'sales',
    tables: [
      {
        name: 'orders',
        columns: [
          { name: 'order_id', type: 'string' },
          { name: 'customer_id', type: 'string' },
          { name: 'order_ts', type: 'timestamp' },
          { name: 'amount', type: 'double' },
        ],
      },
      {
        name: 'customers',
        columns: [
          { name: 'customer_id', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'email', type: 'string' },
        ],
      },
    ],
  },
  {
    name: 'inventory',
    tables: [
      {
        name: 'products',
        columns: [
          { name: 'product_id', type: 'string' },
          { name: 'name', type: 'string' },
          { name: 'price', type: 'double' },
        ],
      },
      {
        name: 'stock_levels',
        columns: [
          { name: 'product_id', type: 'string' },
          { name: 'warehouse', type: 'string' },
          { name: 'quantity', type: 'int' },
        ],
      },
    ],
  },
];

export const SCENARIO_TABLES: TableConfig[] = DATABASES.flatMap((database) => database.tables);

export const ACCESS_SCENARIO_DATABASES = [
  { key: 'lf-tag', name: 'scenario1_lf_tag' },
  { key: 'lf-named', name: 'scenario2_lf_named' },
  { key: 'hybrid', name: 'scenario3_hybrid' },
] as const;

export interface AccessTeam {
  key: string;
  // database name -> tables the team may query
  tables: Record<string, string[]>;
}

// Each team gets its own LF-Tag keys, because a resource holds one value per tag key
// and the teams share some tables (e.g. products).
export const ACCESS_TEAMS: AccessTeam[] = [
  { key: 'team-a', tables: { sales: ['customers'], inventory: ['products'] } },
  { key: 'team-b', tables: { sales: ['orders'], inventory: ['products', 'stock_levels'] } },
];

export const LF_TAG_VALUE = 'allowed';
// Tag on tables a team may query / on databases a team may see
export const tableTagKey = (teamKey: string) => `access-${teamKey}`;
export const databaseTagKey = (teamKey: string) => `db-${teamKey}`;
