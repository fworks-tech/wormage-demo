'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const cdk = require('aws-cdk-lib');
const { Template } = require('aws-cdk-lib/assertions');
const { WormageStack } = require('../dist/lib/wormage-stack');

function template() {
  return Template.fromStack(new WormageStack(new cdk.App(), 'TestStack'));
}

test('telemetry uploads are disabled by default', () => {
  const stack = template();
  const parameters = Object.entries(stack.findResources('AWS::SSM::Parameter'));
  const defaults = Object.fromEntries(parameters.map(([, parameter]) => [parameter.Properties.Name, parameter.Properties.Value]));

  assert.equal(defaults['/wormage/debug-logs/enabled'], 'false');
  assert.equal(defaults['/wormage/bug-reports/enabled'], 'false');

  const handler = Object.values(stack.findResources('AWS::Lambda::Function'))[0];
  const env = handler.Properties.Environment.Variables;
  const logicalId = (name) => parameters.find(([, parameter]) => parameter.Properties.Name === name)[0];
  assert.deepEqual(env.DEBUG_LOGS_ENABLED, { 'Fn::GetAtt': [logicalId('/wormage/debug-logs/enabled'), 'Value'] });
  assert.deepEqual(env.BUG_REPORTS_ENABLED, { 'Fn::GetAtt': [logicalId('/wormage/bug-reports/enabled'), 'Value'] });
});
