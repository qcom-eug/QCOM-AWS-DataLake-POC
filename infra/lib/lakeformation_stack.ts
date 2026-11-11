import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import {
  ACCESS_SCENARIO_DATABASES,
  ACCESS_TEAMS,
  DATABASES,
  LF_TAG_VALUE,
  SCENARIO_TABLES,
  TableConfig,
  databaseName,
  databaseTagKey,
  resourceName,
  tableTagKey,
} from '../config';

export interface LakeFormationStackProps extends cdk.StackProps {
  stage: string;
  dataLakeRole: iam.IRole;
  // The SMUS Tooling environment calls Lake Formation with these roles, so they must be admins
  extraAdminRoles?: iam.IRole[];
  // Identity Center groups granted the tags of their teams directly (needs the one-time LF Identity Center connection)
  groupGrants?: { groupId: string; teamKeys: string[] }[];
  // IAM roles granted the tags of their teams directly
  roleGrants?: { id: string; role: iam.IRole; teamKeys: string[] }[];
  // IAM roles granted direct (non-tag) grants on the listed tables
  namedRoleGrants?: { id: string; role: iam.IRole; tables: Record<string, string[]> }[];
  // 'parquet' = current read-only tables, 'none' = drop all tables (and their grants), 'iceberg' = updateable tables.
  // CloudFormation cannot convert a table in place, so go parquet -> none -> iceberg in two deploys.
  tableMode?: 'parquet' | 'none' | 'iceberg';
}

const WRITE_TABLE_PERMISSIONS = ['SELECT', 'INSERT', 'DELETE', 'ALTER', 'DESCRIBE'];

const icebergInput = (table: TableConfig, location: string): glue.CfnTable.OpenTableFormatInputProperty => ({
  icebergInput: {
    metadataOperation: 'CREATE',
    version: '2',
    icebergTableInput: {
      location,
      schema: {
        schemaId: 0,
        type: 'struct',
        fields: table.columns.map((column, index) => ({
          id: index + 1,
          name: column.name,
          required: false,
          type: column.type,
        })),
      },
    },
  },
});

export class LakeFormationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: LakeFormationStackProps) {
    super(scope, id, props);
    const { stage, dataLakeRole } = props;
    const tableMode = props.tableMode ?? 'parquet';
    const iceberg = tableMode === 'iceberg';
    const tablesFor = <T>(tables: T[]): T[] => (tableMode === 'none' ? [] : tables);
    const tablePermissions = iceberg ? WRITE_TABLE_PERMISSIONS : ['SELECT', 'DESCRIBE'];

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

