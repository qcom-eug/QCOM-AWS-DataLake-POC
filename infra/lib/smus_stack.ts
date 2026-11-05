import * as cdk from 'aws-cdk-lib';
import * as datazone from 'aws-cdk-lib/aws-datazone';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lakeformation from 'aws-cdk-lib/aws-lakeformation';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { ACCESS_TEAMS, LF_TAG_VALUE, databaseTagKey, tableTagKey, resourceName as baseResourceName } from '../config';

export interface ProjectAccess {
  // 'default' keeps the original resource names; other keys are appended to them
  key: string;
  // ACCESS_TEAMS keys whose LF-Tags this project's role is granted
  teamKeys: string[];
  // Identity Center group that owns the project (IDC domains only)
  groupId?: string;
}

export interface SmusStackProps extends cdk.StackProps {
  stage: string;
  vpcId: string;
  subnetIds: string[];
  // When set the domain uses IAM Identity Center sign-in, otherwise IAM-based access
  idcInstanceArn?: string;
  // Identity Center group made owner of the single default project (IDC domains only)
  idcGroupId?: string;
  // One project per entry, each limited to its databases; defaults to one project with all databases
  projectAccess?: ProjectAccess[];
  // Skip the per-project-role tag grants when groups are granted the tags directly
  skipRoleTagGrants?: boolean;
  // Set false when the group profiles already exist in the domain (default true)
  createGroupProfiles?: boolean;
  // Keeps resource names unique when several SMUS stacks are deployed in one account
  nameSuffix?: string;
  // Created in the IAM stack so they can be Lake Formation admins before SMUS deploys
  manageAccessRole: iam.IRole;
  provisioningRole: iam.IRole;
}

export class SmusStack extends cdk.Stack {
  public readonly domain: datazone.CfnDomain;
  public readonly projectRoles: iam.Role[] = [];

