import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export interface WormageStackProps extends cdk.StackProps {
  /** Optional custom domain (api.wormage.flabs.tech). Requires hosted zone + cert ARN. */
  hostedZoneId?: string;
  hostedZoneName?: string;
  certificateArn?: string;
  apiDomainName?: string;
  /** CORS allowlist for the HTTP API. Defaults to production site + localhost dev. */
  corsOrigins?: string[];
  /** Email recipient for SNS alarm notifications. The subscription requires confirmation. */
  alarmEmail?: string;
  /** Anonymous auth rollout mode. Defaults to observe for legacy compatibility. */
  authMode?: 'observe' | 'enforce';
  /** Create public GitHub issues from stored bug reports. Defaults to false. */
  githubIssuesEnabled?: boolean;
  /**
   * HS256 session key stored as an SSM SecureString (Standard tier, free).
   * Required: generate once with `openssl rand -hex 32` and pass via
   * WORMAGE_AUTH_SECRET. Rotating it invalidates all sessions.
   */
  authSecretValue?: string;
  /** Monthly COST budget cap in USD. Defaults to 10. */
  monthlyBudgetLimitUsd?: number;
  /**
   * Reserved concurrency for the handler. Leave unset until the account
   * concurrent-execution quota is raised to 200; then set to 10.
   * See RUNBOOK for the quota request and rollout.
   */
  lambdaReservedConcurrency?: number;
}

export class WormageStack extends cdk.Stack {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly table: dynamodb.Table;
  public readonly handler: lambda.Function;

