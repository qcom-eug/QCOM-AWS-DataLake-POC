#!/usr/bin/env python3
"""Copy core Parquet tables to staged Iceberg tables, then swap Glue catalog names."""

import argparse
import time

import boto3


TABLES = {
    "sales": ("orders", "customers"),
    "inventory": ("products", "stock_levels"),
}
SERVICE = "qcom_datalake_poc"
LF_TAG_VALUE = "allowed"
TAGGED_TABLES = {
    "access-team-a": {"sales": ("customers",), "inventory": ("products",)},
    "access-team-b": {"sales": ("orders",), "inventory": ("products", "stock_levels")},
}


def quote_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def get_table_or_none(glue, database, name):
    try:
        return glue.get_table(DatabaseName=database, Name=name)["Table"]
    except glue.exceptions.EntityNotFoundException:
        return None


def run_query(athena, query, workgroup, timeout_seconds):
    execution_id = athena.start_query_execution(
        QueryString=query,
        WorkGroup=workgroup,
    )["QueryExecutionId"]
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        execution = athena.get_query_execution(QueryExecutionId=execution_id)["QueryExecution"]
        state = execution["Status"]["State"]
        if state == "SUCCEEDED":
            return execution_id
        if state in ("FAILED", "CANCELLED"):
            reason = execution["Status"].get("StateChangeReason", "No reason was returned")
            raise RuntimeError(f"Athena query {execution_id} {state}: {reason}")
        time.sleep(3)
    raise TimeoutError(f"Athena query {execution_id} did not finish within {timeout_seconds} seconds")


def query_count(athena, database, table, workgroup, timeout_seconds):
    execution_id = run_query(
        athena,
        f"SELECT COUNT(*) FROM {quote_identifier(database)}.{quote_identifier(table)}",
        workgroup,
        timeout_seconds,
    )
    results = athena.get_query_results(QueryExecutionId=execution_id)
    return int(results["ResultSet"]["Rows"][1]["Data"][0]["VarCharValue"])


def rename_table(glue, database, old_name, new_name):
    table = glue.get_table(DatabaseName=database, Name=old_name)["Table"]
    allowed_fields = {
        "Description",
        "LastAccessTime",
        "LastAnalyzedTime",
        "Name",
        "Owner",
        "Parameters",
        "PartitionKeys",
        "Retention",
        "StorageDescriptor",
        "TableType",
        "TargetTable",
        "ViewDefinition",
        "ViewExpandedText",
        "ViewOriginalText",
    }
    table_input = {key: value for key, value in table.items() if key in allowed_fields}
    table_input["Name"] = new_name
    glue.update_table(
        DatabaseName=database,
        Name=old_name,
        TableInput=table_input,
        SkipArchive=True,
    )


def ensure_table_tags(lakeformation, account_id, database, table, stage):
    resource = {"Table": {"CatalogId": account_id, "DatabaseName": database, "Name": table}}
    existing = lakeformation.get_resource_lftags(Resource=resource).get("LFTagsOnTable", [])
    existing_keys = {tag["TagKey"] for tag in existing}
    for tag_key, databases in TAGGED_TABLES.items():
        base_database = database.removeprefix(f"{SERVICE}_{stage}_")
        if table not in databases.get(base_database, ()):
            continue
        if tag_key not in existing_keys:
            lakeformation.add_lf_tags_to_resource(
                Resource=resource,
                LFTags=[{
                    "CatalogId": account_id,
                    "TagKey": tag_key,
                    "TagValues": [LF_TAG_VALUE],
                }],
            )


def ensure_named_role_grant(lakeformation, account_id, database, table, stage):
    if base_database_for(database, stage) != "inventory":
        return
    lakeformation.grant_permissions(
        Principal={
            "DataLakePrincipalIdentifier": (
                f"arn:aws:iam::{account_id}:role/qcom-datalake-poc-{stage}-team-a-role"
            )
        },
        Resource={"Table": {"CatalogId": account_id, "DatabaseName": database, "Name": table}},
        Permissions=["SELECT", "INSERT", "DELETE", "ALTER", "DESCRIBE"],
    )


