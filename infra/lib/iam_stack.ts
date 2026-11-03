import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { resourceName } from '../config';

export interface IamStackProps extends cdk.StackProps {
  stage: string;
}

export class IamStack extends cdk.Stack {
  public readonly dataLakeRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamStackProps) {
    super(scope, id, props);

    // Role used by Lake Formation to access registered S3 locations and by analysts for Glue/Athena
    this.dataLakeRole = new iam.Role(this, 'DataLakeRole', {
      roleName: resourceName(props.stage, 'datalake-role'),
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lakeformation.amazonaws.com'),
        new iam.ServicePrincipal('glue.amazonaws.com'),
      ),
      description: 'Data lake access role for Lake Formation POC',
    });

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
