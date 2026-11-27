#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { WormageStack } from '../lib/wormage-stack';

const app = new cdk.App();
new WormageStack(app, 'WormageStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  description: 'Wormage AWS foundation (M3): API Gateway, Lambda, DynamoDB.',
  // Prod data guard: stack deletes fail closed alongside RETAIN resources
  // and DynamoDB deletion protection. See RUNBOOK.
  terminationProtection: true,
  hostedZoneId: process.env.WORMAGE_HOSTED_ZONE_ID,
  hostedZoneName: process.env.WORMAGE_HOSTED_ZONE_NAME,
  certificateArn: process.env.WORMAGE_CERTIFICATE_ARN,
  apiDomainName: process.env.WORMAGE_API_DOMAIN,
  corsOrigins: process.env.WORMAGE_CORS_ORIGINS
    ? process.env.WORMAGE_CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined,
  alarmEmail: process.env.WORMAGE_ALARM_EMAIL,
  authMode: process.env.WORMAGE_AUTH_MODE === 'enforce' ? 'enforce' : 'observe',
  authSecretValue: process.env.WORMAGE_AUTH_SECRET,
});
