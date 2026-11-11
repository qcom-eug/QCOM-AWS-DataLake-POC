import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { resourceName } from '../config';

export interface IamStackProps extends cdk.StackProps {
  stage: string;
}

export class IamStack extends cdk.Stack {
  public readonly dataLakeRole: iam.Role;
  public readonly smusManageAccessRole: iam.Role;
  public readonly smusProvisioningRole: iam.Role;
  public readonly teamARole: iam.Role;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    // Shared by the SMUS domains; kept here so Lake Formation can list them as admins
    this.smusManageAccessRole = new iam.Role(this, 'SmusManageAccessRole', {
      roleName: resourceName(props.stage, 'smus-manage-access'),
      assumedBy: new iam.ServicePrincipal('datazone.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
        ArnEquals: { 'aws:SourceArn': `arn:${this.partition}:datazone:${this.region}:${this.account}:domain/*` },
      }),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonDataZoneGlueManageAccessRolePolicy'),
      ],
    });

    // POC only: broad permissions so the Tooling blueprint can provision project resources
    this.smusProvisioningRole = new iam.Role(this, 'SmusProvisioningRole', {
      roleName: resourceName(props.stage, 'smus-provisioning'),
      assumedBy: new iam.ServicePrincipal('datazone.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
      }),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess')],
    });

    // Direct (non-tag) Lake Formation grants for this role are set in infra.ts via namedRoleGrants.
    // No S3 permissions: Lake Formation vends the data access to Athena.
    this.teamARole = new iam.Role(this, 'TeamARole', {
      roleName: resourceName(props.stage, 'team-a-role'),
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'Query role with direct Lake Formation grants (see namedRoleGrants in infra.ts)',
    });
    this.teamARole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:GetDatabase',
          'glue:GetDatabases',
          'glue:GetTable',
          'glue:GetTables',
          'glue:GetPartitions',
          'glue:BatchGetPartition',
          'glue:BatchCreatePartition',
          'glue:CreatePartition',
          'glue:UpdatePartition',
          'glue:UpdateTable',
          'athena:StartQueryExecution',
          'athena:GetQueryExecution',
          'athena:GetQueryResults',
          'athena:StopQueryExecution',
          'athena:GetWorkGroup',
          'athena:ListWorkGroups',
          'lakeformation:GetDataAccess',
        ],
        resources: ['*'],
      }),
    );

    // Role used by Lake Formation to access registered S3 locations and by analysts for Glue/Athena
    this.dataLakeRole = new iam.Role(this, 'DataLakeRole', {
      roleName: resourceName(props.stage, 'datalake-role'),
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lakeformation.amazonaws.com'),
        new iam.ServicePrincipal('glue.amazonaws.com'),
      ),
      description: 'Data lake access role for Lake Formation POC',
    });

    this.dataLakeRole.assumeRolePolicy!.addStatements(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal('lakeformation.amazonaws.com')],
        actions: ['sts:SetContext'],
      }),
    );

    this.dataLakeRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'glue:GetDatabase',
          'glue:GetDatabases',
          'glue:GetTable',
          'glue:GetTables',
          'glue:GetPartitions',
        ],
        resources: ['*'],
      }),
    );
  }
}
