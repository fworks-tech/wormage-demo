'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { WormageStack } = require('../dist/lib/wormage-stack');

function template(props = {}) {
  return Template.fromStack(new WormageStack(new cdk.App(), 'TestStack', {
    authSecretValue: 'test-secret-value-padded-to-32-chars-min',
    ...props,
  }));
}

const asArray = (value) => Array.isArray(value) ? value : [value];
const actions = (statement) => asArray(statement.Action);
const allowStatements = (stack) => {
  const statements = Object.values(stack.findResources('AWS::IAM::Policy'))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement || [])
    .filter((statement) => statement.Effect === 'Allow');
  for (const statement of statements) {
    assert.ok(!actions(statement).includes('*'), 'Lambda role must not grant wildcard actions');
  }
  return statements;
};
const serviceActions = (statements, service) => [...new Set(statements
  .flatMap(actions)
  .filter((action) => action.startsWith(`${service}:`)))].sort();
const assertSameResources = (actual, expected) => assert.deepEqual(
  asArray(actual).map((resource) => JSON.stringify(resource)).sort(),
  expected.map((resource) => JSON.stringify(resource)).sort(),
);

test('Lambda DynamoDB access is limited to used actions, the table and both GSIs', () => {
  const stack = template();
  const statements = allowStatements(stack);
  const expectedActions = [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:Query',
    'dynamodb:TransactWriteItems',
  ].sort();
  assert.deepEqual(serviceActions(statements, 'dynamodb'), expectedActions);

  const [tableId] = Object.keys(stack.findResources('AWS::DynamoDB::Table'));
  const tableArn = { 'Fn::GetAtt': [tableId, 'Arn'] };
  const indexArn = (name) => ({ 'Fn::Join': ['', [tableArn, `/index/${name}`]] });
  const expectedResources = [tableArn, indexArn('LeaderboardIndex'), indexArn('PlayerIndex')];
  const dynamodbStatements = statements.filter((entry) => actions(entry).some((action) => action.startsWith('dynamodb:')));
  assert.ok(dynamodbStatements.length > 0, 'missing DynamoDB allow statement');
  for (const statement of dynamodbStatements) {
    assertSameResources(statement.Resource, expectedResources);
  }
});

test('Lambda S3 writes are prefix-scoped and deletes are limited to bug reports', () => {
  const stack = template();
  const statements = allowStatements(stack);
  assert.deepEqual(serviceActions(statements, 's3'), ['s3:DeleteObject', 's3:PutObject']);

  const [bucketId] = Object.keys(stack.findResources('AWS::S3::Bucket'));
  const bucketArn = { 'Fn::GetAtt': [bucketId, 'Arn'] };
  const objectArn = (prefix) => ({ 'Fn::Join': ['', [bucketArn, `/${prefix}`]] });

  const puts = statements.filter((entry) => actions(entry).includes('s3:PutObject'));
  assert.ok(puts.length > 0, 'missing S3 PutObject allow statement');
  for (const put of puts) {
    assertSameResources(put.Resource, [objectArn('debug-logs/*'), objectArn('bug-reports/*')]);
  }

  const removes = statements.filter((entry) => actions(entry).includes('s3:DeleteObject'));
  assert.ok(removes.length > 0, 'missing S3 DeleteObject allow statement');
  for (const remove of removes) {
    assertSameResources(remove.Resource, [objectArn('bug-reports/*')]);
  }
});

const ssmResource = (name) => ({
  'Fn::Join': ['', [
    'arn:',
    { Ref: 'AWS::Partition' },
    ':ssm:',
    { Ref: 'AWS::Region' },
    ':',
    { Ref: 'AWS::AccountId' },
    `:parameter/${name}`,
  ]],
});

test('Lambda SSM access excludes the GitHub token while issue creation is disabled', () => {
  const statements = allowStatements(template());
  assert.deepEqual(serviceActions(statements, 'ssm'), ['ssm:GetParameter']);
  const ssmStatements = statements.filter((entry) => actions(entry).some((action) => action.startsWith('ssm:')));
  assert.ok(ssmStatements.length > 0, 'missing SSM GetParameter allow statement');
  for (const statement of ssmStatements) {
    assertSameResources(statement.Resource, [ssmResource('wormage/auth/secret')]);
  }
});

test('Lambda SSM access includes only the scoped GitHub token when issue creation is enabled', () => {
  const statements = allowStatements(template({ githubIssuesEnabled: true, authMode: 'enforce' }));
  assert.deepEqual(serviceActions(statements, 'ssm'), ['ssm:GetParameter']);
  const expected = [ssmResource('wormage/auth/secret'), ssmResource('wormage/github/bug-report-token')];
  const ssmStatements = statements.filter((entry) => actions(entry).some((action) => action.startsWith('ssm:')));
  assert.ok(ssmStatements.length > 0, 'missing SSM GetParameter allow statement');
  assertSameResources(ssmStatements.flatMap((statement) => asArray(statement.Resource)), expected);
});
