import * as cdk from 'aws-cdk-lib';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DATABASES, databaseName, resourceName } from '../config';

export interface LakeFormationStackProps extends cdk.StackProps {
  stage: string;
  dataLakeRole: iam.IRole;
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
      admins: [{ dataLakePrincipalIdentifier: dataLakeRole.roleArn }],
    });

    const resource = new lakeformation.CfnResource(this, 'DataLakeLocation', {
      resourceArn: bucket.bucketArn,
      useServiceLinkedRole: false,
      roleArn: dataLakeRole.roleArn,
    });
    resource.node.addDependency(settings);

    for (const db of DATABASES) {
      const dbName = databaseName(stage, db.name);
      const database = new glue.CfnDatabase(this, `Db-${db.name}`, {
        catalogId: this.account,
        databaseInput: { name: dbName, locationUri: bucket.s3UrlForObject(db.name) },
      });

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
