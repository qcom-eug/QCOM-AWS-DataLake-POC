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