def migrate(args):
    raise RuntimeError(
        "Iceberg migration is disabled: the catalog swap and CloudFormation lifecycle are not validated."
    )
    session = boto3.Session(region_name=args.region)
    sts = session.client("sts")
    glue = session.client("glue")
    athena = session.client("athena")
    lakeformation = session.client("lakeformation")
    account_id = sts.get_caller_identity()["Account"]
    catalog_id = account_id
    prepared = []

    for base_database, tables in TABLES.items():
        database = f"{SERVICE}_{args.stage}_{base_database}"
        for table in tables:
            staging_name = f"{table}_iceberg_migration"
            legacy_name = f"{table}_parquet_legacy"
            source = get_table_or_none(glue, database, table)
            staging = get_table_or_none(glue, database, staging_name)
            legacy = get_table_or_none(glue, database, legacy_name)

            if legacy and source and not staging:
                ensure_table_tags(lakeformation, account_id, database, table, args.stage)
                ensure_named_role_grant(lakeformation, account_id, database, table, args.stage)
                print(f"Already migrated: {database}.{table}")
                continue
            if legacy and not source and staging:
                prepared.append((database, table, staging_name, legacy_name, False, legacy_name))
                continue
            if not source or not staging or legacy:
                raise RuntimeError(
                    f"Unexpected table state for {database}.{table}; "
                    f"source={bool(source)}, staging={bool(staging)}, legacy={bool(legacy)}"
                )
            prepared.append((database, table, staging_name, legacy_name, True, table))

    timeout_seconds = args.timeout_minutes * 60
    for database, table, staging_name, legacy_name, copy_needed, source_name in prepared:
        source_count = query_count(athena, database, source_name, args.workgroup, timeout_seconds)
        staging_count = query_count(athena, database, staging_name, args.workgroup, timeout_seconds)
        if staging_count == source_count:
            copy_needed = False
        elif staging_count != 0:
            raise RuntimeError(
                f"Staging table {database}.{staging_name} has {staging_count} rows, "
                f"but source has {source_count}; inspect it before continuing."
            )
        if copy_needed:
            run_query(
                athena,
                f"INSERT INTO {quote_identifier(database)}.{quote_identifier(staging_name)} "
                f"SELECT * FROM {quote_identifier(database)}.{quote_identifier(source_name)}",
                args.workgroup,
                timeout_seconds,
            )
        copied_count = query_count(athena, database, staging_name, args.workgroup, timeout_seconds)
        if copied_count != source_count:
            raise RuntimeError(
                f"Row-count mismatch for {database}.{table}: "
                f"source={source_count}, Iceberg={copied_count}. No catalog swap was started by this run."
            )

    for database, table, staging_name, legacy_name, _, _ in prepared:
        source = get_table_or_none(glue, database, table)
        staging = get_table_or_none(glue, database, staging_name)
        legacy = get_table_or_none(glue, database, legacy_name)
        if source and staging and not legacy:
            rename_table(glue, database, table, legacy_name)
        if not get_table_or_none(glue, database, table):
            if not get_table_or_none(glue, database, staging_name):
                raise RuntimeError(f"Neither {database}.{table} nor its migration table exists.")
            try:
                rename_table(glue, database, staging_name, table)
            except Exception:
                if get_table_or_none(glue, database, legacy_name):
                    rename_table(glue, database, legacy_name, table)
                raise
        ensure_table_tags(lakeformation, catalog_id, database, table, args.stage)
        ensure_named_role_grant(lakeformation, catalog_id, database, table, args.stage)
        print(f"Swapped {database}.{table}; legacy Parquet table retained as {legacy_name}")


def base_database_for(database, stage):
    prefix = f"{SERVICE}_{stage}_"
    if not database.startswith(prefix):
        raise ValueError(f"Unexpected database name: {database}")
    return database[len(prefix):]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", required=True, help="CDK stage, for example dev")
    parser.add_argument("--region", required=True, help="AWS region, for example ca-central-1")
    parser.add_argument("--workgroup", required=True, help="Athena workgroup for migration queries")
    parser.add_argument("--timeout-minutes", type=int, default=60)
    args = parser.parse_args()
    migrate(args)


if __name__ == "__main__":
    main()
