import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
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
}

export class WormageStack extends cdk.Stack {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly table: dynamodb.Table;
  public readonly handler: lambda.Function;

  constructor(scope: Construct, id: string, props?: WormageStackProps) {
    super(scope, id, props);

    this.table = new dynamodb.Table(this, 'WormageTable', {
      tableName: 'wormage',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecovery: true,
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
          expiration: cdk.Duration.days(7),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const debugLogsEnabled = new ssm.StringParameter(this, 'DebugLogsEnabled', {
      parameterName: '/wormage/debug-logs/enabled',
      stringValue: 'true',
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
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      tracing: lambda.Tracing.ACTIVE,
    });

    this.table.grantReadWriteData(this.handler);
    debugLogBucket.grantWrite(this.handler);


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
    this.httpApi.addRoutes({
      path: '/api/debug-logs',
      methods: [apigwv2.HttpMethod.POST],
      integration,
    });

    // Basic throttle on the default stage to protect POST /api/matches.
    const cfnStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (cfnStage) {
      cfnStage.defaultRouteSettings = {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
      };
      // shortcut: per-route routeSettings caused CloudFormation UPDATE failures
      // ("Unable to find Route by key ...") when the stage update ran before the
      // route resource existed in the same changeset. Revisit per-route throttling
      // via a separate stage update or WAF rate-based rule when traffic demands it.
    }

    // Observability: SNS topic + CloudWatch alarms for the backend.
    const alarmTopic = new sns.Topic(this, 'WormageAlarmTopic', {
      displayName: 'Wormage backend alarms',
    });

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

    const tableThrottles = this.table.metricUserErrors({ period: cdk.Duration.minutes(5) });
    new cloudwatch.Alarm(this, 'DynamoThrottlesAlarm', {
      metric: tableThrottles,
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'DynamoDB user errors (includes throttles)',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

    const api5xx = this.httpApi.metricServerError({ period: cdk.Duration.minutes(5) });
    new cloudwatch.Alarm(this, 'Api5xxAlarm', {
      metric: api5xx,
      threshold: 5,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      alarmDescription: 'API Gateway 5xx count',
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

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
  }
}
