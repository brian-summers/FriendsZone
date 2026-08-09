import { Annotations, App, Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { DataStack } from '../lib/data-stack.js';
import { ServiceStack } from '../lib/service-stack.js';

/**
 * The Friendszone AWS deployment.
 *
 * Two stacks, split along the one line that matters: **state**. `DataStack`
 * holds the only copy of every user's calendar and carries termination
 * protection; `ServiceStack` is rebuildable from this repository in minutes.
 *
 *   npx cdk deploy --all
 *   npx cdk deploy --all -c publicOrigin=https://dxxxx.cloudfront.net   # pass 2
 *
 * See docs/playbooks/deploy-on-aws.md for the full procedure.
 */

const app = new App();

const account = process.env['CDK_DEFAULT_ACCOUNT'] ?? process.env['AWS_ACCOUNT_ID'];
if (account === undefined) {
  // An unresolved account silently produces an environment-agnostic stack that
  // cannot look up AZs, and fails much later with a confusing error.
  throw new Error('CDK_DEFAULT_ACCOUNT is not set — run through the CDK CLI with credentials.');
}
const env = { account, region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-2' };

/**
 * Placeholder until the distribution exists — see the two-pass note on
 * `ServiceStackProps.publicOrigin`. It is a syntactically valid https URL so
 * `config.ts` boots, and an obviously wrong host so a stale value is loud
 * rather than subtle.
 */
const publicOrigin = app.node.tryGetContext('publicOrigin') ?? 'https://placeholder.invalid';
const imageTag = app.node.tryGetContext('imageTag') ?? 'latest';
const moderatorIds = app.node.tryGetContext('moderatorIds') ?? '';

const data = new DataStack(app, 'FriendszoneData', { env });

const service = new ServiceStack(app, 'FriendszoneService', {
  env,
  vpc: data.vpc,
  cluster: data.cluster,
  connectorSecurityGroup: data.connectorSecurityGroup,
  repository: data.repository,
  databaseUrl: data.databaseUrl,
  sessionSecret: data.sessionSecret,
  publicOrigin,
  imageTag,
  moderatorIds,
});

// Cost attribution, and the answer to "what is this resource for" six months
// from now when the bill arrives.
Tags.of(app).add('project', 'friendszone');
Tags.of(app).add('managed-by', 'cdk');

// cdk-nag runs on every synth rather than in a separate lint step, so a
// finding blocks the deploy that introduced it.
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

/**
 * Cross-stack references are strong, knowingly.
 *
 * `ServiceStack` consumes the VPC, cluster, security group and secrets from
 * `DataStack`. A strong reference means CloudFormation refuses to delete the
 * export while it is in use — which is the behaviour we want for a database
 * the service depends on, and also the setup for a "deadly embrace" if one of
 * those references is ever *removed*.
 *
 * The escape, should that day come, is to weaken before removing:
 * `CrossStackReferences.of(resource).produce(ReferenceStrength.BOTH)`, deploy,
 * then `WEAK`, deploy, then delete. Three deploys, in that order. Removing the
 * reference and the export in one change is what deadlocks.
 */
for (const stack of [data, service]) {
  Annotations.of(stack).acknowledgeWarning('@aws-cdk/core:crossStackReferencesDefaultStrong');
}
