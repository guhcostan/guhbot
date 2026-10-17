# AWS site and waitlist

This generic CDK stack is open source and contains no account identifiers or credentials. It deploys a private S3 origin, CloudFront HTTPS, an IAM-protected Lambda origin and a DynamoDB waitlist. CloudFront uses origin access control for both origins. A direct unsigned call to the Lambda URL must return 403.

From the repository root, install and build the product first. Then:

```sh
cd deploy/aws
pnpm install --frozen-lockfile
pnpm synth
# With a valid AWS session, in the account you intend to bill:
pnpm exec cdk bootstrap
pnpm deploy
```

The deployment prints its HTTPS URL and table name. Before announcing it, open the actual URL, submit a signup, verify the persisted DynamoDB item and check duplicate rejection. Verify the raw function URL refuses unsigned requests. A synth is not deployment proof.

The table is retained when the stack is deleted. Back up and manage the collected addresses separately. CloudFront, Lambda, S3 and DynamoDB usage can incur charges. Review the synthesized resources before deployment.

The optional hosted agent gateway is a separate service: use the root Docker image and `compose.yaml` cloud profile on a machine you manage, with persistent volumes and a TLS proxy. This stack does not provision that machine, managed accounts, subscriptions or billing.

On October 17, 2026 the local AWS session was expired and the operator chose to continue locally. No current public AWS URL is claimed by this revision.
