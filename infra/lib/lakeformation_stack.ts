import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ACCESS_TEAMS, DATABASES, LF_TAG_VALUE, databaseName, databaseTagKey, resourceName, tableTagKey } from '../config';

export interface LakeFormationStackProps extends cdk.StackProps {
  stage: string;
  dataLakeRole: iam.IRole;
  // The SMUS Tooling environment calls Lake Formation with these roles, so they must be admins
  extraAdminRoles?: iam.IRole[];
  // Identity Center groups granted the tags of their teams directly (needs the one-time LF Identity Center connection)
  groupGrants?: { groupId: string; teamKeys: string[] }[];
}

export class LakeFormationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LakeFormationStackProps) {
    super(scope, id, props);
    const { stage, dataLakeRole } = props;

    const bucket = new s3.Bucket(this, 'DataLakeBucket', {
      bucketName: resourceName(stage, `${this.account}-${this.region}`),
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // Separate policy in this stack avoids an IAM <-> Lake Formation stack dependency cycle
    new iam.Policy(this, 'DataLakeBucketAccess', {
      roles: [dataLakeRole],
      statements: [
        new iam.PolicyStatement({
          actions: ['s3:GetObject*', 's3:PutObject*', 's3:DeleteObject*', 's3:ListBucket', 's3:GetBucketLocation'],
          resources: [bucket.bucketArn, bucket.arnForObjects('*')],
        }),
      ],
    });

    const settings = new lakeformation.CfnDataLakeSettings(this, 'DataLakeSettings', {
      admins: [
        { dataLakePrincipalIdentifier: dataLakeRole.roleArn },
        ...(props.extraAdminRoles ?? []).map((r) => ({ dataLakePrincipalIdentifier: r.roleArn })),
        // CDK's CloudFormation execution role creates the Glue databases, so it must be an LF admin
        {
          dataLakePrincipalIdentifier: `arn:aws:iam::${this.account}:role/cdk-hnb659fds-cfn-exec-role-${this.account}-${this.region}`,
        },
      ],
    });

    const resource = new lakeformation.CfnResource(this, 'DataLakeLocation', {
      resourceArn: bucket.bucketArn,
      useServiceLinkedRole: false,
      roleArn: dataLakeRole.roleArn,
    });
    resource.node.addDependency(settings);

    // Per team: one tag key marking its tables and one marking the databases it can see
    const tagsByKey = new Map<string, lakeformation.CfnTag>();
    for (const team of ACCESS_TEAMS) {
      for (const tagKey of [tableTagKey(team.key), databaseTagKey(team.key)]) {
        const tag = new lakeformation.CfnTag(this, `Tag-${tagKey}`, {
          catalogId: this.account,
          tagKey,
          tagValues: [LF_TAG_VALUE],
        });
        tag.node.addDependency(settings);
        tagsByKey.set(tagKey, tag);
      }
    }

    for (const g of props.groupGrants ?? []) {
      for (const teamKey of g.teamKeys) {
        for (const [resourceType, tagKey, permissions] of [
          ['DATABASE', databaseTagKey(teamKey), ['DESCRIBE']],
          ['TABLE', tableTagKey(teamKey), ['SELECT', 'DESCRIBE']],
        ] as const) {
          const grant = new lakeformation.CfnPrincipalPermissions(
            this,
            `GroupGrant-${g.groupId}-${teamKey}-${resourceType}`,
            {
              principal: { dataLakePrincipalIdentifier: `arn:aws:identitystore:::group/${g.groupId}` },
              resource: {
                lfTagPolicy: {
                  catalogId: this.account,
                  resourceType,
                  expression: [{ tagKey, tagValues: [LF_TAG_VALUE] }],
                },
              },
              permissions: [...permissions],
              permissionsWithGrantOption: [],
            },
          );
          grant.node.addDependency(tagsByKey.get(tagKey)!);
        }
      }
    }

    for (const db of DATABASES) {
      const dbName = databaseName(stage, db.name);
      const database = new glue.CfnDatabase(this, `Db-${db.name}`, {
        catalogId: this.account,
        databaseInput: { name: dbName, locationUri: bucket.s3UrlForObject(db.name) },
      });

      database.node.addDependency(settings, resource);

      for (const team of ACCESS_TEAMS.filter((t) => (t.tables[db.name] ?? []).length > 0)) {
        const key = databaseTagKey(team.key);
        const assoc = new lakeformation.CfnTagAssociation(this, `DbTagAssoc-${db.name}-${team.key}`, {
          resource: { database: { catalogId: this.account, name: dbName } },
          lfTags: [{ catalogId: this.account, tagKey: key, tagValues: [LF_TAG_VALUE] }],
        });
        assoc.node.addDependency(database, tagsByKey.get(key)!, settings);
      }

      // Grant the role full database access in Lake Formation
      const dbPerm = new lakeformation.CfnPermissions(this, `DbPerm-${db.name}`, {
        dataLakePrincipal: { dataLakePrincipalIdentifier: dataLakeRole.roleArn },
        resource: { databaseResource: { catalogId: this.account, name: dbName } },
        permissions: ['ALL'],
      });
      dbPerm.node.addDependency(database, settings);

      for (const table of db.tables) {
        const glueTable = new glue.CfnTable(this, `Table-${db.name}-${table.name}`, {
          catalogId: this.account,
          databaseName: dbName,
          tableInput: {
            name: table.name,
            tableType: 'EXTERNAL_TABLE',
            parameters: { classification: 'parquet' },
            storageDescriptor: {
              columns: table.columns,
              location: bucket.s3UrlForObject(`${db.name}/${table.name}/`),
              inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
              outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
              serdeInfo: {
                serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
              },
            },
          },
        });
        glueTable.addDependency(database);

        for (const team of ACCESS_TEAMS.filter((t) => (t.tables[db.name] ?? []).includes(table.name))) {
          const key = tableTagKey(team.key);
          const assoc = new lakeformation.CfnTagAssociation(
            this,
            `TableTagAssoc-${db.name}-${table.name}-${team.key}`,
            {
              resource: {
                table: { catalogId: this.account, databaseName: dbName, name: table.name },
              },
              lfTags: [{ catalogId: this.account, tagKey: key, tagValues: [LF_TAG_VALUE] }],
            },
          );
          assoc.node.addDependency(glueTable, tagsByKey.get(key)!, settings);
        }

        const tablePerm = new lakeformation.CfnPermissions(this, `TablePerm-${db.name}-${table.name}`, {
          dataLakePrincipal: { dataLakePrincipalIdentifier: dataLakeRole.roleArn },
          resource: {
            tableResource: { catalogId: this.account, databaseName: dbName, name: table.name },
          },
          permissions: ['ALL'],
        });
        tablePerm.node.addDependency(glueTable, settings);
      }
    }
  }
}
