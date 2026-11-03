import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { IamStack } from '../lib/iam_stack';
import { LakeFormationStack } from '../lib/lakeformation_stack';

test('creates role, 2 databases and 4 tables', () => {
  const app = new cdk.App();
  const env = { account: '111111111111', region: 'us-east-1' };
  const iamStack = new IamStack(app, 'iam', { env, stage: 'dev' });
  const lf = new LakeFormationStack(app, 'lf', { env, stage: 'dev', dataLakeRole: iamStack.dataLakeRole });

  Template.fromStack(iamStack).resourceCountIs('AWS::IAM::Role', 1);
  const t = Template.fromStack(lf);
  t.resourceCountIs('AWS::Glue::Database', 2);
  t.resourceCountIs('AWS::Glue::Table', 4);
});
