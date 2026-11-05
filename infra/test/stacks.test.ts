import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { IamStack } from '../lib/iam_stack';
import { LakeFormationStack } from '../lib/lakeformation_stack';
import { QueryApiStack } from '../lib/query_api_stack';
import { SmusStack } from '../lib/smus_stack';

test('creates role, 2 databases and 4 tables', () => {
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

  Template.fromStack(iamStack).resourceCountIs('AWS::IAM::Role', 3);
  const t = Template.fromStack(lf);
  t.resourceCountIs('AWS::Glue::Database', 2);
  t.resourceCountIs('AWS::Glue::Table', 4);

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
