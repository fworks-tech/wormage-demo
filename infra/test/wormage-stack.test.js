'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cdk = require('aws-cdk-lib');
const { Match, Template } = require('aws-cdk-lib/assertions');
const { WormageStack } = require('../dist/lib/wormage-stack');

function template(props = {}) {
  return Template.fromStack(new WormageStack(new cdk.App(), 'TestStack', {
    authSecretValue: 'test-secret-value-padded-to-32-chars-min',
    ...props,
  }));
}

const alarmTemplate = template({ alarmEmail: 'ops@example.com' });

test('bug reports are enabled by default, debug logs stay disabled', () => {
  const stack = template();
  const parameters = Object.entries(stack.findResources('AWS::SSM::Parameter'));
  const defaults = Object.fromEntries(parameters.map(([, parameter]) => [parameter.Properties.Name, parameter.Properties.Value]));

  assert.equal(defaults['/wormage/debug-logs/enabled'], 'false');
  assert.equal(defaults['/wormage/bug-reports/enabled'], 'true');

  const handler = Object.values(stack.findResources('AWS::Lambda::Function')).find(
    (f) => f.Properties && f.Properties.Environment && f.Properties.Environment.Variables && f.Properties.Environment.Variables.TABLE_NAME,
  );
  const env = handler.Properties.Environment.Variables;
  const logicalId = (name) => parameters.find(([, parameter]) => parameter.Properties.Name === name)[0];
  assert.deepStrictEqual(env.DEBUG_LOGS_ENABLED, { 'Fn::GetAtt': [logicalId('/wormage/debug-logs/enabled'), 'Value'] });
  assert.deepStrictEqual(env.BUG_REPORTS_ENABLED, { 'Fn::GetAtt': [logicalId('/wormage/bug-reports/enabled'), 'Value'] });
});

test('GitHub issue creation is disabled by default and scoped to the Wormage repository', () => {
  const stack = template();
  const parameters = Object.entries(stack.findResources('AWS::SSM::Parameter'));
  const defaults = Object.fromEntries(parameters.map(([, parameter]) => [parameter.Properties.Name, parameter.Properties.Value]));
  assert.equal(defaults['/wormage/github-issues/enabled'], 'false');

  const handler = Object.values(stack.findResources('AWS::Lambda::Function')).find(
    (f) => f.Properties && f.Properties.Environment && f.Properties.Environment.Variables && f.Properties.Environment.Variables.TABLE_NAME,
  );
  const env = handler.Properties.Environment.Variables;
  const logicalId = parameters.find(([, parameter]) => parameter.Properties.Name === '/wormage/github-issues/enabled')[0];
  assert.deepStrictEqual(env.GITHUB_ISSUES_ENABLED, { 'Fn::GetAtt': [logicalId, 'Value'] });
  assert.equal(env.GITHUB_ISSUE_REPO, 'fworks-tech/wormage-demo');
  assert.equal(env.GITHUB_TOKEN_PARAM, '/wormage/github/bug-report-token');
});

test('GitHub issue creation can be enabled explicitly with enforced anonymous auth', () => {
  const stack = template({ githubIssuesEnabled: true, authMode: 'enforce' });
  const parameter = Object.values(stack.findResources('AWS::SSM::Parameter'))
    .find((entry) => entry.Properties.Name === '/wormage/github-issues/enabled');
  assert.equal(parameter.Properties.Value, 'true');
});

