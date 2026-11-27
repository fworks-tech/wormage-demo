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

const asArray = (value) => Array.isArray(value) ? value : [value];
const actions = (statement) => asArray(statement.Action);
const allowStatements = (stack) => Object.values(stack.findResources('AWS::IAM::Policy'))
  .flatMap((policy) => policy.Properties.PolicyDocument.Statement || [])
  .filter((statement) => statement.Effect === 'Allow');
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

  const statement = statements.find((entry) => actions(entry).includes('dynamodb:GetItem'));
  assert.ok(statement, 'missing DynamoDB allow statement');
  assert.deepEqual(actions(statement).slice().sort(), expectedActions);

  const [tableId] = Object.keys(stack.findResources('AWS::DynamoDB::Table'));
  const tableArn = { 'Fn::GetAtt': [tableId, 'Arn'] };
  const indexArn = (name) => ({ 'Fn::Join': ['', [tableArn, `/index/${name}`]] });
  assertSameResources(statement.Resource, [
    tableArn,
    indexArn('LeaderboardIndex'),
    indexArn('PlayerIndex'),
  ]);
});

test('Lambda S3 writes are prefix-scoped and deletes are limited to bug reports', () => {
  const stack = template();
  const statements = allowStatements(stack);
  assert.deepEqual(serviceActions(statements, 's3'), ['s3:DeleteObject', 's3:PutObject']);

  const [bucketId] = Object.keys(stack.findResources('AWS::S3::Bucket'));
  const bucketArn = { 'Fn::GetAtt': [bucketId, 'Arn'] };
  const objectArn = (prefix) => ({ 'Fn::Join': ['', [bucketArn, `/${prefix}`]] });

  const put = statements.find((entry) => actions(entry).includes('s3:PutObject'));
  assert.ok(put, 'missing S3 PutObject allow statement');
  assert.deepEqual(actions(put), ['s3:PutObject']);
  assertSameResources(put.Resource, [
    objectArn('debug-logs/*'),
    objectArn('bug-reports/*'),
  ]);

  const remove = statements.find((entry) => actions(entry).includes('s3:DeleteObject'));
  assert.ok(remove, 'missing S3 DeleteObject allow statement');
  assert.deepEqual(actions(remove), ['s3:DeleteObject']);
  assertSameResources(remove.Resource, [objectArn('bug-reports/*')]);
});

test('Lambda SSM access remains limited to the auth parameter', () => {
  const statements = allowStatements(template());
  assert.deepEqual(serviceActions(statements, 'ssm'), ['ssm:GetParameter']);

  const statement = statements.find((entry) => actions(entry).includes('ssm:GetParameter'));
  assert.ok(statement, 'missing SSM GetParameter allow statement');
  assert.deepEqual(actions(statement), ['ssm:GetParameter']);
  assert.deepEqual(statement.Resource, {
    'Fn::Join': ['', [
      'arn:',
      { Ref: 'AWS::Partition' },
      ':ssm:',
      { Ref: 'AWS::Region' },
      ':',
      { Ref: 'AWS::AccountId' },
      ':parameter/wormage/auth/secret',
    ]],
  });
});
