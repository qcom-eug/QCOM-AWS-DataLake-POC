import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpIamAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import { Construct } from 'constructs';
import { DATABASES, databaseName, resourceName } from '../config';

export interface QueryApiStackProps extends cdk.StackProps {
  stage: string;
}

export class QueryApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: QueryApiStackProps) {
    super(scope, id, props);
    const { stage } = props;

    const resultsBucket = new s3.Bucket(this, 'AthenaResultsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
    });

    const workgroup = new athena.CfnWorkGroup(this, 'Workgroup', {
      name: resourceName(stage, 'wg'),
      state: 'ENABLED',
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        resultConfiguration: { outputLocation: `s3://${resultsBucket.bucketName}/results/` },
      },
    });

    const allowedTables: Record<string, string[]> = {};
    for (const db of DATABASES) {
      allowedTables[databaseName(stage, db.name)] = db.tables.map((t) => t.name);
    }

    const fn = new lambda.Function(this, 'TableQueryFn', {
      functionName: resourceName(stage, 'table-query'),
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../../service/tableQuery')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ALLOWED_TABLES: JSON.stringify(allowedTables),
        ATHENA_WORKGROUP: workgroup.name,
      },
    });

    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['glue:GetTable', 'glue:GetTables', 'glue:GetDatabase', 'glue:GetPartitions'],
        resources: ['*'],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['athena:StartQueryExecution', 'athena:GetQueryExecution', 'athena:GetQueryResults'],
        resources: [`arn:${this.partition}:athena:${this.region}:${this.account}:workgroup/${workgroup.name}`],
      }),
    );
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['lakeformation:GetDataAccess'], resources: ['*'] }));
    resultsBucket.grantReadWrite(fn);

    // Lake Formation: let the function describe/select every table
    for (const db of DATABASES) {
      const dbName = databaseName(stage, db.name);
      for (const table of db.tables) {
        new lakeformation.CfnPermissions(this, `FnPerm-${db.name}-${table.name}`, {
          dataLakePrincipal: { dataLakePrincipalIdentifier: fn.role!.roleArn },
          resource: {
            tableResource: { catalogId: this.account, databaseName: dbName, name: table.name },
          },
          permissions: ['SELECT', 'DESCRIBE'],
        });
      }
      new lakeformation.CfnPermissions(this, `FnDbPerm-${db.name}`, {
        dataLakePrincipal: { dataLakePrincipalIdentifier: fn.role!.roleArn },
        resource: { databaseResource: { catalogId: this.account, name: dbName } },
        permissions: ['DESCRIBE'],
      });
    }

    // IAM-authenticated so the endpoint is not open to the internet
    const api = new apigw.HttpApi(this, 'Api', {
      apiName: resourceName(stage, 'api'),
      defaultAuthorizer: new HttpIamAuthorizer(),
    });
    api.addRoutes({
      path: '/tables',
      methods: [apigw.HttpMethod.GET, apigw.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('TableQueryIntegration', fn),
    });

    new cdk.CfnOutput(this, 'ApiUrl', { value: `${api.apiEndpoint}/tables` });
  }
}
