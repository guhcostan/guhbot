import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';

/**
 * The public site and the waitlist.
 *
 * Deliberately serverless. The hosted *agent* service is not for sale yet, so
 * the only thing that has to be online is a static page and one function that
 * records an email address. An EC2 instance for that would be a machine to
 * patch, a machine to pay for, and an attack surface with nothing behind it.
 *
 * ## Why there is no domain here
 *
 * CloudFront serves the distribution over HTTPS on its own `*.cloudfront.net`
 * name, which means this stack needs no hosted zone and no certificate to be
 * useful. When a real domain exists, add it with a certificate in `us-east-1`
 * and an alias record; nothing else in this stack changes.
 *
 * ## Layout
 *
 *   /            -> the static site in S3, private bucket behind an OAC
 *   /api/*       -> the waitlist function
 *
 * CloudFront signs requests through an origin access control. The function URL
 * requires AWS IAM authentication, so there is no public origin secret to guess.
 */

export interface SiteStackProps extends StackProps {
  /**
   * Path to the guhbot checkout. The Lambda entrypoint lives in the public
   * repository, because it is product code with tests next to it, and the
   * deployment references it rather than duplicating it.
   */
  readonly guhbotRoot: string;
}

export class GuhbotSiteStack extends Stack {
  constructor(scope: Construct, id: string, props: SiteStackProps) {
    super(scope, id, props);

    const siteDir = resolve(props.guhbotRoot, 'website');
    const lambdaEntry = resolve(
      props.guhbotRoot,
      'apps/cloud/src/lambda/waitlist.ts',
    );

    if (!existsSync(siteDir)) {
      throw new Error(
        `site directory not found at ${siteDir}; set --context guhbotRoot=/path/to/guhbot`,
      );
    }
    if (!existsSync(lambdaEntry)) {
      throw new Error(
        `waitlist entrypoint not found at ${lambdaEntry}; is guhbotRoot correct?`,
      );
    }

    // -- Waitlist storage ----------------------------------------------------
    const table = new dynamodb.Table(this, 'Waitlist', {
      partitionKey: { name: 'email', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // A waitlist is worth keeping if this stack is ever torn down; a real
      // address is the only irreplaceable thing here.
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },
    });

    // -- Waitlist function ---------------------------------------------------

    const waitlist = new NodejsFunction(this, 'WaitlistFn', {
      entry: lambdaEntry,
      // The entrypoint lives in the guhbot checkout, so esbuild has to treat that
      // directory as the project root: it is where the tsconfig and the installed
      // dependencies are. CDK also requires the lock file to sit under the same
      // root, because it uses it to decide the package manager for bundling.
      projectRoot: props.guhbotRoot,
      depsLockFilePath: resolve(props.guhbotRoot, 'pnpm-lock.yaml'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        WAITLIST_TABLE: table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: {
        format: OutputFormat.ESM,
        target: 'node22',
        // Present in the Lambda runtime; bundling a second copy only makes cold
        // starts slower.
        externalModules: ['@aws-sdk/*'],
        minify: false,
        sourceMap: true,
      },
    });
    table.grantWriteData(waitlist);

    const functionUrl = waitlist.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.AWS_IAM,
    });

    // -- Site bucket ---------------------------------------------------------
    const bucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // -- Distribution --------------------------------------------------------
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: 'guhbot site and waitlist',
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
      },
      additionalBehaviors: {
        '/api/*': {
          origin:
            origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          // A waitlist signup must never be served from cache.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          originRequestPolicy:
            cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      errorResponses: [
        // Both codes are needed, and 403 is the one that actually fires: with an
        // origin access control the bucket is private, so S3 answers a missing
        // key with AccessDenied (403) rather than NoSuchKey (404). Mapping only
        // 404 leaves every typo showing a bare CloudFront error page.
        {
          httpStatus: 403,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/404.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    new s3deploy.BucketDeployment(this, 'DeploySite', {
      sources: [
        s3deploy.Source.asset(siteDir, {
          exclude: ['.waitlist*', '**/*.mjs', '.DS_Store'],
        }),
      ],
      destinationBucket: bucket,
      distribution,
      distributionPaths: ['/*'],
      // Small site; invalidating everything is cheaper than being clever.
      prune: true,
    });

    // -- Outputs -------------------------------------------------------------
    new CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Open this. HTTPS works without a custom domain.',
    });
    new CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'For `aws cloudfront create-invalidation`.',
    });
    new CfnOutput(this, 'WaitlistTable', { value: table.tableName });
    new CfnOutput(this, 'WaitlistFunctionUrl', {
      value: functionUrl.url,
      description:
        'Not for direct use. CloudFront is the intended entry point.',
    });
    new CfnOutput(this, 'WaitlistCount', {
      value: `aws dynamodb scan --table-name ${table.tableName} --select COUNT`,
      description: 'How to see how many people signed up.',
    });
  }
}
