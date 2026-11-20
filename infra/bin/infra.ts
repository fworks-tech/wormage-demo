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
});
