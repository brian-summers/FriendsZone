import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as apprunner from 'aws-cdk-lib/aws-apprunner';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import type * as rds from 'aws-cdk-lib/aws-rds';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

export interface ServiceStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly cluster: rds.IDatabaseCluster;
  /** Created in the data stack - see the cycle note there. */
  readonly connectorSecurityGroup: ec2.ISecurityGroup;
  readonly repository: ecr.IRepository;
  readonly databaseUrl: secretsmanager.ISecret;
  readonly sessionSecret: secretsmanager.ISecret;
  /**
   * The origin the browser actually talks to.
   *
   * There is a genuine cycle here: App Runner needs this to set the session
   * cookie's `Secure` flag correctly, and CloudFront needs App Runner's URL as
   * its origin. It is resolved with a **two-pass deploy** rather than a custom
   * resource - pass one uses the placeholder, pass two passes the real
   * distribution domain as `-c publicOrigin=...`. Two passes is honest and
   * greppable; a custom resource that mutates a service's environment is not.
   */
  readonly publicOrigin: string;
  /** Image tag in ECR. Defaults to `latest` for the first deploy. */
  readonly imageTag: string;
  /** Comma-separated user ids allowed into the moderation queue. */
  readonly moderatorIds: string;
}

/**
 * The stateless half: container registry, the API, the client bucket, and the
 * one CloudFront distribution that fronts both.
 *
 * See docs/adr/0027-deploy-on-aws.md.
 */
export class ServiceStack extends Stack {
  readonly distributionDomain: string;

  constructor(scope: Construct, id: string, props: ServiceStackProps) {
    super(scope, id, props);

    // ── App Runner ──────────────────────────────────────────────────
    //
    // L1 (`CfnService`) on purpose: the L2 lives in an alpha module, and an
    // alpha dependency in the thing that deploys production is a poor trade
    // for slightly nicer syntax.

    const vpcConnector = new apprunner.CfnVpcConnector(this, 'VpcConnector', {
      subnets: props.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
      securityGroups: [props.connectorSecurityGroup.securityGroupId],
    });

    /**
     * Lets App Runner pull from ECR. Not the role the container runs as.
     *
     * Written out rather than using `AWSAppRunnerServicePolicyForECRAccess`,
     * which grants its pull actions on `Resource: *` - every repository in the
     * account, forever. This grants them on exactly one repository. Only
     * `GetAuthorizationToken` keeps the wildcard, because it takes no resource.
     */
    const accessRole = new iam.Role(this, 'EcrAccessRole', {
      assumedBy: new iam.ServicePrincipal('build.apprunner.amazonaws.com'),
    });
    accessRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
    );
    props.repository.grantPull(accessRole);