  constructor(scope: Construct, id: string, props: SmusStackProps) {
    super(scope, id, props);
    const { stage, idcInstanceArn, idcGroupId, nameSuffix } = props;
    const resourceName = (st: string, name: string) =>
      baseResourceName(st, nameSuffix ? `${name}-${nameSuffix}` : name);

    const datazoneTrust = (extra: iam.IPrincipal[] = []) =>
      new iam.CompositePrincipal(
        new iam.ServicePrincipal('datazone.amazonaws.com').withConditions({
          StringEquals: { 'aws:SourceAccount': this.account },
        }),
        ...extra,
      );

    const domainExecutionRole = new iam.Role(this, 'DomainExecutionRole', {
      roleName: resourceName(stage, 'smus-domain-execution'),
      assumedBy: new iam.ServicePrincipal('datazone.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
      }),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/SageMakerStudioDomainExecutionRolePolicy'),
      ],
    });
    domainExecutionRole.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('datazone.amazonaws.com')],
        actions: ['sts:TagSession', 'sts:SetContext'],
      }),
    );

    const serviceRole = new iam.Role(this, 'DomainServiceRole', {
      roleName: resourceName(stage, 'smus-domain-service'),
      assumedBy: new iam.ServicePrincipal('datazone.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
      }),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/SageMakerStudioDomainServiceRolePolicy'),
      ],
    });

    this.domain = new datazone.CfnDomain(this, 'Domain', {
      name: resourceName(stage, 'smus'),
      description: 'SageMaker Unified Studio domain for the data lake POC',
      domainVersion: 'V2',
      domainExecutionRole: domainExecutionRole.roleArn,
      serviceRole: serviceRole.roleArn,
      singleSignOn: idcInstanceArn
        ? { type: 'IAM_IDC', userAssignment: 'MANUAL', idcInstanceArn }
        : { type: 'DISABLED' },
    });

    // V2 domains create projects from a profile, which needs the Tooling blueprint enabled first
    const toolingBucket = new s3.Bucket(this, 'ToolingBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const manageAccessRole = props.manageAccessRole;
    const provisioningRole = props.provisioningRole;

    const tooling = new datazone.CfnEnvironmentBlueprintConfiguration(this, 'ToolingBlueprint', {
      domainIdentifier: this.domain.attrId,
      environmentBlueprintIdentifier: 'Tooling',
      enabledRegions: [this.region],
      manageAccessRoleArn: manageAccessRole.roleArn,
      provisioningRoleArn: provisioningRole.roleArn,
      regionalParameters: [
        {
          region: this.region,
          parameters: {
            S3Location: `s3://${toolingBucket.bucketName}`,
            Subnets: props.subnetIds.join(','),
            VpcId: props.vpcId,
          },
        },
      ],
    });

    const profile = new datazone.CfnProjectProfile(this, 'ProjectProfile', {
      name: resourceName(stage, 'profile'),
      description: 'Basic project profile for the data lake POC',
      domainIdentifier: this.domain.attrId,
      domainUnitIdentifier: this.domain.attrRootDomainUnitId,
      status: 'ENABLED',
      environmentConfigurations: [
        {
          name: 'Tooling',
          environmentBlueprintId: tooling.attrEnvironmentBlueprintId,
          description: 'Configuration for the Tooling',
          deploymentMode: 'ON_CREATE',
          deploymentOrder: 0,
          awsAccount: { awsAccountId: this.account },
          awsRegion: { regionName: this.region },
        },
      ],
    });

    const grant = new datazone.CfnPolicyGrant(this, 'CreateProjectGrant', {
      domainIdentifier: this.domain.attrId,
      entityIdentifier: this.domain.attrRootDomainUnitId,
      entityType: 'DOMAIN_UNIT',
      policyType: 'CREATE_PROJECT_FROM_PROJECT_PROFILE',
      principal: { user: { allUsersGrantFilter: {} } },
      detail: {
        createProjectFromProjectProfile: {
          includeChildDomainUnits: true,
          projectProfiles: [profile.attrId],
        },
      },
    });

    const blueprintGrant = new datazone.CfnPolicyGrant(this, 'ToolingBlueprintGrant', {
      domainIdentifier: this.domain.attrId,
      entityIdentifier: `${this.account}:${tooling.attrEnvironmentBlueprintId}`,
      entityType: 'ENVIRONMENT_BLUEPRINT_CONFIGURATION',
      policyType: 'CREATE_ENVIRONMENT_FROM_BLUEPRINT',
      principal: {
        project: {
          projectDesignation: 'CONTRIBUTOR',
          projectGrantFilter: {
            domainUnitFilter: {
              domainUnit: this.domain.attrRootDomainUnitId,
              includeChildDomainUnits: true,
            },
          },
        },
      },
      detail: { createEnvironmentFromBlueprint: {} },
    });

    // One project per access entry. Each project role only gets Lake Formation tag grants for its
    // teams, and only the entry's Identity Center group is a member of the project.
    const accessEntries: ProjectAccess[] = props.projectAccess ?? [
      { key: 'default', teamKeys: ACCESS_TEAMS.map((t) => t.key), groupId: idcGroupId },
    ];

    for (const entry of accessEntries) {
      // The default entry keeps the original construct IDs so existing deployments are not replaced
      const cid = (base: string) => (entry.key === 'default' ? base : `${base}-${entry.key}`);
      const nm = (base: string) => (entry.key === 'default' ? base : `${base}-${entry.key}`);

      const projectRole = new iam.Role(this, cid('ProjectRole'), {
        roleName: resourceName(stage, nm('smus-project')),
        assumedBy: datazoneTrust([
          new iam.ServicePrincipal('sagemaker.amazonaws.com'),
          new iam.ServicePrincipal('glue.amazonaws.com'),
          new iam.ServicePrincipal('athena.amazonaws.com'),
        ]),
      });
      projectRole.addToPolicy(
        new iam.PolicyStatement({
          actions: [
            'glue:Get*',
            'glue:BatchGet*',
            'athena:StartQueryExecution',
            'athena:GetQuery*',
            'athena:StopQueryExecution',
            'athena:ListWorkGroups',
            'lakeformation:GetDataAccess',
          ],
          resources: ['*'],
        }),
      );
      this.projectRoles.push(projectRole);

      const project = new datazone.CfnProject(this, cid('Project'), {
        domainIdentifier: this.domain.attrId,
        domainUnitId: this.domain.attrRootDomainUnitId,
        name: resourceName(stage, nm('project')),
        description: `Project with access to LF-Tag teams: ${entry.teamKeys.join(', ')}`,
        projectProfileId: profile.attrId,
        projectExecutionRole: projectRole.roleArn,
      });
      project.addDependency(grant);
      project.addDependency(blueprintGrant);
      project.addDependency(profile);

      if (idcInstanceArn && entry.groupId) {
        // MANUAL user assignment: the group needs an assigned profile before it can join a project
        const groupProfile =
          props.createGroupProfiles === false
            ? undefined
            : new datazone.CfnGroupProfile(this, cid('GroupProfile'), {
                domainIdentifier: this.domain.attrId,
                groupIdentifier: entry.groupId,
                status: 'ASSIGNED',
              });
        const membership = new datazone.CfnProjectMembership(this, cid('GroupMembership'), {
          domainIdentifier: this.domain.attrId,
          projectIdentifier: project.attrId,
          designation: 'PROJECT_OWNER',
          member: { groupIdentifier: entry.groupId },
        });
        if (groupProfile) membership.addDependency(groupProfile);
      }

      // Tag-based access: one grant per team, matching the tags on that team's tables and databases
      for (const teamKey of props.skipRoleTagGrants ? [] : entry.teamKeys) {
        const tagGrant = (
          resourceType: 'DATABASE' | 'TABLE',
          tagKey: string,
          permissions: string[],
        ) =>
          new lakeformation.CfnPrincipalPermissions(this, `${cid('TagGrant')}-${teamKey}-${resourceType}`, {
            principal: { dataLakePrincipalIdentifier: projectRole.roleArn },
            resource: {
              lfTagPolicy: {
                catalogId: this.account,
                resourceType,
                expression: [{ tagKey, tagValues: [LF_TAG_VALUE] }],
              },
            },
            permissions,
            permissionsWithGrantOption: [],
          });
        tagGrant('DATABASE', databaseTagKey(teamKey), ['DESCRIBE']);
        tagGrant('TABLE', tableTagKey(teamKey), ['SELECT', 'DESCRIBE']);
      }
    }

    new cdk.CfnOutput(this, 'DomainId', { value: this.domain.attrId });
    new cdk.CfnOutput(this, 'PortalUrl', { value: this.domain.attrPortalUrl });
  }
}
