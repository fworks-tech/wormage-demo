'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cdk = require('aws-cdk-lib');
const { Match, Template } = require('aws-cdk-lib/assertions');
const { WormageStack } = require('../dist/lib/wormage-stack');

function template(props = {}) {
  return Template.fromStack(new WormageStack(new cdk.App(), 'TestStack', props));
}

const alarmTemplate = template({ alarmEmail: 'ops@example.com' });

test('telemetry uploads are disabled by default', () => {
  const stack = template();
  const parameters = Object.entries(stack.findResources('AWS::SSM::Parameter'));
  const defaults = Object.fromEntries(parameters.map(([, parameter]) => [parameter.Properties.Name, parameter.Properties.Value]));

  assert.equal(defaults['/wormage/debug-logs/enabled'], 'false');
  assert.equal(defaults['/wormage/bug-reports/enabled'], 'false');

  const handler = Object.values(stack.findResources('AWS::Lambda::Function')).find(
    (f) => f.Properties && f.Properties.Environment && f.Properties.Environment.Variables && f.Properties.Environment.Variables.TABLE_NAME,
  );
  const env = handler.Properties.Environment.Variables;
  const logicalId = (name) => parameters.find(([, parameter]) => parameter.Properties.Name === name)[0];
  assert.deepStrictEqual(env.DEBUG_LOGS_ENABLED, { 'Fn::GetAtt': [logicalId('/wormage/debug-logs/enabled'), 'Value'] });
  assert.deepStrictEqual(env.BUG_REPORTS_ENABLED, { 'Fn::GetAtt': [logicalId('/wormage/bug-reports/enabled'), 'Value'] });
});

test('alarm topic has an email subscription when configured', () => {
  alarmTemplate.hasResourceProperties('AWS::SNS::Subscription', {
    Protocol: 'email',
    Endpoint: 'ops@example.com',
    TopicArn: Match.anyValue(),
  });
});

test('DynamoDB alarm measures table throttles', () => {
  alarmTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmDescription: 'DynamoDB throttled requests',
    Threshold: 1,
    Metrics: Match.arrayWith([Match.objectLike({
      MetricStat: Match.objectLike({
        Metric: Match.objectLike({ MetricName: 'ThrottledRequests', Namespace: 'AWS/DynamoDB' }),
      }),
    })]),
  });
});

test('application errors and bug reports have metric filters and alarms', () => {
  alarmTemplate.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '{ $.level = "error" }',
    MetricTransformations: Match.arrayWith([{
      MetricNamespace: 'Wormage/Application',
      MetricName: 'ApplicationErrors',
      MetricValue: '1',
      DefaultValue: 0,
    }]),
  });
  alarmTemplate.hasResourceProperties('AWS::Logs::MetricFilter', {
    FilterPattern: '{ $.type = "bug-report" }',
    MetricTransformations: Match.arrayWith([{
      MetricNamespace: 'Wormage/Application',
      MetricName: 'BugReportCount',
      MetricValue: '1',
      DefaultValue: 0,
    }]),
  });
  alarmTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'Wormage/Application',
    MetricName: 'ApplicationErrors',
    Threshold: 1,
    EvaluationPeriods: 1,
  });
  alarmTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
    Namespace: 'Wormage/Application',
    MetricName: 'BugReportCount',
    Threshold: 20,
    EvaluationPeriods: 1,
    Period: 3600,
    ComparisonOperator: 'GreaterThanThreshold',
  });
});

test('alarms notify the alarm topic', () => {
  const topics = alarmTemplate.findResources('AWS::SNS::Topic');
  const topicLogicalId = Object.keys(topics)[0];
  const alarms = alarmTemplate.findResources('AWS::CloudWatch::Alarm');
  assert.ok(Object.keys(alarms).length >= 6);
  for (const [, alarm] of Object.entries(alarms)) {
    assert.deepStrictEqual(alarm.Properties.AlarmActions, [{ Ref: topicLogicalId }]);
  }
});

test('no email subscription without an alarm address', () => {
  const plain = template();
  assert.deepStrictEqual(plain.findResources('AWS::SNS::Subscription'), {});
});

test('API 5xx alarm triggers after two errors', () => {
  alarmTemplate.hasResourceProperties('AWS::CloudWatch::Alarm', {
    MetricName: '5xx',
    Threshold: 2,
    EvaluationPeriods: 1,
  });
});

test('write routes have isolated throttles and explicit stage dependencies', () => {
  const routes = Object.entries(alarmTemplate.findResources('AWS::ApiGatewayV2::Route'));
  const stage = Object.values(alarmTemplate.findResources('AWS::ApiGatewayV2::Stage'))[0];
  const expected = {
    'POST /api/debug-logs': { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 },
    'POST /api/bug-reports': { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
    'POST /api/matches': { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
    'POST /api/matches/online': { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
    'POST /api/matches/online/{code}/join': { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
    'POST /api/matches/online/{code}/action': { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
    'POST /api/matches/online/{code}/forfeit': { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
  };

  assert.deepEqual(stage.Properties.DefaultRouteSettings, { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 });
  for (const [routeKey, settings] of Object.entries(expected)) {
    assert.deepEqual(stage.Properties.RouteSettings[routeKey], settings);
    const route = routes.find(([, resource]) => resource.Properties.RouteKey === routeKey);
    assert.ok(route, `missing route ${routeKey}`);
    assert.ok(stage.DependsOn.includes(route[0]), `stage must depend on ${routeKey}`);
  }
});
