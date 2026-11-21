import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';

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

    this.handler = new lambda.Function(this, 'WormageHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda'),
      environment: {
        TABLE_NAME: this.table.tableName,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
    });

    this.table.grantReadWriteData(this.handler);

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
      methods: [apigwv2.HttpMethod.ANY],
      integration,
    });

    // Basic throttle on the default stage to protect POST /api/matches.
    const cfnStage = this.httpApi.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (cfnStage) {
      cfnStage.defaultRouteSettings = {
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10,
      };
    }

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
  }
}
