import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { IamStack } from '../lib/iam_stack';
import { LakeFormationStack } from '../lib/lakeformation_stack';
import { QueryApiStack } from '../lib/query_api_stack';
import { SmusStack } from '../lib/smus_stack';
import { DataZoneEndpointStack } from '../lib/datazone_endpoint_stack';

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
  Template.fromStack(iamStack).hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'qcom-datalake-poc-dev-datalake-role',
    AssumeRolePolicyDocument: {
      Statement: Match.arrayWith([
        {
          Effect: 'Allow',
          Principal: { Service: 'lakeformation.amazonaws.com' },
          Action: 'sts:SetContext',
        },
      ]),
    },
  });
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

test('grants each group only its mapped scenario tables', () => {
    const app = new cdk.App();
    const env = { account: '111111111111', region: 'us-east-1' };
    const iamStack = new IamStack(app, 'group-iam', { env, stage: 'dev' });
    const stack = new LakeFormationStack(app, 'group-lf', {
      env,
      stage: 'dev',
      dataLakeRole: iamStack.dataLakeRole,
      tableMode: 'iceberg',
      groupGrants: [
        { groupId: 'group-a', teamKeys: ['team-a'] },
        { groupId: 'group-b', teamKeys: ['team-b'] },
      ],
      hybridProjectRoleNames: ['project-a', 'project-b'],
      glueIdentityProjectRoleNames: ['project-a'],
    });
    const template = Template.fromStack(stack);
    const permissions = Object.values(template.findResources('AWS::LakeFormation::Permissions'));
    for (const [group, expected] of [
      ['group-a', ['customers', 'products']],
      ['group-b', ['orders', 'products', 'stock_levels']],
    ] as const) {
      for (const scenario of ['scenario2_lf_named', 'scenario3_hybrid']) {
        const tableGrants = permissions.filter((resource) =>
          resource.Properties.DataLakePrincipal.DataLakePrincipalIdentifier === `arn:aws:identitystore:::group/${group}` &&
          resource.Properties.Resource.TableResource?.DatabaseName === `qcom_datalake_poc_dev_${scenario}`,
        );
        expect(tableGrants.map((resource) => resource.Properties.Resource.TableResource.Name).sort())
          .toEqual([...expected].sort());
        for (const grant of tableGrants) {
          expect(grant.Properties.Permissions).toEqual(['SELECT', 'INSERT', 'DELETE', 'ALTER', 'DESCRIBE']);
        }
      }
    }

    const associations = Object.values(template.findResources('AWS::LakeFormation::TagAssociation'));
    for (const [team, expected] of [
      ['team-a', ['customers', 'products']],
      ['team-b', ['orders', 'products', 'stock_levels']],
    ] as const) {
      const tableTags = associations.filter((resource) =>
        resource.Properties.Resource.Table?.DatabaseName === 'qcom_datalake_poc_dev_scenario1_lf_tag' &&
        resource.Properties.LFTags.some((tag: { TagKey: string }) => tag.TagKey === `access-${team}`),
      );
      expect(tableTags.map((resource) => resource.Properties.Resource.Table.Name).sort())
        .toEqual([...expected].sort());
      template.hasResourceProperties('AWS::LakeFormation::TagAssociation', {
        Resource: { Database: { Name: 'qcom_datalake_poc_dev_scenario1_lf_tag' } },
        LFTags: Match.arrayWith([Match.objectLike({ TagKey: `db-${team}`, TagValues: ['allowed'] })]),
      });
    }
    template.resourceCountIs('Custom::AWS', 15);
    template.hasResourceProperties('AWS::IAM::Policy', {
      Roles: ['project-a', 'project-b'],
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: ['glue:UpdateTable'] })]) },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      Roles: ['project-a'],
      PolicyDocument: {
        Statement: [{
          Effect: 'Allow',
          Action: ['glue:GetGlueIdentityCenterConfiguration'],
          Resource: '*',
        }],
      },
    });
});

test('creates private service endpoints and the S3 gateway route', () => {
  const app = new cdk.App();
  const stack = new DataZoneEndpointStack(app, 'endpoint', {
    env: { account: '111111111111', region: 'us-east-1' },
    vpcId: 'vpc-123',
    subnetIds: ['subnet-1', 'subnet-2'],
    projectSecurityGroupIds: ['sg-123', 'sg-456'],
    s3RouteTableId: 'rtb-123',
  });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcId: 'vpc-123',
    VpcEndpointType: 'Interface',
    ServiceName: 'com.amazonaws.us-east-1.datazone',
    PrivateDnsEnabled: true,
    SubnetIds: ['subnet-1', 'subnet-2'],
  });
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 7);
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcId: 'vpc-123',
    VpcEndpointType: 'Interface',
    ServiceName: 'com.amazonaws.us-east-1.athena',
    PrivateDnsEnabled: true,
    SubnetIds: ['subnet-1', 'subnet-2'],
  });
  for (const service of ['glue', 'glue.sessions', 'sts', 'lakeformation']) {
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcId: 'vpc-123',
      VpcEndpointType: 'Interface',
      ServiceName: `com.amazonaws.us-east-1.${service}`,
      PrivateDnsEnabled: true,
      SubnetIds: ['subnet-1', 'subnet-2'],
      SecurityGroupIds: [{ 'Fn::GetAtt': ['EndpointSecurityGroup', 'GroupId'] }],
    });
  }
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcId: 'vpc-123',
    VpcEndpointType: 'Gateway',
    ServiceName: 'com.amazonaws.us-east-1.s3',
    RouteTableIds: ['rtb-123'],
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: [
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupId: 'sg-123' },
      { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, SourceSecurityGroupId: 'sg-456' },
    ],
  });
});
