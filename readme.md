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
The Lake Formation registration role trusts Lake Formation to use `sts:SetContext` for
Identity Center trusted identity propagation.

Identity Center groups receive the same per-team table mapping in all three scenarios:
team-a receives customers and products; team-b receives orders, products and stock_levels.
Scenario 1 uses LF-Tags, and scenario 2 uses named Lake Formation grants. In scenario 3,
the SMUS project execution roles listed in `infra/cdk.json` are opted in to Lake Formation
for the database and its tables, while the groups receive named table grants. Adding or
recreating a project requires updating `hybridProjectRoleNames` and deploying this stack.
The project roles also need scoped `glue:UpdateTable` IAM permission for Iceberg writes;
the stack grants this without granting S3 data access.

For Glue interactive-session testing, `glueIdentityProjectRoleNames` lists the project
roles permitted to read the Glue Identity Center configuration. This read-only IAM action
requires resource `*` and does not grant table or S3 data access. It does not itself enable
or verify trusted identity propagation.

The full-Lake-Formation scenario databases set their table-creation defaults to prevent
new tables inheriting `IAM_ALLOWED_PRINCIPALS`. Existing database and table grants must
also have `IAM_ALLOWED_PRINCIPALS` revoked separately; changing the database default does
not revoke existing grants. The account-level database creation default still applies if
a database is recreated, so check and remove that grant again on recreation. Keep
`IAM_ALLOWED_PRINCIPALS` on the hybrid scenario.

## Updateable (Iceberg) tables

The CDK app defaults to `tableMode=iceberg` in `infra/cdk.json`, matching the deployed tables.
Keep this setting when deploying any stack, including dependencies. Switching table formats can
cause CloudFormation to attempt to replace existing tables. Never use `tableMode=none` unless
you intend to remove the tables and have verified and backed up any data.

Parquet tables cannot run Athena `UPDATE`. Tested in
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
Lake Formation; scenario 3 stays hybrid. Team A has tested SMUS Athena inserts into customers
and products in all three scenarios, and SMUS native Python inserts into customers using the
Athena API in all three scenarios. The scenario 3 separate IAM role write path has not been
tested. The `migrate_parquet_to_iceberg.py` script is obsolete and disabled.
These are catalog, S3-location, and permission examples. They are not automatically attached to
the existing Lambda or SMUS projects. Athena workgroup/results access and SMUS compute-role
configuration must be added separately before using those interfaces to run DML. The existing
query Lambda remains read-only. The buckets are POC resources with `DESTROY` removal policy and
auto-delete enabled, so back up data before deleting the stack.

For a Team A SMUS Athena insert test, use `infra/scripts/smus_team_a_athena_inserts.sql`.
Replace `REPLACE_RUN_ID` throughout with a new SQL-safe identifier for each run, execute each
statement individually, and check that each verification count is one. The script leaves its
test rows in place. Results can differ for other users, roles and execution engines.
AWS documents that [Glue Spark fine-grained access control does not support writes using Lake
Formation-granted permissions](https://docs.aws.amazon.com/glue/latest/dg/security-lf-enable-considerations.html);
nevertheless, Team A PySpark FGAC inserts into customers succeeded in all three scenarios in
this POC and were verified in Athena. For the scenario 1 insert, the Spark system logs reported
Lake Formation credentials and a successful commit, and the Glue table update carried user
identity context. This does not establish that Lake Formation INSERT permissions are enforced
for PySpark writes; the AWS documented limitation remains relevant. A Team A insert into
scenario 1 orders was denied for lack of DESCRIBE, which does not independently test
INSERT-only authorization.

## Private DataZone, Athena, Glue, STS, Lake Formation and S3 endpoints

The optional `datazone-endpoint` stack creates DataZone, Athena, Glue API, Glue Interactive
Sessions, STS and Lake Formation interface endpoints and an S3 gateway endpoint for VPC-only project compute.
Supply the project security groups and route table:

```
npx.cmd cdk deploy qcom-datalake-poc-dev-datazone-endpoint -c enableDataZoneEndpoint=true -c dataZoneEndpointSecurityGroups=sg-first,sg-second -c s3GatewayRouteTableId=rtb-example
```

Private DNS redirects DataZone, Athena, Glue API, Glue Interactive Sessions, STS and Lake Formation requests
throughout the VPC to the endpoints, but their security group accepts HTTPS only from the supplied project
security groups. Other VPC clients may lose
access unless their security groups are added. Update the list when project security groups change.
Interface endpoints incur hourly and data processing charges. These endpoints provide network
connectivity only; they do not grant Lake Formation, STS, Glue, DataZone or S3 permissions. Other services may need their
own endpoints.
The S3 gateway endpoint changes S3 routing for every subnet using the specified route table; it
does not grant S3 permissions. Review existing bucket policies and connectivity before deployment.

```
cd infra
npm install
npm test
npx cdk deploy --all -c stage=dev
```
