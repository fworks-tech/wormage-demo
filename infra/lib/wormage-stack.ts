import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Wormage AWS foundation (M3). Skeleton: resources are added per sub-issue
 * (#131 HTTP API + Lambda, #132 DynamoDB, #133 custom domain, #136 CORS).
 */
export class WormageStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Placeholder: a CloudFormation output so `cdk synth` produces a template.
    new cdk.CfnOutput(this, 'StackName', {
      value: this.stackName,
      description: 'Wormage foundation stack name',
    });
  }
}
