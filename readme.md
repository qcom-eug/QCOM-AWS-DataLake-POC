# QCOM-AWS-DataLake-POC

CDK project creating an IAM role and Lake Formation setup, with two core databases and three access-control scenario databases.

- `infra/bin/infra.ts` – app entry
- `infra/config/` – naming and database/table definitions (edit `constants.ts`)
- `infra/lib/iam_stack.ts` – data lake IAM role
- `infra/lib/lakeformation_stack.ts` – S3 bucket, LF settings/location, Glue databases/tables, LF permissions

The Lake Formation stack also creates three isolated access-control examples. Each scenario
has its own S3 bucket and a database containing the same four table definitions:

| Database suffix | Access model | Example principal |
|---|---|---|
| `scenario1_lf_tag` | Full Lake Formation; LF-Tag grants | `qcom-datalake-poc-<stage>-scenario1-lf-tag-role` |
| `scenario2_lf_named` | Full Lake Formation; explicit database/table grants | `qcom-datalake-poc-<stage>-scenario2-lf-named-role` |
| `scenario3_hybrid` | Hybrid registration; opted-in LF role plus non-opted-in IAM role | `...scenario3-hybrid-lf-role` and `...scenario3-hybrid-iam-role` |

The hybrid example opts the LF role into both the database and each table with Lake Formation
custom resources. The IAM path uses `IAM_ALLOWED_PRINCIPALS` plus the IAM role's Glue and S3
permissions. Scenario roles trust the account root; callers still need `sts:AssumeRole`.

## Updateable (Iceberg) tables

Tables are Parquet by default (`tableMode=parquet`), which cannot run Athena `UPDATE`. Tested in
this account: an Iceberg table in a Lake Formation-registered bucket accepted Athena `INSERT`,
`UPDATE` and `DELETE` from a role that had only Lake Formation grants (no S3 data access), and
failed once `INSERT`/`DELETE`/`ALTER` were revoked. CloudFormation cannot convert an existing
table to Iceberg in place (a custom-named Glue table requires replacement), so convert with two
deploys; this is only safe while the tables hold no data you need (they were empty when checked):

```
npx.cmd cdk deploy qcom-datalake-poc-dev-lakeformation -c tableMode=none     # drops tables and their grants
npx.cmd cdk deploy qcom-datalake-poc-dev-lakeformation -c tableMode=iceberg  # recreates as Iceberg + write grants
```

In `iceberg` mode Lake Formation grants become SELECT/INSERT/DELETE/ALTER/DESCRIBE, and the
scenario 3 IAM role also gets S3 write and `glue:UpdateTable`. Scenarios 1 and 2 stay fully
Lake Formation; scenario 3 stays hybrid. The scenario 3 opted-in-role and LF-tag paths have not
been separately tested. The `migrate_parquet_to_iceberg.py` script is obsolete and disabled.
These are catalog, S3-location, and permission examples. They are not automatically attached to
the existing Lambda or SMUS projects. Athena workgroup/results access and SMUS compute-role
configuration must be added separately before using those interfaces to run DML. The existing
query Lambda remains read-only. The buckets are POC resources with `DESTROY` removal policy and
auto-delete enabled, so back up data before deleting the stack.

```
cd infra
npm install
npm test
npx cdk deploy --all -c stage=dev
```
