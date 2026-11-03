#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SERVICE_NAME } from '../config';
import { IamStack } from '../lib/iam_stack';
import { LakeFormationStack } from '../lib/lakeformation_stack';

const app = new cdk.App();
const stage: string = app.node.tryGetContext('stage') ?? 'dev';
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const iamStack = new IamStack(app, `${SERVICE_NAME}-${stage}-iam`, { env, stage });
const lfStack = new LakeFormationStack(app, `${SERVICE_NAME}-${stage}-lakeformation`, {
  env,
  stage,
  dataLakeRole: iamStack.dataLakeRole,
});
lfStack.addDependency(iamStack);