  constructor(scope: Construct, id: string, props?: WormageStackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('Project', 'wormage');
    cdk.Tags.of(this).add('Environment', 'prod');
    cdk.Tags.of(this).add('ManagedBy', 'CDK');
    cdk.Tags.of(this).add('CostCenter', 'wormage');

    if (props?.githubIssuesEnabled && props.authMode !== 'enforce') {
      throw new Error('githubIssuesEnabled requires authMode=enforce');
    }

    this.table = new dynamodb.Table(this, 'WormageTable', {
      tableName: 'wormage',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
      // Online matches/action logs expire after 30 days via Lambda-stamped
      // `expiresAt` (epoch seconds). Ranking/history items never carry it.
      timeToLiveAttribute: 'expiresAt',
      deletionProtection: true,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: 'LeaderboardIndex',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.table.addGlobalSecondaryIndex({
      indexName: 'PlayerIndex',
      partitionKey: { name: 'playerId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'createdAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const debugLogBucket = new s3.Bucket(this, 'DebugLogBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'expire-debug-logs',
          enabled: true,
          prefix: 'debug-logs/',
          expiration: cdk.Duration.days(7),
        },
        {
          id: 'expire-bug-reports',
          enabled: true,
          prefix: 'bug-reports/',
          expiration: cdk.Duration.days(30),
        },
        {
          id: 'abort-incomplete-multipart',
          enabled: true,
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const debugLogsEnabled = new ssm.StringParameter(this, 'DebugLogsEnabled', {
      parameterName: '/wormage/debug-logs/enabled',
      stringValue: 'false',
    });
    const bugReportsEnabled = new ssm.StringParameter(this, 'BugReportsEnabled', {
      parameterName: '/wormage/bug-reports/enabled',
      stringValue: 'true',
    });
    const githubIssuesEnabled = new ssm.StringParameter(this, 'GithubIssuesEnabled', {
      parameterName: '/wormage/github-issues/enabled',
      stringValue: props?.githubIssuesEnabled ? 'true' : 'false',
    });
    const debugLogsRetentionDays = new ssm.StringParameter(this, 'DebugLogsRetentionDays', {
      parameterName: '/wormage/debug-logs/retention-days',
      stringValue: '7',
    });
    const debugLogsMaxPayloadBytes = new ssm.StringParameter(this, 'DebugLogsMaxPayloadBytes', {
      parameterName: '/wormage/debug-logs/max-payload-bytes',
      stringValue: '256000',
    });
    const debugLogsPrefix = new ssm.StringParameter(this, 'DebugLogsPrefix', {
      parameterName: '/wormage/debug-logs/prefix',
      stringValue: 'debug-logs',
    });
    // Free-tier posture: the session key lives in a Standard SSM SecureString
    // (free, AWS-managed key) published out-of-band via `aws ssm put-parameter`
    // in deploy-infra.yml — never in the CFN template (CDK StringParameter no
    // longer supports SecureString and a secret value must not land in the
    // template history). Fail closed when the value is missing. The value is
    // intentionally unused at synth (existence check only).
    if (!props?.authSecretValue) {
      throw new Error('authSecretValue is required: set WORMAGE_AUTH_SECRET (openssl rand -hex 32)');
    }
    const authSecretParamName = '/wormage/auth/secret';
    const githubTokenParamName = '/wormage/github/bug-report-token';

    this.handler = new lambda.Function(this, 'WormageHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: {
        TABLE_NAME: this.table.tableName,
        DEBUG_LOG_BUCKET: debugLogBucket.bucketName,
        DEBUG_LOGS_ENABLED: debugLogsEnabled.stringValue,
        DEBUG_LOG_RETENTION_DAYS: debugLogsRetentionDays.stringValue,
        DEBUG_LOG_MAX_PAYLOAD_BYTES: debugLogsMaxPayloadBytes.stringValue,
        DEBUG_LOG_PREFIX: debugLogsPrefix.stringValue,
        DEBUG_LOG_ENV: 'prod',
        BUG_REPORTS_ENABLED: bugReportsEnabled.stringValue,
        BUG_REPORT_MAX_BYTES: '4000000',
        BUG_REPORT_PREFIX: 'bug-reports',
        GITHUB_ISSUES_ENABLED: githubIssuesEnabled.stringValue,
        GITHUB_ISSUE_REPO: 'fworks-tech/wormage-demo',
        GITHUB_TOKEN_PARAM: githubTokenParamName,
        AUTH_SECRET_PARAM: authSecretParamName,
        AUTH_MODE: props?.authMode ?? 'observe',
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      // X-Ray tracing bills per trace and no alarm or dashboard reads traces.
      tracing: lambda.Tracing.DISABLED,
      reservedConcurrentExecutions: props?.lambdaReservedConcurrency,
    });

    this.handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:TransactWriteItems'],
      resources: [this.table.tableArn, `${this.table.tableArn}/index/LeaderboardIndex`, `${this.table.tableArn}/index/PlayerIndex`],
    }));
    this.handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'], resources: [debugLogBucket.arnForObjects('debug-logs/*'), debugLogBucket.arnForObjects('bug-reports/*')],
    }));
    this.handler.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:DeleteObject'], resources: [debugLogBucket.arnForObjects('bug-reports/*')] }));
    // The retry-cleanup probe lists by exact key prefix, the documented use
    // for an s3:prefix ListBucket condition; HeadObject would need unscoped
    // ListBucket to return 404 instead of 403 for a missing key.
    this.handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [debugLogBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': ['bug-reports/*'] } },
    }));
    this.handler.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'wormage/auth/secret' })],
    }));
    if (props?.githubIssuesEnabled) {
      this.handler.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'wormage/github/bug-report-token' })],
      }));
    }

    const corsOrigins = props?.corsOrigins && props.corsOrigins.length > 0
      ? props.corsOrigins
      : ['https://wormage.flabs.tech', 'http://localhost:5173'];
    this.httpApi = new apigwv2.HttpApi(this, 'WormageHttpApi', {
      apiName: 'wormage',
      corsPreflight: {
        allowOrigins: corsOrigins,
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ['content-type', 'authorization'],
        maxAge: cdk.Duration.days(1),
      },
    });
    const accessLogGroup = new logs.LogGroup(this, 'HttpApiAccessLogs', {
      logGroupName: '/aws/apigateway/wormage',
      retention: logs.RetentionDays.ONE_MONTH,
    });
    const accessLogFormat = JSON.stringify({
      requestId: '$context.requestId', routeKey: '$context.routeKey', httpMethod: '$context.httpMethod',
      status: '$context.status', responseLatency: '$context.responseLatency', sourceIp: '$context.identity.sourceIp',
      responseLength: '$context.responseLength',
    });

    const integration = new HttpLambdaIntegration('WormageIntegration', this.handler);
    this.httpApi.addRoutes({
      path: '/{proxy+}',
      methods: [
        apigwv2.HttpMethod.GET,
        apigwv2.HttpMethod.POST,
        apigwv2.HttpMethod.PUT,
        apigwv2.HttpMethod.PATCH,
        apigwv2.HttpMethod.DELETE,
      ],
      integration,
    });
    const addRoute = (path: string, methods: apigwv2.HttpMethod[]) =>
      this.httpApi.addRoutes({ path, methods, integration })[0];

    addRoute('/health', [apigwv2.HttpMethod.GET]);
    const authSessionRoute = addRoute('/api/auth/session', [apigwv2.HttpMethod.POST]);
    addRoute('/api/leaderboard', [apigwv2.HttpMethod.GET]);
    addRoute('/api/matches', [apigwv2.HttpMethod.GET]);
    const matchRoute = addRoute('/api/matches', [apigwv2.HttpMethod.POST]);
    const createOnlineRoute = addRoute('/api/matches/online', [apigwv2.HttpMethod.POST]);
    const pollOnlineRoute = addRoute('/api/matches/online/{code}', [apigwv2.HttpMethod.GET]);
    const joinOnlineRoute = addRoute('/api/matches/online/{code}/join', [apigwv2.HttpMethod.POST]);
    const actionOnlineRoute = addRoute('/api/matches/online/{code}/action', [apigwv2.HttpMethod.POST]);
    const forfeitOnlineRoute = addRoute('/api/matches/online/{code}/forfeit', [apigwv2.HttpMethod.POST]);
    const replayRoute = addRoute('/api/matches/online/{code}/replay', [apigwv2.HttpMethod.GET]);
    const debugLogRoute = addRoute('/api/debug-logs', [apigwv2.HttpMethod.POST]);
    const bugReportRoute = addRoute('/api/bug-reports', [apigwv2.HttpMethod.POST]);

    // Route settings reference route keys, so the stage must wait for those routes.
    // NB: routeSettings is an any/passthrough — CloudFormation requires PascalCase
    // here, unlike defaultRouteSettings which converts camelCase automatically.
    // One map drives both routeSettings and stage dependencies so a new entry
    // cannot reintroduce the "Unable to find Route by key" update failure.
    const throttledRoutes = [
      { key: 'POST /api/auth/session', route: authSessionRoute, burst: 5, rate: 2 },
      { key: 'POST /api/debug-logs', route: debugLogRoute, burst: 5, rate: 2 },
      { key: 'POST /api/bug-reports', route: bugReportRoute, burst: 2, rate: 1 },
      { key: 'POST /api/matches', route: matchRoute, burst: 10, rate: 5 },
      { key: 'POST /api/matches/online', route: createOnlineRoute, burst: 10, rate: 5 },
      { key: 'POST /api/matches/online/{code}/join', route: joinOnlineRoute, burst: 10, rate: 5 },
      { key: 'POST /api/matches/online/{code}/action', route: actionOnlineRoute, burst: 10, rate: 5 },
      { key: 'POST /api/matches/online/{code}/forfeit', route: forfeitOnlineRoute, burst: 10, rate: 5 },
      // Costly reads share the default throttle without this: replay runs a full
      // action-log replay (up to 108k ticks) and polling at 1-2s per match adds up.
      { key: 'GET /api/matches/online/{code}', route: pollOnlineRoute, burst: 10, rate: 5 },
      { key: 'GET /api/matches/online/{code}/replay', route: replayRoute, burst: 2, rate: 1 },
    ];
    const cfnStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (cfnStage) {
      cfnStage.accessLogSettings = {
        destinationArn: accessLogGroup.logGroupArn,
        format: accessLogFormat,
      };
      cfnStage.defaultRouteSettings = {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
      };
      cfnStage.routeSettings = Object.fromEntries(
        throttledRoutes.map(({ key, burst, rate }) => [key, { ThrottlingBurstLimit: burst, ThrottlingRateLimit: rate }]),
      );
      for (const { route } of throttledRoutes) {
        cfnStage.addResourceDependency(route.node.defaultChild as apigwv2.CfnRoute);
      }
    }

    // Observability: SNS topic + CloudWatch alarms for the backend.
    const alarmTopic = new sns.Topic(this, 'WormageAlarmTopic', {
      displayName: 'Wormage backend alarms',
    });
    if (props?.alarmEmail) {
      new sns.Subscription(this, 'WormageAlarmEmailSubscription', {
        topic: alarmTopic,
        protocol: sns.SubscriptionProtocol.EMAIL,
        endpoint: props.alarmEmail,
      });
    }

    // Spend guard: USD 10/month COST budget with actual + forecast alerts to
    // the confirmed alarm topic. Reserved concurrency stays off until the
    // account quota supports it (see RUNBOOK).
    const budgetLimit = props?.monthlyBudgetLimitUsd ?? 10;
    new budgets.CfnBudget(this, 'WormageMonthlyBudget', {
      budget: {
        budgetName: 'wormage-monthly',
        budgetLimit: { amount: budgetLimit, unit: 'USD' },
        timeUnit: 'MONTHLY',
        budgetType: 'COST',
      },
      notificationsWithSubscribers: [
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 50, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'SNS', address: alarmTopic.topicArn }] },
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'SNS', address: alarmTopic.topicArn }] },
        { notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'SNS', address: alarmTopic.topicArn }] },
        { notification: { notificationType: 'FORECASTED', comparisonOperator: 'GREATER_THAN', threshold: 100, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'SNS', address: alarmTopic.topicArn }] },
      ],
    });

    const applicationErrorFilter = new logs.MetricFilter(this, 'ApplicationErrorMetricFilter', {
      logGroup: this.handler.logGroup,
      metricNamespace: 'Wormage/Application',
      metricName: 'ApplicationErrors',
      filterPattern: logs.FilterPattern.literal('{ $.level = "error" }'),
      defaultValue: 0,
    });
    new cloudwatch.Alarm(this, 'ApplicationErrorsAlarm', {
      metric: applicationErrorFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Handled application errors',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const bugReportFilter = new logs.MetricFilter(this, 'BugReportMetricFilter', {
      logGroup: this.handler.logGroup,
      metricNamespace: 'Wormage/Application',
      metricName: 'BugReportCount',
      filterPattern: logs.FilterPattern.literal('{ $.type = "bug-report" }'),
      defaultValue: 0,
    });
    new cloudwatch.Alarm(this, 'BugReportVolumeAlarm', {
      metric: bugReportFilter.metric({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
      threshold: 20,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Bug-report volume above 20 per hour',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const lambdaErrors = this.handler.metricErrors({ period: cdk.Duration.minutes(5) });
    new cloudwatch.Alarm(this, 'LambdaErrorsAlarm', {
      metric: lambdaErrors,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Lambda invocation errors',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const lambdaThrottles = this.handler.metricThrottles({ period: cdk.Duration.minutes(5) });
    new cloudwatch.Alarm(this, 'LambdaThrottlesAlarm', {
      metric: lambdaThrottles,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Lambda throttles',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const lambdaDuration = this.handler.metricDuration({ period: cdk.Duration.minutes(5), statistic: 'p99' });
    new cloudwatch.Alarm(this, 'LambdaDurationAlarm', {
      metric: lambdaDuration,
      threshold: 8000,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'Lambda p99 duration above 8s',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const tableThrottles = this.table.metricThrottledRequestsForOperations({
      period: cdk.Duration.minutes(5),
      operations: [
        dynamodb.Operation.GET_ITEM,
        dynamodb.Operation.PUT_ITEM,
        dynamodb.Operation.QUERY,
        dynamodb.Operation.UPDATE_ITEM,
        dynamodb.Operation.TRANSACT_WRITE_ITEMS,
      ],
    });
    new cloudwatch.Alarm(this, 'DynamoThrottlesAlarm', {
      metric: tableThrottles,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'DynamoDB throttled requests',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const api5xx = this.httpApi.metricServerError({ period: cdk.Duration.minutes(5) });
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: api5xx,
      threshold: 2,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'API Gateway 5xx count',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const dashboard = new cloudwatch.Dashboard(this, 'WormageDashboard', {
      dashboardName: 'wormage-backend',
      start: '-PT8H',
      periodOverride: cloudwatch.PeriodOverride.INHERIT,
    });
    dashboard.addWidgets(
      new cloudwatch.TextWidget({ width: 24, height: 1, markdown: '# Wormage backend' }),
      new cloudwatch.GraphWidget({
        width: 12, height: 6, title: 'Lambda requests and errors',
        left: [this.handler.metricInvocations({ period: cdk.Duration.minutes(5), statistic: 'Sum' })],
        right: [lambdaErrors, lambdaThrottles],
      }),
      new cloudwatch.GraphWidget({
        width: 12, height: 6, title: 'API traffic and errors',
        left: [this.httpApi.metricCount({ period: cdk.Duration.minutes(5), statistic: 'Sum' })],
        right: [
          this.httpApi.metricClientError({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
          api5xx,
        ],
      }),
      new cloudwatch.GraphWidget({
        width: 12, height: 6, title: 'Latency p99',
        left: [
          lambdaDuration,
          this.httpApi.metricLatency({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
          this.httpApi.metricIntegrationLatency({ period: cdk.Duration.minutes(5), statistic: 'p99' }),
        ],
      }),
      new cloudwatch.GraphWidget({
        width: 12, height: 6, title: 'DynamoDB capacity and throttles',
        left: [
          this.table.metricConsumedReadCapacityUnits({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
          this.table.metricConsumedWriteCapacityUnits({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        ],
        right: [tableThrottles],
      }),
      new cloudwatch.GraphWidget({
        width: 24, height: 6, title: 'Application signals',
        left: [
          applicationErrorFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
          bugReportFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
        ],
      }),
    );

    // WAF: regional WebACL association is not supported for HTTP APIs (v2) —
    // WAFv2 accepts REST API stage ARNs (/restapis/...). Rate limiting for this
    // HTTP API relies on the default stage throttling (20 burst / 10 rate) until
    // migrated to a REST API or fronted by CloudFront + WAF.
    // shortcut: WAF deferred for HTTP API; revisit if traffic/abuse demands it.

    // Optional custom domain (issue #133). Enabled when a certificate ARN is provided.
    // Route 53 records are only created when a hosted zone is also provided; otherwise
    // the caller adds the DNS record (e.g. a CNAME in Vercel DNS) using the
    // regionalDomainName output below.
    const domainName = props?.apiDomainName ?? 'api.wormage.flabs.tech';
    if (props?.certificateArn) {
      const cert = acm.Certificate.fromCertificateArn(this, 'ApiCert', props.certificateArn);
      const domain = new apigwv2.DomainName(this, 'ApiDomain', {
        domainName,
        certificate: cert,
      });
      new apigwv2.ApiMapping(this, 'ApiMapping', {
        api: this.httpApi,
        domainName: domain,
      });
      new cdk.CfnOutput(this, 'ApiRegionalDomain', {
        value: domain.regionalDomainName,
        description: 'DNS target for the custom domain (CNAME api.wormage.flabs.tech to this value)',
      });
      if (props?.hostedZoneId && props?.hostedZoneName) {
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: props.hostedZoneId,
          zoneName: props.hostedZoneName,
        });
        new route53.ARecord(this, 'ApiAlias', {
          zone: hostedZone,
          recordName: domainName,
          target: route53.RecordTarget.fromAlias(new route53Targets.ApiGatewayv2DomainProperties(domain.regionalDomainName, domain.regionalHostedZoneId)),
        });
      }
    }

    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'Wormage HTTP API endpoint',
    });
    new cdk.CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: 'Wormage DynamoDB table',
    });
    new cdk.CfnOutput(this, 'DebugLogBucketName', {
      value: debugLogBucket.bucketName,
      description: 'Wormage debug log bucket',
    });
    new cdk.CfnOutput(this, 'HttpApiAccessLogGroupName', {
      value: accessLogGroup.logGroupName,
      description: 'CloudWatch log group for HTTP API access logs',
    });
    new cdk.CfnOutput(this, 'DashboardName', {
      value: dashboard.dashboardName,
      description: 'CloudWatch dashboard for backend health',
    });
  }
}