    const scenarioOptInRole = new iam.Role(this, 'ScenarioOptInExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'CloudFormation custom-resource role for Lake Formation hybrid opt-in operations',
    });
    scenarioOptInRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'lakeformation:CreateLakeFormationOptIn',
          'lakeformation:DeleteLakeFormationOptIn',
          'glue:GetDatabase',
          'glue:GetTable',
        ],
        resources: ['*'],
      }),
    );

    const settings = new lakeformation.CfnDataLakeSettings(this, 'DataLakeSettings', {
      admins: [
        { dataLakePrincipalIdentifier: dataLakeRole.roleArn },
        { dataLakePrincipalIdentifier: scenarioOptInRole.roleArn },
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

    const tagPrincipals = [
      ...(props.groupGrants ?? []).map((g) => ({
        id: g.groupId,
        arn: `arn:aws:identitystore:::group/${g.groupId}`,
        teamKeys: g.teamKeys,
      })),
      ...(props.roleGrants ?? []).map((r) => ({
        id: r.id,
        arn: r.role.roleArn,
        teamKeys: r.teamKeys,
      })),
    ];

    for (const g of tagPrincipals) {
      for (const teamKey of g.teamKeys) {
        for (const [resourceType, tagKey, permissions] of [
          ['DATABASE', databaseTagKey(teamKey), ['DESCRIBE']],
          ['TABLE', tableTagKey(teamKey), tablePermissions],
        ] as const) {
          const grant = new lakeformation.CfnPrincipalPermissions(
            this,
            `TagGrant-${g.id}-${teamKey}-${resourceType}`,
            {
              principal: { dataLakePrincipalIdentifier: g.arn },
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

    for (const r of props.namedRoleGrants ?? []) {
      // Writing data needs access to the registered S3 location as well as INSERT on the table
      const locationGrant = new lakeformation.CfnPermissions(this, `NamedLocationPerm-${r.id}`, {
        dataLakePrincipal: { dataLakePrincipalIdentifier: r.role.roleArn },
        resource: { dataLocationResource: { catalogId: this.account, s3Resource: bucket.bucketArn } },
        permissions: ['DATA_LOCATION_ACCESS'],
      });
      locationGrant.node.addDependency(resource, settings);
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

      for (const table of tablesFor(db.tables)) {
        const glueTable = new glue.CfnTable(
          this,
          `Table-${db.name}-${table.name}`,
          iceberg
            ? {
                catalogId: this.account,
                databaseName: dbName,
                name: table.name,
                openTableFormatInput: icebergInput(table, bucket.s3UrlForObject(`${db.name}/${table.name}/`)),
              }
            : {
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
              },
        );
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

        // Roles listed in namedRoleGrants get direct grants on exactly their listed tables (no LF tags)
        for (const r of (props.namedRoleGrants ?? []).filter((n) => (n.tables[db.name] ?? []).includes(table.name))) {
          const namedTablePerm = new lakeformation.CfnPermissions(this, `NamedTablePerm-${r.id}-${db.name}-${table.name}`, {
            dataLakePrincipal: { dataLakePrincipalIdentifier: r.role.roleArn },
            resource: {
              tableResource: { catalogId: this.account, databaseName: dbName, name: table.name },
            },
            permissions: iceberg ? WRITE_TABLE_PERMISSIONS : ['SELECT', 'INSERT', 'ALTER', 'DESCRIBE'],
          });
          namedTablePerm.node.addDependency(glueTable, settings);
        }
      }

      for (const r of (props.namedRoleGrants ?? []).filter((n) => (n.tables[db.name] ?? []).length > 0)) {
        const namedDbPerm = new lakeformation.CfnPermissions(this, `NamedDbPerm-${r.id}-${db.name}`, {
          dataLakePrincipal: { dataLakePrincipalIdentifier: r.role.roleArn },
          resource: { databaseResource: { catalogId: this.account, name: dbName } },
          permissions: ['DESCRIBE'],
        });
        namedDbPerm.node.addDependency(database, settings);
      }
    }

    const scenarioRoles = {
      tagged: new iam.Role(this, 'ScenarioLfTagRole', {
        roleName: resourceName(stage, 'scenario1-lf-tag-role'),
        assumedBy: new iam.AccountRootPrincipal(),
        description: 'Scenario 1: full Lake Formation access controlled by LF-Tags',
      }),
      named: new iam.Role(this, 'ScenarioLfNamedRole', {
        roleName: resourceName(stage, 'scenario2-lf-named-role'),
        assumedBy: new iam.AccountRootPrincipal(),
        description: 'Scenario 2: full Lake Formation access controlled by named-resource grants',
      }),
      hybridLf: new iam.Role(this, 'ScenarioHybridLfRole', {
        roleName: resourceName(stage, 'scenario3-hybrid-lf-role'),
        assumedBy: new iam.AccountRootPrincipal(),
        description: 'Scenario 3: opted-in hybrid access controlled by Lake Formation',
      }),
      hybridIam: new iam.Role(this, 'ScenarioHybridIamRole', {
        roleName: resourceName(stage, 'scenario3-hybrid-iam-role'),
        assumedBy: new iam.AccountRootPrincipal(),
        description: 'Scenario 3: non-opted-in hybrid access controlled by IAM',
      }),
    };

    const catalogReadActions = [
      'glue:GetDatabase',
      'glue:GetDatabases',
      'glue:GetTable',
      'glue:GetTables',
      'glue:GetPartitions',
    ];
    for (const role of [scenarioRoles.tagged, scenarioRoles.named, scenarioRoles.hybridLf, scenarioRoles.hybridIam]) {
      role.addToPolicy(new iam.PolicyStatement({ actions: catalogReadActions, resources: ['*'] }));
    }
    for (const role of [scenarioRoles.tagged, scenarioRoles.named, scenarioRoles.hybridLf]) {
      role.addToPolicy(new iam.PolicyStatement({ actions: ['lakeformation:GetDataAccess'], resources: ['*'] }));
      if (iceberg) {
        // Iceberg commits update the Glue table pointer; this is IAM-only and carries no data access
        role.addToPolicy(new iam.PolicyStatement({ actions: ['glue:UpdateTable'], resources: ['*'] }));
      }
    }

    for (const scenario of ACCESS_SCENARIO_DATABASES) {
      const scenarioBucket = new s3.Bucket(this, `ScenarioBucket-${scenario.key}`, {
        bucketName: resourceName(stage, `${scenario.key}-${this.account}-${this.region}`),
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      });
      new iam.Policy(this, `ScenarioDataLakeBucketAccess-${scenario.key}`, {
        roles: [dataLakeRole],
        statements: [
          new iam.PolicyStatement({
            actions: [
              's3:GetObject*',
              's3:PutObject*',
              's3:DeleteObject*',
              's3:ListBucket',
              's3:GetBucketLocation',
            ],
            resources: [scenarioBucket.bucketArn, scenarioBucket.arnForObjects('*')],
          }),
        ],
      });

      const isHybrid = scenario.key === 'hybrid';
      const scenarioLocation = new lakeformation.CfnResource(this, `ScenarioLocation-${scenario.key}`, {
        resourceArn: scenarioBucket.bucketArn,
        useServiceLinkedRole: false,
        roleArn: dataLakeRole.roleArn,
        hybridAccessEnabled: isHybrid,
      });
      scenarioLocation.node.addDependency(settings);

      const scenarioDbName = databaseName(stage, scenario.name);
      const scenarioDb = new glue.CfnDatabase(this, `ScenarioDb-${scenario.key}`, {
        catalogId: this.account,
        databaseInput: {
          name: scenarioDbName,
          locationUri: scenarioBucket.s3UrlForObject(''),
        },
      });
      scenarioDb.node.addDependency(settings, scenarioLocation);

      const tableResources: { name: string; resource: glue.CfnTable }[] = [];
      for (const table of tablesFor(SCENARIO_TABLES)) {
        const tableResource = new glue.CfnTable(
          this,
          `ScenarioTable-${scenario.key}-${table.name}`,
          iceberg
            ? {
                catalogId: this.account,
                databaseName: scenarioDbName,
                name: table.name,
                openTableFormatInput: icebergInput(table, scenarioBucket.s3UrlForObject(`${table.name}/`)),
              }
            : {
                catalogId: this.account,
                databaseName: scenarioDbName,
                tableInput: {
                  name: table.name,
                  tableType: 'EXTERNAL_TABLE',
                  parameters: { classification: 'parquet' },
                  storageDescriptor: {
                    columns: table.columns,
                    location: scenarioBucket.s3UrlForObject(`${table.name}/`),
                    inputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                    outputFormat: 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                    serdeInfo: {
                      serializationLibrary: 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe',
                    },
                  },
                },
              },
        );
        tableResource.addDependency(scenarioDb);
        tableResources.push({ name: table.name, resource: tableResource });
      }

      if (scenario.key === 'lf-tag') {
        const scenarioTag = new lakeformation.CfnTag(this, 'Scenario1Tag', {
          catalogId: this.account,
          tagKey: 'access-scenario',
          tagValues: ['scenario1'],
        });
        scenarioTag.node.addDependency(settings);
        const tagAssociation = new lakeformation.CfnTagAssociation(this, 'Scenario1DbTagAssociation', {
          resource: { database: { catalogId: this.account, name: scenarioDbName } },
          lfTags: [{ catalogId: this.account, tagKey: 'access-scenario', tagValues: ['scenario1'] }],
        });
        tagAssociation.node.addDependency(scenarioDb, scenarioTag);
        for (const table of tableResources) {
          table.resource.addDependency(tagAssociation);
        }

        for (const [resourceType, permissions] of [
          ['DATABASE', ['DESCRIBE']],
          ['TABLE', tablePermissions],
        ] as const) {
          const tagGrant = new lakeformation.CfnPrincipalPermissions(
            this,
            `Scenario1TagGrant-${resourceType}`,
            {
              principal: { dataLakePrincipalIdentifier: scenarioRoles.tagged.roleArn },
              resource: {
                lfTagPolicy: {
                  catalogId: this.account,
                  resourceType,
                  expression: [{ tagKey: 'access-scenario', tagValues: ['scenario1'] }],
                },
              },
              permissions: [...permissions],
              permissionsWithGrantOption: [],
            },
          );
          tagGrant.node.addDependency(tagAssociation);
        }
      } else if (scenario.key === 'lf-named') {
        const dbGrant = new lakeformation.CfnPermissions(this, 'Scenario2DbGrant', {
          dataLakePrincipal: { dataLakePrincipalIdentifier: scenarioRoles.named.roleArn },
          resource: { databaseResource: { catalogId: this.account, name: scenarioDbName } },
          permissions: ['DESCRIBE'],
        });
        dbGrant.node.addDependency(scenarioDb);

        for (const table of tableResources) {
          const tableGrant = new lakeformation.CfnPermissions(this, `Scenario2TableGrant-${table.name}`, {
            dataLakePrincipal: { dataLakePrincipalIdentifier: scenarioRoles.named.roleArn },
            resource: {
              tableResource: {
                catalogId: this.account,
                databaseName: scenarioDbName,
                name: table.name,
              },
            },
            permissions: tablePermissions,
          });
          tableGrant.node.addDependency(table.resource);
        }
      } else {
        const lfDbGrant = new lakeformation.CfnPermissions(this, 'Scenario3LfDbGrant', {
          dataLakePrincipal: { dataLakePrincipalIdentifier: scenarioRoles.hybridLf.roleArn },
          resource: { databaseResource: { catalogId: this.account, name: scenarioDbName } },
          permissions: ['DESCRIBE'],
        });
        const iamDbGrant = new lakeformation.CfnPermissions(this, 'Scenario3IamAllowedDbGrant', {
          dataLakePrincipal: { dataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
          resource: { databaseResource: { catalogId: this.account, name: scenarioDbName } },
          permissions: ['ALL'],
        });
        lfDbGrant.node.addDependency(scenarioDb);
        iamDbGrant.node.addDependency(scenarioDb);

        const scenario3TableOptIns: cr.AwsCustomResource[] = [];
        for (const table of tableResources) {
          const lfTableGrant = new lakeformation.CfnPermissions(this, `Scenario3LfTableGrant-${table.name}`, {
            dataLakePrincipal: { dataLakePrincipalIdentifier: scenarioRoles.hybridLf.roleArn },
            resource: {
              tableResource: { catalogId: this.account, databaseName: scenarioDbName, name: table.name },
            },
            permissions: tablePermissions,
          });
          const iamTableGrant = new lakeformation.CfnPermissions(
            this,
            `Scenario3IamAllowedTableGrant-${table.name}`,
            {
              dataLakePrincipal: { dataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
              resource: {
                tableResource: { catalogId: this.account, databaseName: scenarioDbName, name: table.name },
              },
              permissions: ['ALL'],
            },
          );
          lfTableGrant.node.addDependency(table.resource);
          iamTableGrant.node.addDependency(table.resource);

          const optIn = new cr.AwsCustomResource(this, `Scenario3TableOptIn-${table.name}`, {
            onCreate: {
              service: 'LakeFormation',
              action: 'CreateLakeFormationOptIn',
              parameters: {
                Principal: { DataLakePrincipalIdentifier: scenarioRoles.hybridLf.roleArn },
                Resource: {
                  Table: { CatalogId: this.account, DatabaseName: scenarioDbName, Name: table.name },
                },
              },
              physicalResourceId: cr.PhysicalResourceId.of(
                `${resourceName(stage, 'scenario3-hybrid-lf-role')}-${scenarioDbName}-${table.name}`,
              ),
            },
            onDelete: {
              service: 'LakeFormation',
              action: 'DeleteLakeFormationOptIn',
              parameters: {
                Principal: { DataLakePrincipalIdentifier: scenarioRoles.hybridLf.roleArn },
                Resource: {
                  Table: { CatalogId: this.account, DatabaseName: scenarioDbName, Name: table.name },
                },
              },
            },
            role: scenarioOptInRole,
            installLatestAwsSdk: true,
          });
          optIn.node.addDependency(settings, lfTableGrant, lfDbGrant, iamTableGrant, iamDbGrant);
          scenario3TableOptIns.push(optIn);
        }

        const dbOptIn = new cr.AwsCustomResource(this, 'Scenario3DatabaseOptIn', {
          onCreate: {
            service: 'LakeFormation',
            action: 'CreateLakeFormationOptIn',
            parameters: {
              Principal: { DataLakePrincipalIdentifier: scenarioRoles.hybridLf.roleArn },
              Resource: { Database: { CatalogId: this.account, Name: scenarioDbName } },
            },
            physicalResourceId: cr.PhysicalResourceId.of(
              `${resourceName(stage, 'scenario3-hybrid-lf-role')}-${scenarioDbName}`,
            ),
          },
          onDelete: {
            service: 'LakeFormation',
            action: 'DeleteLakeFormationOptIn',
            parameters: {
              Principal: { DataLakePrincipalIdentifier: scenarioRoles.hybridLf.roleArn },
              Resource: { Database: { CatalogId: this.account, Name: scenarioDbName } },
            },
          },
          role: scenarioOptInRole,
          installLatestAwsSdk: true,
        });
        dbOptIn.node.addDependency(settings, lfDbGrant, iamDbGrant);
        for (const optIn of scenario3TableOptIns) {
          optIn.node.addDependency(dbOptIn);
        }

        scenarioRoles.hybridIam.addToPolicy(
          new iam.PolicyStatement({
            actions: iceberg
              ? ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:GetBucketLocation']
              : ['s3:GetObject', 's3:GetBucketLocation'],
            resources: [scenarioBucket.arnForObjects('*'), scenarioBucket.bucketArn],
          }),
        );
        if (iceberg) {
          scenarioRoles.hybridIam.addToPolicy(
            new iam.PolicyStatement({ actions: ['glue:UpdateTable'], resources: ['*'] }),
          );
        }
        scenarioRoles.hybridIam.addToPolicy(
          new iam.PolicyStatement({
            actions: ['s3:ListBucket'],
            resources: [scenarioBucket.bucketArn],
          }),
        );
      }

      new cdk.CfnOutput(this, `ScenarioDatabase-${scenario.key}`, { value: scenarioDbName });
      new cdk.CfnOutput(this, `ScenarioBucketName-${scenario.key}`, { value: scenarioBucket.bucketName });
    }

    new cdk.CfnOutput(this, 'Scenario1TaggedRoleArn', { value: scenarioRoles.tagged.roleArn });
    new cdk.CfnOutput(this, 'Scenario2NamedRoleArn', { value: scenarioRoles.named.roleArn });
    new cdk.CfnOutput(this, 'Scenario3HybridLfRoleArn', { value: scenarioRoles.hybridLf.roleArn });
    new cdk.CfnOutput(this, 'Scenario3HybridIamRoleArn', { value: scenarioRoles.hybridIam.roleArn });
  }
}
