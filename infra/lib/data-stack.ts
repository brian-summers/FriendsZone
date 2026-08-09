import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import type { Construct } from 'constructs';

/**
 * Everything with state, in its own stack with termination protection.
 *
 * The split is not tidiness. A stateless stack gets torn down and rebuilt
 * freely; this one holds the only copy of every user's calendar, so it is
 * deliberately awkward to delete and never shares a deployment with a routine
 * change to the service.
 *
 * See docs/adr/0027-deploy-on-aws.md and docs/playbooks/deploy-on-aws.md.
 */
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly cluster: rds.DatabaseCluster;
  readonly databaseUrl: secretsmanager.ISecret;
  readonly sessionSecret: secretsmanager.ISecret;
  readonly dbSecurityGroup: ec2.SecurityGroup;
  readonly connectorSecurityGroup: ec2.SecurityGroup;
  readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, { ...props, terminationProtection: true });

    /**
     * **No NAT Gateway.** ADR 0027 names it as one of two cost traps (~$32/mo
     * each), and this workload does not need one: photos live in Postgres
     * rather than S3, and the API's only outbound dependency is the database,
     * which is inside the VPC. If a future feature needs egress — SES for
     * email is the likely one — add an interface endpoint for that service
     * rather than a NAT.
     */
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2, // Aurora requires two AZs; a third buys nothing at this size.
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // Isolated, not "private with egress" — that variant implies a NAT.
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    /**
     * Flow logs record IPs, ports and byte counts - network metadata, never
     * request content - so unlike CloudFront access logs there is no tension
     * with the logging rules in docs/security/data-classification.md. Thirty
     * days matches the retention that document already commits to, and at this
     * traffic the volume is a few megabytes a month.
     */
    this.vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'FlowLogGroup', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc,
      description: 'Aurora Serverless v2 - reachable only from the App Runner VPC connector',
      allowAllOutbound: false,
    });

    /**
     * The App Runner connector's security group lives *here*, not with the
     * service that uses it.
     *
     * It is one half of a pair, and the rule that joins them has to be written
     * from one side or the other. Writing it from the service stack mutates a
     * data-stack resource while the service stack already depends on the data
     * stack — a dependency cycle CDK rejects at synth. Both groups and the one
     * rule between them therefore live together, and the service stack only
     * *reads* the connector group.
     */
    this.connectorSecurityGroup = new ec2.SecurityGroup(this, 'ConnectorSg', {
      vpc: this.vpc,
      description: 'App Runner VPC connector',
      allowAllOutbound: false,
    });

    /**
     * Aurora Serverless v2, **0 ACU minimum**.
     *
     * The single most consequential setting on this stack: a minimum of zero
     * means an idle database costs storage only, which is what makes a
     * production deployment affordable before there are users. It is also why
     * the first request after a quiet period is slow — a deliberate trade,
     * documented in the playbook so nobody "fixes" it by raising the floor.
     */
    this.cluster = new rds.DatabaseCluster(this, 'Database', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        /**
         * Pinned to a version this region actually offers.
         *
         * `of()` rather than the `VER_*` enum: the enum ships with aws-cdk-lib
         * and lags what RDS publishes, and the enum entry existing is no
         * guarantee the version exists in your region - 16.6 is in the enum
         * and is not available in us-east-2, which is how this was found.
         * Check with:
         *   aws rds describe-db-engine-versions --engine aurora-postgresql
         */
        version: rds.AuroraPostgresEngineVersion.of('17.10', '17'),
      }),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [this.dbSecurityGroup],
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 2,
      writer: rds.ClusterInstance.serverlessV2('writer', {
        // No public endpoint. The API reaches it over the VPC connector.
        publiclyAccessible: false,
      }),
      defaultDatabaseName: 'friendszone',
      storageEncrypted: true,
      /**
       * Enabled but not yet used. The API still authenticates with the
       * password from Secrets Manager; turning this on costs nothing, changes
       * no current behaviour, and means moving to short-lived IAM auth tokens
       * later is an application change rather than a database migration.
       */
      iamAuthentication: true,
      backup: { retention: Duration.days(7) },
      // A deletion of the only copy of everyone's calendar should require a
      // deliberate act, not a `cdk destroy` that happened to include this stack.
      removalPolicy: RemovalPolicy.RETAIN,
      cloudwatchLogsExports: ['postgresql'],
    });

    /**
     * `SESSION_SECRET`, generated by AWS and never seen by a human.
     *
     * A secret that nobody has read is a secret that cannot be shoulder-surfed,
     * pasted into a chat, or committed. `config.ts` requires ≥32 characters.
     */
    this.sessionSecret = new secretsmanager.Secret(this, 'SessionSecret', {
      description: 'Friendszone SESSION_SECRET',
      generateSecretString: {
        passwordLength: 64,
        // The value is read as an opaque string; punctuation buys nothing and
        // risks quoting problems somewhere in the chain.
        excludePunctuation: true,
      },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /**
     * `DATABASE_URL`, composed from the cluster's own generated secret.
     *
     * The password never appears in the CloudFormation template: it is a
     * `{{resolve:secretsmanager:...}}` dynamic reference that CloudFormation
     * substitutes at deploy time. Host, port, user and database name are not
     * secret and are interpolated directly.
     */
    const dbSecretArn = this.cluster.secret!.secretArn;
    this.databaseUrl = new secretsmanager.Secret(this, 'DatabaseUrl', {
      description: 'Friendszone DATABASE_URL (composed from the cluster secret)',
      secretStringValue: SecretValue.unsafePlainText(
        `postgresql://postgres:{{resolve:secretsmanager:${dbSecretArn}:SecretString:password}}` +
          `@${this.cluster.clusterEndpoint.hostname}:${this.cluster.clusterEndpoint.port}/friendszone` +
          // Aurora rejects unencrypted connections outright: the first deploy
          // failed with `no pg_hba.conf entry for host ... no encryption`.
          // `verify-full` rather than `require` so the CA and the hostname are
          // both checked; the bundle is baked into the image by the Dockerfile.
          `?sslmode=verify-full&sslrootcert=/app/rds-ca.pem`,
      ),
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Exactly one rule, one port, one direction, between two named groups.
    // Aurora's port is a token until deploy time, hence reading it off the
    // cluster rather than hard-coding 5432.
    this.connectorSecurityGroup.addEgressRule(
      this.dbSecurityGroup,
      ec2.Port.tcp(this.cluster.clusterEndpoint.port),
      'Aurora only - the API has no other outbound dependency',
    );
    this.dbSecurityGroup.addIngressRule(
      this.connectorSecurityGroup,
      ec2.Port.tcp(this.cluster.clusterEndpoint.port),
      'App Runner VPC connector',
    );

    /**
     * Secret rotation is deferred, deliberately and with a date on it.
     *
     * Rotating the Aurora credential needs a Lambda inside the VPC, and this
     * VPC has no NAT by design — so it would also need an interface endpoint
     * for Secrets Manager (~$7/mo, more than the database costs at rest).
     * Buying that before the service has users is the wrong order. It is a
     * named pre-GA item in docs/product/road-to-ga.md.
     */
    NagSuppressions.addResourceSuppressions(
      [this.cluster, this.sessionSecret, this.databaseUrl],
      [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'Rotation requires a VPC-attached Lambda and a Secrets Manager interface endpoint, ' +
            'which costs more per month than the database at rest. Tracked as a pre-GA item. ' +
            'DATABASE_URL is additionally derived from the cluster secret, so rotating it ' +
            'independently would only desynchronise the two.',
        },
      ],
      true,
    );

    /**
     * The image registry lives with the persistent resources, not with the
     * service, for an ordering reason: App Runner refuses to create a service
     * whose image does not yet exist. The repository therefore has to survive
     * - and predate - every deploy of the stack that consumes it.
     */
    this.repository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: 'friendszone-api',
      imageScanOnPush: true,
      lifecycleRules: [
        // Untagged layers accumulate on every rebuild and are pure cost.
        { description: 'Expire untagged images', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(1) },
        { description: 'Keep the last 10 builds', maxImageCount: 10 },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'EcrRepositoryUri', { value: this.repository.repositoryUri });
    new CfnOutput(this, 'ClusterEndpoint', { value: this.cluster.clusterEndpoint.hostname });
    new CfnOutput(this, 'DatabaseUrlSecretArn', { value: this.databaseUrl.secretArn });
    new CfnOutput(this, 'SessionSecretArn', { value: this.sessionSecret.secretArn });
  }
}
