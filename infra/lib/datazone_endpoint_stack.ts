import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

interface DataZoneEndpointStackProps extends cdk.StackProps {
  vpcId: string;
  subnetIds: string[];
  projectSecurityGroupIds: string[];
  s3RouteTableId: string;
}

export class DataZoneEndpointStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DataZoneEndpointStackProps) {
    super(scope, id, props);

    if (props.subnetIds.length === 0 || props.projectSecurityGroupIds.length === 0) {
      throw new Error('DataZone endpoint requires subnets and project security groups.');
    }

    const securityGroup = new ec2.CfnSecurityGroup(this, 'EndpointSecurityGroup', {
      vpcId: props.vpcId,
      groupDescription: 'Allow SMUS projects to reach the DataZone private endpoint',
      securityGroupIngress: props.projectSecurityGroupIds.map((groupId) => ({
        ipProtocol: 'tcp',
        fromPort: 443,
        toPort: 443,
        sourceSecurityGroupId: groupId,
      })),
    });

    const endpoint = new ec2.CfnVPCEndpoint(this, 'DataZoneEndpoint', {
      vpcId: props.vpcId,
      vpcEndpointType: 'Interface',
      serviceName: `com.amazonaws.${this.region}.datazone`,
      subnetIds: props.subnetIds,
      securityGroupIds: [securityGroup.attrGroupId],
      privateDnsEnabled: true,
    });

    const athenaEndpoint = new ec2.CfnVPCEndpoint(this, 'AthenaEndpoint', {
      vpcId: props.vpcId,
      vpcEndpointType: 'Interface',
      serviceName: `com.amazonaws.${this.region}.athena`,
      subnetIds: props.subnetIds,
      securityGroupIds: [securityGroup.attrGroupId],
      privateDnsEnabled: true,
    });

    const glueEndpoint = new ec2.CfnVPCEndpoint(this, 'GlueEndpoint', {
      vpcId: props.vpcId,
      vpcEndpointType: 'Interface',
      serviceName: `com.amazonaws.${this.region}.glue`,
      subnetIds: props.subnetIds,
      securityGroupIds: [securityGroup.attrGroupId],
      privateDnsEnabled: true,
    });

    const glueSessionsEndpoint = new ec2.CfnVPCEndpoint(this, 'GlueSessionsEndpoint', {
      vpcId: props.vpcId,
      vpcEndpointType: 'Interface',
      serviceName: `com.amazonaws.${this.region}.glue.sessions`,
      subnetIds: props.subnetIds,
      securityGroupIds: [securityGroup.attrGroupId],
      privateDnsEnabled: true,
    });

    const stsEndpoint = new ec2.CfnVPCEndpoint(this, 'StsEndpoint', {
      vpcId: props.vpcId,
      vpcEndpointType: 'Interface',
      serviceName: `com.amazonaws.${this.region}.sts`,
      subnetIds: props.subnetIds,
      securityGroupIds: [securityGroup.attrGroupId],
      privateDnsEnabled: true,
    });

    const lakeFormationEndpoint = new ec2.CfnVPCEndpoint(this, 'LakeFormationEndpoint', {
      vpcId: props.vpcId,
      vpcEndpointType: 'Interface',
      serviceName: `com.amazonaws.${this.region}.lakeformation`,
      subnetIds: props.subnetIds,
      securityGroupIds: [securityGroup.attrGroupId],
      privateDnsEnabled: true,
    });

    const s3Endpoint = new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
      vpcId: props.vpcId,
      vpcEndpointType: 'Gateway',
      serviceName: `com.amazonaws.${this.region}.s3`,
      routeTableIds: [props.s3RouteTableId],
    });

    new cdk.CfnOutput(this, 'EndpointId', { value: endpoint.ref });
    new cdk.CfnOutput(this, 'AthenaEndpointId', { value: athenaEndpoint.ref });
    new cdk.CfnOutput(this, 'GlueEndpointId', { value: glueEndpoint.ref });
    new cdk.CfnOutput(this, 'GlueSessionsEndpointId', { value: glueSessionsEndpoint.ref });
    new cdk.CfnOutput(this, 'StsEndpointId', { value: stsEndpoint.ref });
    new cdk.CfnOutput(this, 'LakeFormationEndpointId', { value: lakeFormationEndpoint.ref });
    new cdk.CfnOutput(this, 'S3GatewayEndpointId', { value: s3Endpoint.ref });
  }
}