    NagSuppressions.addResourceSuppressions(
      accessRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          appliesTo: ['Resource::*'],
          reason:
            'ecr:GetAuthorizationToken is account-scoped and accepts no resource ARN, so ' +
            '`*` is the only value the action will take. It returns a short-lived registry ' +
            'token and grants no read of any image by itself; the pull actions that do are ' +
            'scoped to this one repository just above.',
        },
      ],
      true,
    );

    /**
     * The role the container itself runs as.
     *
     * Deliberately almost empty. The API reads its secrets through App
     * Runner's own secret injection, which uses the *access* role, so the task
     * needs no standing permission to read them at runtime.
     */
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('tasks.apprunner.amazonaws.com'),
    });
    props.databaseUrl.grantRead(instanceRole);
    props.sessionSecret.grantRead(instanceRole);

    const service = new apprunner.CfnService(this, 'ApiService', {
      serviceName: 'friendszone-api',
      sourceConfiguration: {
        autoDeploymentsEnabled: false, // Deploys are deliberate, not on push.
        authenticationConfiguration: { accessRoleArn: accessRole.roleArn },
        imageRepository: {
          imageIdentifier: `${props.repository.repositoryUri}:${props.imageTag}`,
          imageRepositoryType: 'ECR',
          imageConfiguration: {
            port: '8080',
            runtimeEnvironmentVariables: [
              { name: 'NODE_ENV', value: 'production' },
              { name: 'PORT', value: '8080' },
              { name: 'PUBLIC_ORIGIN', value: props.publicOrigin },
              { name: 'REPORTS_EMAIL', value: 'reports@friends-zone.app' },
              { name: 'RATE_LIMIT_ENABLED', value: 'true' },
              // Exactly one proxy (CloudFront) sits in front. Never `true`,
              // and never higher than the number actually deployed - see
              // ADR 0027: X-Forwarded-For is caller-supplied.
              { name: 'TRUSTED_PROXY_HOPS', value: '1' },
              { name: 'MODERATOR_IDS', value: props.moderatorIds },
            ],
            runtimeEnvironmentSecrets: [
              { name: 'DATABASE_URL', value: props.databaseUrl.secretArn },
              { name: 'SESSION_SECRET', value: props.sessionSecret.secretArn },
            ],
          },
        },
      },
      instanceConfiguration: {
        cpu: '0.25 vCPU',
        memory: '0.5 GB',
        instanceRoleArn: instanceRole.roleArn,
      },
      networkConfiguration: {
        egressConfiguration: {
          // All outbound goes through the VPC. There is no NAT, so the service
          // has no internet route - which is correct: its only dependency is
          // Aurora, and anything else should be an explicit VPC endpoint.
          egressType: 'VPC',
          vpcConnectorArn: vpcConnector.attrVpcConnectorArn,
        },
        ingressConfiguration: { isPubliclyAccessible: true },
      },
      healthCheckConfiguration: {
        // `/readyz`, not `/healthz`. Readiness asks whether the database
        // answers, which is what should gate traffic.
        protocol: 'HTTP',
        path: '/readyz',
        interval: 10,
        timeout: 5,
        healthyThreshold: 1,
        unhealthyThreshold: 5,
      },
    });

    // ── Client bucket ───────────────────────────────────────────────
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // The client is a build artefact - rebuildable from the repo in seconds,
      // so unlike the database it does not need to survive a teardown.
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ── One distribution, two behaviours ────────────────────────────
    const apiOrigin = new origins.HttpOrigin(service.attrServiceUrl, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      readTimeout: Duration.seconds(30),
    });

    /**
     * Strip the `/api` prefix before the request reaches App Runner.
     *
     * The client calls `/api/v1/me`; the API serves `/v1/me`. Something has to
     * remove the prefix, and CloudFront's `originPath` only *prepends*. Without
     * this every API call 404s at the origin.
     */
    const stripApiPrefix = new cloudfront.Function(this, 'StripApiPrefix', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      /**
       * No regex, deliberately. This code lives inside a TypeScript template
       * literal, which swallows the backslash in `\/` - the first version
       * synthesised to `/^/api/`, a syntax error that CloudFront accepted at
       * deploy time and then failed on at request time with a bare 503.
       * `indexOf`/`substring` has nothing for the literal to eat.
       */
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (request.uri.indexOf('/api') === 0) {
    request.uri = request.uri.substring(4);
    if (request.uri === '') { request.uri = '/'; }
  }
  return request;
}`),
    });

    /**
     * Single-page fallback, scoped to the client behaviour only.
     *
     * This used to be a distribution-wide `errorResponses` mapping 403/404 to
     * `/index.html` with status **200**, which was a genuine defect: this API
     * answers *denied* with 404 by design, so every denial came back as an
     * HTML page with a success code. CloudFront custom error responses cannot
     * be scoped to one behaviour - a function can.
     *
     * A path with no file extension is a client route; anything else is an
     * asset and is left alone so a genuinely missing file still 404s.
     */
    const spaFallback = new cloudfront.Function(this, 'SpaFallback', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) { request.uri = uri + 'index.html'; }
  else if (uri.indexOf('.') === -1) { request.uri = '/index.html'; }
  return request;
}`),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Friendszone - client and API on one origin',
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // NA + EU. Cheapest tier.
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: this.securityHeaders(),
        functionAssociations: [
          { function: spaFallback, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          /**
           * **Caching is off, and this is a security control, not a tuning
           * choice.** Every API response is a projection computed for one
           * specific viewer. A CDN that cached one viewer's calendar and
           * served it to another would defeat the entire model in a single
           * response (ADR 0027).
           */
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          /**
           * Everything except **Host**.
           *
           * The session cookie and every viewer header must reach the API or
           * it cannot identify the caller - but App Runner's front proxy
           * routes on `Host`, so forwarding the viewer's `d1xxx.cloudfront.net`
           * made Envoy answer 404 with an empty body before the container was
           * ever consulted. That failure looks exactly like a missing route,
           * which is what cost the time: `Server: envoy` in the response was
           * the only tell.
           */
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            { function: stripApiPrefix, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
    });

    this.distributionDomain = distribution.distributionDomainName;

    /**
     * **CloudFront access logging is deliberately off, and this is a privacy
     * decision rather than a cost one.**
     *
     * An access log records the concrete request URI. This API's URIs carry
     * the subject's identity - `/api/v1/users/<uuid>/calendar` - so the log
     * would be a durable record of who looked at whose calendar and when.
     * docs/security/data-classification.md is explicit that what may be logged
     * is the *route pattern*, `/v1/users/:ownerId/calendar`, never the
     * concrete id. Enabling this control would breach the rule it appears to
     * support. The application's own structured logs already record the
     * pattern, the request id and the `DenyReason`.
     */
    NagSuppressions.addResourceSuppressions(
      distribution,
      [
        {
          id: 'AwsSolutions-CFR3',
          reason:
            'Access logs would record concrete request URIs containing user ids, which ' +
            'docs/security/data-classification.md forbids. The application logs route ' +
            'patterns instead.',
        },
        {
          id: 'AwsSolutions-CFR1',
          reason:
            'Geo restriction is not applicable: the product coordinates plans between ' +
            'friends who may be anywhere, and blocking a country would deny service to ' +
            'users rather than protect them.',
        },
        {
          id: 'AwsSolutions-CFR4',
          reason:
            'Not settable. The distribution uses the default *.cloudfront.net certificate, ' +
            'and CloudFront pins the minimum protocol version for that certificate - ' +
            '`minimumProtocolVersion` only takes effect with a custom ACM certificate. ' +
            'Registering a domain and issuing a certificate is the fix, and is a pre-GA item.',
        },
        {
          id: 'AwsSolutions-CFR2',
          reason:
            'WAF is a named pre-GA item, not an omission. Every route already declares a ' +
            'token-bucket rate-limit class (ADR 0020) and the origin is a container that ' +
            'scales to one instance, so the marginal protection does not yet justify the ' +
            'monthly floor. Revisit before public launch.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      siteBucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason:
            'The bucket is reachable only through CloudFront Origin Access Control - it has ' +
            'no public policy and no other principal - so a server access log would record ' +
            'nothing that is not already an edge request.',
        },
      ],
      true,
    );

    new CfnOutput(this, 'DistributionDomain', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'ApiServiceUrl', { value: `https://${service.attrServiceUrl}` });
    new CfnOutput(this, 'SiteBucketName', { value: siteBucket.bucketName });
  }

  /**
   * Security headers applied at the edge.
   *
   * HSTS in particular has to be set here rather than by the API: it must
   * cover the static client too, and the client is served by S3, which cannot
   * add it.
   */
  private securityHeaders(): cloudfront.ResponseHeadersPolicy {
    return new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.SAME_ORIGIN,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });
  }
}
