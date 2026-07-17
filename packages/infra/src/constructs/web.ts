import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Duration,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** The built SPA (`packages/web/dist`) — present after `npm run build`. */
const BUILT_SPA_DIR = join(HERE, '..', '..', '..', 'web', 'dist');
/** A committed empty-shell asset so `cdk synth`/infra tests don't require a prior web build. */
const PLACEHOLDER_DIR = join(HERE, '..', '..', 'assets', 'web-placeholder');

/**
 * Resolve the SPA asset directory: the real `packages/web/dist` when it has been
 * built, else a committed placeholder. This decouples infra synth/tests from the
 * web build (same reason the API construct's handler bundling is self-contained) —
 * a real deploy runs `npm run build` first so `dist` exists.
 */
export function resolveWebAssetPath(): string {
  return existsSync(join(BUILT_SPA_DIR, 'index.html')) ? BUILT_SPA_DIR : PLACEHOLDER_DIR;
}

export interface WebConstructProps {
  /** The private S3 bucket that holds the built SPA (from {@link DataConstruct}). */
  webBucket: s3.Bucket;
  /**
   * The HTTP API base URL. Written to `config.json` at deploy so the SPA learns it
   * at runtime — it is a deploy-time CloudFormation value, unknown at `vite build`.
   */
  apiEndpoint: string;
  /** The SPA asset directory (built dist or placeholder). See {@link resolveWebAssetPath}. */
  assetPath: string;
}

/**
 * CloudFront + S3 hosting for the React SPA. The private bucket is fronted by a
 * CloudFront distribution via Origin Access Control (no public bucket), with an
 * SPA fallback (403/404 → `index.html`).
 *
 * The API endpoint is injected at deploy as `config.json` (not baked into the
 * bundle), so `index.html` and `config.json` are served **no-cache** while the
 * content-hashed `/assets/*` are long-immutable — a redeploy that changes the API
 * endpoint or ships new code can never be masked by a stale cached `config.json`.
 * Each deploy also invalidates those two paths.
 */
export class WebConstruct extends Construct {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebConstructProps) {
    super(scope, id);
    const { webBucket, apiEndpoint, assetPath } = props;

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'FreeMail web app',
      defaultRootObject: 'index.html',
      // Cost-conscious default for a single-tenant self-host (North America + Europe edges).
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      // SPA fallback: a private-bucket miss returns 403 (or 404) → serve index.html.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.minutes(5),
        },
      ],
    });

    // Content-hashed assets: long-lived, immutable. `prune: false` so this deploy
    // never deletes the root files the second deploy owns; orphaned old hashes are
    // harmless (unique filenames, tiny, single-tenant traffic).
    new s3deploy.BucketDeployment(this, 'SpaAssets', {
      destinationBucket: webBucket,
      sources: [s3deploy.Source.asset(assetPath, { exclude: ['index.html'] })],
      cacheControl: [
        s3deploy.CacheControl.setPublic(),
        s3deploy.CacheControl.maxAge(Duration.days(365)),
        s3deploy.CacheControl.immutable(),
      ],
      prune: false,
    });

    // index.html + the deploy-time config.json: no-cache, and invalidated every
    // deploy so a changed API endpoint or new build propagates immediately.
    new s3deploy.BucketDeployment(this, 'SpaRoot', {
      destinationBucket: webBucket,
      sources: [
        s3deploy.Source.asset(assetPath, { exclude: ['assets/**'] }),
        s3deploy.Source.jsonData('config.json', { apiBaseUrl: apiEndpoint }),
      ],
      cacheControl: [s3deploy.CacheControl.noCache(), s3deploy.CacheControl.mustRevalidate()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/', '/index.html', '/config.json'],
    });
  }
}
