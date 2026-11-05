#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SERVICE_NAME } from '../config';
import { IamStack } from '../lib/iam_stack';
import { LakeFormationStack } from '../lib/lakeformation_stack';
import { QueryApiStack } from '../lib/query_api_stack';
import { SmusStack } from '../lib/smus_stack';

const app = new cdk.App();
const stage: string = app.node.tryGetContext('stage') ?? 'dev';
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  // Identity Center lives in ca-central-1; override with -c region=... if needed
  region: app.node.tryGetContext('region') ?? 'ca-central-1',
};

const salesGroupId: string = app.node.tryGetContext('salesGroupId') ?? '5c2dd518-e0d1-7066-1ef6-75b0689f1dd5';
const inventoryGroupId: string = app.node.tryGetContext('inventoryGroupId') ?? '8cbd15e8-70b1-7077-4112-371c8c8d9404';
// -c groupGrants=true grants the LF tags to the Identity Center groups instead of the project roles
const groupGrants = String(app.node.tryGetContext('groupGrants')) === 'true';

const iamStack = new IamStack(app, `${SERVICE_NAME}-${stage}-iam`, { env, stage });
const lfStack = new LakeFormationStack(app, `${SERVICE_NAME}-${stage}-lakeformation`, {
  env,
  stage,
  dataLakeRole: iamStack.dataLakeRole,
  extraAdminRoles: [iamStack.smusProvisioningRole, iamStack.smusManageAccessRole],
  groupGrants: groupGrants
    ? [
        { groupId: salesGroupId, teamKeys: ['team-a'] },
        { groupId: inventoryGroupId, teamKeys: ['team-b'] },
      ]
    : undefined,
});
lfStack.addDependency(iamStack);

const queryApiStack = new QueryApiStack(app, `${SERVICE_NAME}-${stage}-query-api`, { env, stage });
queryApiStack.addDependency(lfStack);

// Existing network and optional Identity Center come from context (-c vpcId=... -c subnetIds=a,b,c -c idcInstanceArn=...)
const vpcId: string = app.node.tryGetContext('vpcId') ?? 'vpc-0295386fb257be550';
const subnetIds: string[] = (
  app.node.tryGetContext('subnetIds') ??
  'subnet-03ed5345db3d3e506,subnet-05f0b2052de3d0a82,subnet-01345ef22528edf95'
).split(',');
const smusStack = new SmusStack(app, `${SERVICE_NAME}-${stage}-smus`, {
  env,
  stage,
  vpcId,
  subnetIds,
  manageAccessRole: iamStack.smusManageAccessRole,
  provisioningRole: iamStack.smusProvisioningRole,
});
smusStack.addDependency(lfStack);

// Second domain: IAM Identity Center sign-in with a group as project owner.
// A single domain cannot be both IAM- and Identity Center-based, so the two run side by side.
// Opt in with -c enableIdc=true once Identity Center is usable from this account and region
if (String(app.node.tryGetContext('enableIdc')) === 'true') {
  const idcInstanceArn: string = app.node.tryGetContext('idcInstanceArn') ?? 'arn:aws:sso:::instance/ssoins-88248d0adc9467cc';
  const smusIdcStack = new SmusStack(app, `${SERVICE_NAME}-${stage}-smus-idc`, {
    env,
    stage,
    vpcId,
    subnetIds,
    idcInstanceArn,
    // Each group only reaches the tables tagged for its team, through its own project role
    projectAccess: [
      { key: 'team-a', teamKeys: ['team-a'], groupId: salesGroupId },
      { key: 'team-b', teamKeys: ['team-b'], groupId: inventoryGroupId },
    ],
    nameSuffix: 'idc',
    skipRoleTagGrants: groupGrants,
    // Pass -c createGroupProfiles=false when the group profiles already exist in the domain
    createGroupProfiles: String(app.node.tryGetContext('createGroupProfiles')) !== 'false',
    manageAccessRole: iamStack.smusManageAccessRole,
    provisioningRole: iamStack.smusProvisioningRole,
  });
  smusIdcStack.addDependency(lfStack);
}
