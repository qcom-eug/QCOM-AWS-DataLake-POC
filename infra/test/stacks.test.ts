import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { IamStack } from '../lib/iam_stack';
import { LakeFormationStack } from '../lib/lakeformation_stack';
import { QueryApiStack } from '../lib/query_api_stack';
import { SmusStack } from '../lib/smus_stack';

test('creates core and three access-scenario databases', () => {
  const app = new cdk.App();
  const env = { account: '111111111111', region: 'us-east-1' };
  const iamStack = new IamStack(app, 'iam', { env, stage: 'dev' });
  const lf = new LakeFormationStack(app, 'lf', { env, stage: 'dev', dataLakeRole: iamStack.dataLakeRole });

  const apiStack = new QueryApiStack(app, 'api', { env, stage: 'dev' });
  const smus = new SmusStack(app, 'smus', {
    env,
    stage: 'dev',
    vpcId: 'vpc-1',
    subnetIds: ['subnet-1'],
    manageAccessRole: iamStack.smusManageAccessRole,
    provisioningRole: iamStack.smusProvisioningRole,
  });

  Template.fromStack(iamStack).resourceCountIs('AWS::IAM::Role', 4);
  const t = Template.fromStack(lf);
  t.resourceCountIs('AWS::Glue::Database', 5);
  t.resourceCountIs('AWS::Glue::Table', 16);
  t.resourceCountIs('AWS::LakeFormation::Resource', 4);
  t.hasResourceProperties('AWS::LakeFormation::Resource', {
    HybridAccessEnabled: true,
  });
  t.hasResourceProperties('AWS::LakeFormation::Permissions', {
    DataLakePrincipal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
    Permissions: ['ALL'],
  });
  t.resourceCountIs('AWS::LakeFormation::PrincipalPermissions', 2);

  const api = Template.fromStack(apiStack);
  api.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'qcom-datalake-poc-dev-table-query',
    Runtime: 'nodejs20.x',
  });
  api.resourceCountIs('AWS::ApiGatewayV2::Api', 1);

  const s = Template.fromStack(smus);
  s.resourceCountIs('AWS::DataZone::Domain', 1);
  s.resourceCountIs('AWS::DataZone::Project', 1);
  s.resourceCountIs('AWS::DataZone::ProjectProfile', 1);
  s.resourceCountIs('AWS::DataZone::EnvironmentBlueprintConfiguration', 1);
});

test.each([
  { tableMode: 'none' as const, tables: 0, format: false },
  { tableMode: 'iceberg' as const, tables: 16, format: true },
])('tableMode $tableMode', ({ tableMode, tables, format }) => {
  const app = new cdk.App();
  const env = { account: '111111111111', region: 'us-east-1' };
  const iamStack = new IamStack(app, 'tm-iam', { env, stage: 'dev' });
  const lf = new LakeFormationStack(app, 'tm-lf', { env, stage: 'dev', dataLakeRole: iamStack.dataLakeRole, tableMode });
  const t = Template.fromStack(lf);
  t.resourceCountIs('AWS::Glue::Database', 5);
  t.resourceCountIs('AWS::Glue::Table', tables);
  if (format) {
    t.allResourcesProperties('AWS::Glue::Table', {
      OpenTableFormatInput: { IcebergInput: { MetadataOperation: 'CREATE', Version: '2' } },
    });
    t.hasResourceProperties('AWS::LakeFormation::Permissions', {
      Permissions: ['SELECT', 'INSERT', 'DELETE', 'ALTER', 'DESCRIBE'],
    });
  } else {
    t.resourceCountIs('AWS::LakeFormation::TagAssociation', 5);
  }
});
