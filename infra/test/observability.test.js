'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { WormageStack } = require('../dist/lib/wormage-stack');

function template() {
  return Template.fromStack(new WormageStack(new cdk.App(), 'TestStack', {
    authSecretValue: 'test-secret-value-padded-to-32-chars-min',
  }));
}

test('HTTP API access logs are retained for 30 days without sensitive fields', () => {
  const stack = template();
  const groups = Object.entries(stack.findResources('AWS::Logs::LogGroup'));
  const accessLog = groups.find(([, group]) => group.Properties.LogGroupName === '/aws/apigateway/wormage');
  assert.ok(accessLog, 'missing HTTP API access log group');
  assert.equal(accessLog[1].Properties.RetentionInDays, 30);

  const stage = Object.values(stack.findResources('AWS::ApiGatewayV2::Stage'))[0];
  assert.ok(stage.Properties.AccessLogSettings, 'missing stage access log settings');
  assert.deepEqual(stage.Properties.AccessLogSettings.DestinationArn, { 'Fn::GetAtt': [accessLog[0], 'Arn'] });

  const format = stage.Properties.AccessLogSettings.Format;
  assert.deepEqual(JSON.parse(format), {
    requestId: '$context.requestId',
    routeKey: '$context.routeKey',
    httpMethod: '$context.httpMethod',
    status: '$context.status',
    responseLatency: '$context.responseLatency',
    sourceIp: '$context.identity.sourceIp',
    responseLength: '$context.responseLength',
  });
  for (const forbidden of ['authorization', 'header', 'body', 'screenshot']) {
    assert.ok(!format.toLowerCase().includes(forbidden), `access log must not include ${forbidden}`);
  }
});

test('dashboard covers Lambda, API, DynamoDB and application signals', () => {
  const stack = template();
  const dashboards = Object.values(stack.findResources('AWS::CloudWatch::Dashboard'));
  assert.equal(dashboards.length, 1);
  const dashboardBody = dashboards[0].Properties.DashboardBody;
  const rendered = typeof dashboardBody === 'string'
    ? dashboardBody
    : dashboardBody['Fn::Join'][1].map((part) => typeof part === 'string' ? part : 'TOKEN').join('');
  const body = JSON.parse(rendered);
  const metrics = body.widgets
    .flatMap((widget) => widget.properties.metrics || [])
    .filter((metric) => typeof metric[0] === 'string');
  const namespaces = new Set(metrics.map((metric) => metric[0]));
  assert.deepEqual([...namespaces].sort(), ['AWS/ApiGateway', 'AWS/DynamoDB', 'AWS/Lambda', 'Wormage/Application']);

  const metricNames = new Set(metrics.map((metric) => metric[1]));
  const expectedMetrics = [
    'Invocations', 'Errors', 'Throttles', 'Duration', 'Count', '4xx', '5xx', 'Latency', 'IntegrationLatency',
    'ConsumedReadCapacityUnits', 'ConsumedWriteCapacityUnits', 'ApplicationErrors', 'BugReportCount',
  ];
  for (const name of expectedMetrics) {
    assert.ok(metricNames.has(name), `dashboard missing metric ${name}`);
  }
});

test('cost tags are applied to taggable backend resources', () => {
  const stack = template();
  const expected = { Project: 'wormage', Environment: 'prod', ManagedBy: 'CDK', CostCenter: 'wormage' };
  const taggableTypes = [
    'AWS::Lambda::Function',
    'AWS::ApiGatewayV2::Api',
    'AWS::DynamoDB::Table',
    'AWS::S3::Bucket',
    'AWS::SNS::Topic',
    'AWS::Logs::LogGroup',
    'AWS::CloudWatch::Alarm',
    'AWS::CloudWatch::Dashboard',
  ];

  for (const type of taggableTypes) {
    const resources = Object.values(stack.findResources(type));
    assert.ok(resources.length > 0, `missing taggable resource ${type}`);
    for (const resource of resources) {
      const tags = Array.isArray(resource.Properties.Tags)
        ? Object.fromEntries(resource.Properties.Tags.map(({ Key, Value }) => [Key, Value]))
        : resource.Properties.Tags;
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(tags[key], value, `${type} tag ${key}`);
      }
    }
  }
});
