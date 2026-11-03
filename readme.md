# QCOM-AWS-DataLake-POC

CDK project creating an IAM role and Lake Formation setup (2 databases x 2 tables).

- `infra/bin/infra.ts` – app entry
- `infra/config/` – naming and database/table definitions (edit `constants.ts`)
- `infra/lib/iam_stack.ts` – data lake IAM role
- `infra/lib/lakeformation_stack.ts` – S3 bucket, LF settings/location, Glue databases/tables, LF permissions

```
cd infra
npm install
npm test
npx cdk deploy --all -c stage=dev
```