test('GitHub issue creation fails closed without enforced anonymous auth', () => {
  assert.throws(
    () => template({ githubIssuesEnabled: true, authMode: 'observe' }),
    /githubIssuesEnabled requires authMode=enforce/,
  );
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

test('anonymous auth reads an out-of-band SSM SecureString and observe mode', () => {
  const handler = Object.values(alarmTemplate.findResources('AWS::Lambda::Function'))[0];
  assert.equal(handler.Properties.Environment.Variables.AUTH_MODE, 'observe');
  // Published via `aws ssm put-parameter` in deploy-infra.yml, never in CFN:
  // CDK StringParameter no longer supports SecureString and CFN rejects it.
  assert.equal(handler.Properties.Environment.Variables.AUTH_SECRET_PARAM, '/wormage/auth/secret');
  const params = alarmTemplate.findResources('AWS::SSM::Parameter');
  for (const [, parameter] of Object.entries(params)) {
    assert.notEqual(parameter.Properties.Name, '/wormage/auth/secret');
  }
  const policies = alarmTemplate.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).flatMap((policy) => policy.Properties.PolicyDocument.Statement || []);
  const getStatements = statements.filter((statement) => {
    const action = statement.Action;
    const list = Array.isArray(action) ? action : [action];
    return statement.Effect === 'Allow' && list.includes('ssm:GetParameter');
  });
  assert.ok(getStatements.length > 0, 'missing ssm:GetParameter allow statement');
  assert.ok(getStatements.some((statement) => JSON.stringify(statement.Resource).includes('wormage/auth/secret')), 'ssm:GetParameter must stay scoped to wormage/auth/secret');
});

test('stack synthesis fails closed without an auth secret value', () => {
  assert.throws(() => template({ authSecretValue: undefined }), /authSecretValue is required/);
});

test('auth session route has its own throttle and stage dependency', () => {
  const routes = Object.entries(alarmTemplate.findResources('AWS::ApiGatewayV2::Route'));
  const stage = Object.values(alarmTemplate.findResources('AWS::ApiGatewayV2::Stage'))[0];
  const route = routes.find(([, resource]) => resource.Properties.RouteKey === 'POST /api/auth/session');

  assert.ok(route);
  assert.deepEqual(stage.Properties.RouteSettings['POST /api/auth/session'], { ThrottlingBurstLimit: 5, ThrottlingRateLimit: 2 });
  assert.ok(stage.DependsOn.includes(route[0]));
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
    'GET /api/matches/online/{code}': { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
    'GET /api/matches/online/{code}/replay': { ThrottlingBurstLimit: 2, ThrottlingRateLimit: 1 },
  };

  assert.deepEqual(stage.Properties.DefaultRouteSettings, { ThrottlingBurstLimit: 20, ThrottlingRateLimit: 10 });
  for (const [routeKey, settings] of Object.entries(expected)) {
    assert.deepEqual(stage.Properties.RouteSettings[routeKey], settings);
    const route = routes.find(([, resource]) => resource.Properties.RouteKey === routeKey);
    assert.ok(route, `missing route ${routeKey}`);
    assert.ok(stage.DependsOn.includes(route[0]), `stage must depend on ${routeKey}`);
  }
});

test('monthly budget caps spend at USD 10 with actual and forecast alerts', () => {
  const budgets = alarmTemplate.findResources('AWS::Budgets::Budget');
  const budget = Object.values(budgets)[0];
  assert.ok(budget, 'missing monthly budget');
  assert.equal(budget.Properties.Budget.BudgetLimit.Amount, 10);
  assert.equal(budget.Properties.Budget.BudgetLimit.Unit, 'USD');
  assert.equal(budget.Properties.Budget.TimeUnit, 'MONTHLY');
  assert.equal(budget.Properties.Budget.BudgetType, 'COST');

  const notifications = budget.Properties.NotificationsWithSubscribers;
  const topics = alarmTemplate.findResources('AWS::SNS::Topic');
  const topicLogicalId = Object.keys(topics)[0];
  const expected = [
    { type: 'ACTUAL', threshold: 50 },
    { type: 'ACTUAL', threshold: 80 },
    { type: 'ACTUAL', threshold: 100 },
    { type: 'FORECASTED', threshold: 100 },
  ];
  assert.equal(notifications.length, expected.length);
  for (const { type, threshold } of expected) {
    const entry = notifications.find(
      (item) => item.Notification.NotificationType === type && item.Notification.Threshold === threshold,
    );
    assert.ok(entry, `missing ${type} ${threshold}% notification`);
    assert.equal(entry.Notification.ComparisonOperator, 'GREATER_THAN');
    assert.equal(entry.Notification.ThresholdType, 'PERCENTAGE');
    assert.deepStrictEqual(entry.Subscribers, [{ SubscriptionType: 'SNS', Address: { Ref: topicLogicalId } }]);
  }
});

test('lambda has no reserved concurrency until the quota supports it', () => {
  const handler = Object.values(template().findResources('AWS::Lambda::Function'))[0];
  assert.equal(handler.Properties.ReservedConcurrentExecutions, undefined);
});

test('reserved concurrency is applied when explicitly configured', () => {
  const configured = template({ lambdaReservedConcurrency: 10 });
  const handler = Object.values(configured.findResources('AWS::Lambda::Function'))[0];
  assert.equal(handler.Properties.ReservedConcurrentExecutions, 10);
});

test('monthly budget limit is configurable', () => {
  const configured = template({ monthlyBudgetLimitUsd: 20 });
  const budget = Object.values(configured.findResources('AWS::Budgets::Budget'))[0];
  assert.equal(budget.Properties.Budget.BudgetLimit.Amount, 20);
});

test('lambda ships without X-Ray tracing for zero-cost posture', () => {
  const handler = Object.values(template().findResources('AWS::Lambda::Function'))[0];
  assert.equal(handler.Properties.TracingConfig, undefined);
});

test('online data expires via TTL while the table resists deletion', () => {
  alarmTemplate.hasResourceProperties('AWS::DynamoDB::Table', {
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    DeletionProtectionEnabled: true,
  });
});

test('retention is scoped by prefix with multipart abort', () => {
  const bucket = Object.values(alarmTemplate.findResources('AWS::S3::Bucket'))[0];
  const rules = bucket.Properties.LifecycleConfiguration.Rules;
  const byId = Object.fromEntries(rules.map((rule) => [rule.Id, rule]));
  assert.deepStrictEqual(
    rules.map((rule) => rule.Id).sort(),
    ['abort-incomplete-multipart', 'expire-bug-reports', 'expire-debug-logs'],
  );
  assert.equal(byId['expire-debug-logs'].Status, 'Enabled');
  assert.equal(byId['expire-debug-logs'].Prefix, 'debug-logs/');
  assert.equal(byId['expire-debug-logs'].ExpirationInDays, 7);
  assert.equal(byId['expire-bug-reports'].Status, 'Enabled');
  assert.equal(byId['expire-bug-reports'].Prefix, 'bug-reports/');
  assert.equal(byId['expire-bug-reports'].ExpirationInDays, 30);
  assert.equal(byId['abort-incomplete-multipart'].Status, 'Enabled');
  assert.equal(byId['abort-incomplete-multipart'].AbortIncompleteMultipartUpload.DaysAfterInitiation, 1);
});
