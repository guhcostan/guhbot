#!/usr/bin/env node
/**
 * CDK entry point.
 *
 * The guhbot checkout path is a context value rather than a hardcoded relative
 * path, because the two repositories are independent: this one deploys, that one
 * is the product. Defaults to a sibling directory, which is how they sit on a
 * development machine.
 */
import { App } from 'aws-cdk-lib';
import { GuhbotSiteStack } from './site-stack.js';

const app = new App();

const guhbotRoot =
  (app.node.tryGetContext('guhbotRoot') as string | undefined) ??
  process.env['GUHBOT_ROOT'] ??
  '../..';

new GuhbotSiteStack(app, 'GuhbotSite', {
  guhbotRoot,
  env: {
    account: process.env['CDK_DEFAULT_ACCOUNT'],
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
  },
  description: 'guhbot public site and waitlist',
  // CloudFront needs its certificate and distribution in one place; keeping the
  // stack single-region avoids a cross-region surprise later.
  crossRegionReferences: false,
});

app.synth();
