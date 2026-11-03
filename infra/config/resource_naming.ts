import { SERVICE_NAME } from './constants';

export const resourceName = (stage: string, suffix: string): string =>
  `${SERVICE_NAME}-${stage}-${suffix}`;

// Glue/Lake Formation names must be lowercase with underscores
export const databaseName = (stage: string, db: string): string =>
  `${SERVICE_NAME}_${stage}_${db}`.replace(/-/g, '_');
