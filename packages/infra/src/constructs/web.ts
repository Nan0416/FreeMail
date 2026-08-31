import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AaaaRecord, ARecord, RecordTarget, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

/**
 * The custom domain for a fronted service (the web app here, the API in
 * {@link ApiConstruct}). A DNS-validated ACM certificate + alias records are created in
 * `hostedZone`. Both domains are REQUIRED as of #47 — there is no generated-AWS-domain
 * fallback. `domainName` is guaranteed ⊆ the zone by `parseFreeMailConfig`.
 */
export interface CustomDomainProps {
  readonly domainName: string;
  readonly hostedZone: IHostedZone;
}

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

/**
 * The runtime config object CDK writes to `config.json` at deploy. Pure + exported so
 * the deployed content (deployed === tested) is unit-tested rather than an opaque asset.
 *
 * As of #47 `apiBaseUrl` is the ABSOLUTE api origin (the SPA calls it cross-origin), not
 * the former same-origin `/api` proxy path. Asserted https here — this is the only path
 * that produces a deployed value, so the assertion belongs here rather than in the shared
 * parser, which also handles the `http://localhost` dev fallback.
 * `inboundEnabled` gates the whole inbox UI (see {@link WebRuntimeConfig}).
 */
export function webRuntimeConfigJson(
  apiBaseUrl: string,
  inboundEnabled: boolean,
): {
  apiBaseUrl: string;
  inboundEnabled: boolean;
} {
  if (!apiBaseUrl.startsWith('https://')) {
    throw new Error(`WebConstruct: apiBaseUrl must be an https:// URL (got "${apiBaseUrl}").`);
  }
  return { apiBaseUrl, inboundEnabled };
}

/**
 * Strict Content-Security-Policy for the SPA document/assets. Locks the app down so a
 * sanitizer miss in the untrusted-email render path is still contained: no unexpected
 * cross-origin scripts/connections, `object-src 'none'`, `base-uri 'none'`, and
 * `frame-ancestors 'none'` (clickjacking). `frame-src 'self'` permits the reader's
 * same-URL `srcdoc` iframe, which is ALSO independently locked by its own injected
 * per-email `<meta>` CSP. This is the app layer; the sandbox attributes + DOMPurify +
 * the per-email CSP are the other three independent controls. It cannot be set via a
 * `<meta>` (that can't express `frame-ancestors`), so it rides a CloudFront
 * ResponseHeadersPolicy.
 *
 * Parametrized by the API origin as of #47: the SPA now calls the API CROSS-ORIGIN, so
 * `connect-src` must name it explicitly. `'self'` alone would have the app CSP block
 * every API call even though the API's CORS policy allows it — CSP and CORS are
 * independent gates and both must permit the request. Exactly one extra origin is
 * added; the reader's per-email CSP is untouched (`connect-src 'none'` there).
 */
export function appContentSecurityPolicy(apiOrigin: string): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Inline `style=` attributes / a bundled stylesheet — never inline scripts.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    // The reader's srcdoc iframe is same-URL as the app document → 'self'.
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface WebConstructProps {
  /**
   * Absolute origin of the API (`https://<apiDomain>`), written into `config.json` for
   * the SPA to call CROSS-ORIGIN and named in the app CSP's `connect-src` (#47). Must be
   * https — asserted by {@link webRuntimeConfigJson}.
   */
  readonly apiBaseUrl: string;
  /** The SPA asset directory (built dist or placeholder). See {@link resolveWebAssetPath}. */
  readonly assetPath: string;
  /**
   * Whether inbound email is enabled (from `FreeMailConfig.inbound.enabled`). Written
   * into `config.json` so the SPA can gate the inbox UI; sent history always shows.
   */
  readonly inboundEnabled: boolean;
  /**
   * The app's custom domain (from `FreeMailConfig.appDomain`). REQUIRED as of #47 — the
   * SPA is served here via a DNS-validated ACM cert + a CloudFront alias, and this host
   * is the single origin the API's credentialed CORS allowlist names, so there is no
   * generated-domain fallback. The ACM cert lives in the stack region (pinned
   * us-east-1), which is what CloudFront requires.
   */
  readonly customDomain: CustomDomainProps;
}

/**
 * CloudFront + S3 hosting for the React SPA — SPA ONLY as of #47. The private bucket is
 * fronted by a CloudFront distribution via Origin Access Control (no public bucket).
 *
 * The `/api/*` proxy behavior is GONE, along with both CloudFront Functions. It existed
 * to make the SPA same-origin with the API so the `SameSite=Strict` session cookies
 * would ride (#31) — chiefly to support a zero-DNS generated-domain deploy, which
 * FreeMail does not have (SES needs a verified domain + delegated zone regardless). The
 * browser now calls the API cross-origin at `apiBaseUrl` under a locked, exact-origin
 * credentialed CORS policy plus a content-type gate in the handlers.
 *
 * With no API behind this distribution, SPA client routing reverts to distribution-wide
 * `403/404 → /index.html` error responses. That was previously unsafe — it would have
 * masked real API 403s (an authorizer deny) and 404s coming back through the proxy — and
 * is safe again now that only S3 is behind it.
 *
 * The SPA reads a runtime `config.json` (served no-cache, invalidated every deploy) that
 * points it at the absolute api origin; content-hashed `/assets/*` stay long-immutable.
 */
export class WebConstruct extends Construct {
  /** The private origin bucket for the SPA — owned here (not DataConstruct) and disposable; see the constructor. */
  readonly webBucket: Bucket;
  readonly distribution: Distribution;
  /** The app's custom domain (from `FreeMailConfig.appDomain`) — always set as of #47. */
  readonly customDomainName: string;

  constructor(scope: Construct, id: string, props: WebConstructProps) {
    super(scope, id);
    const { apiBaseUrl, assetPath, inboundEnabled, customDomain } = props;

    // This construct OWNS the SPA's private origin bucket. Unlike the mail bucket
    // (real email → RETAIN), the web bucket holds only the redeployable SPA build,
    // so it is DESTROY + auto-emptied: a `cdk destroy` removes it cleanly
    // (CloudFormation cannot delete a non-empty bucket without autoDeleteObjects).
    this.webBucket = new Bucket(this, 'WebBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // The custom domain is required (#47): a DNS-validated ACM cert (validation records
    // written into the hosted zone). The cert must be in the CloudFront cert region —
    // us-east-1 — which the stack is pinned to, so no cross-region cert stack is needed.
    const certificate = new Certificate(this, 'Certificate', {
      domainName: customDomain.domainName,
      validation: CertificateValidation.fromDns(customDomain.hostedZone),
    });
    this.customDomainName = customDomain.domainName;

    // Strict security headers for the SPA document + assets. This is the app CSP layer
    // of the four independent HTML-render controls; it also sets frame-ancestors 'none'
    // + nosniff + no-referrer + HSTS. `connect-src` names the api origin so the app CSP
    // permits the cross-origin API calls that CORS separately authorizes (#47).
    const securityHeaders = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'FreeMail SPA: strict CSP + security headers.',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: appContentSecurityPolicy(apiBaseUrl),
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.NO_REFERRER,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
      },
    });

    this.distribution = new Distribution(this, 'Distribution', {
      comment: 'FreeMail web app',
      defaultRootObject: 'index.html',
      domainNames: [customDomain.domainName],
      certificate,
      // SPA client routing (#47): with no API behind this distribution, a distribution-wide
      // fallback is safe again — S3 answers 403 (OAC, object absent) or 404, and both mean
      // "not a file, so it's a client route". This replaces the viewer-request Function
      // that existed only to avoid masking real API 403/404s through the removed proxy.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
      // Cost-conscious default for a single-tenant self-host (North America + Europe edges).
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.webBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
      },
    });

    // Point the custom domain at the distribution (A for IPv4, AAAA for IPv6). The
    // domain is ⊆ the zone (enforced by `parseFreeMailConfig`), so it's a plain string
    // (not a token) and CDK's FQDN handling appends the zone correctly.
    const aliasTarget = RecordTarget.fromAlias(new CloudFrontTarget(this.distribution));
    new ARecord(this, 'AliasRecord', {
      zone: customDomain.hostedZone,
      recordName: customDomain.domainName,
      target: aliasTarget,
    });
    new AaaaRecord(this, 'AliasRecordAaaa', {
      zone: customDomain.hostedZone,
      recordName: customDomain.domainName,
      target: aliasTarget,
    });

    // Content-hashed assets: long-lived, immutable. `prune: false` so this deploy
    // never deletes the root files the second deploy owns; orphaned old hashes are
    // harmless (unique filenames, tiny, single-tenant traffic).
    new BucketDeployment(this, 'SpaAssets', {
      destinationBucket: this.webBucket,
      sources: [Source.asset(assetPath, { exclude: ['index.html'] })],
      cacheControl: [
        CacheControl.setPublic(),
        CacheControl.maxAge(Duration.days(365)),
        CacheControl.immutable(),
      ],
      prune: false,
    });

    // index.html + the deploy-time config.json: no-cache, and invalidated every
    // deploy so a new build propagates immediately. The SPA calls the API cross-origin
    // (#47), so config.json carries the absolute api origin.
    new BucketDeployment(this, 'SpaRoot', {
      destinationBucket: this.webBucket,
      sources: [
        Source.asset(assetPath, { exclude: ['assets/**'] }),
        Source.jsonData('config.json', webRuntimeConfigJson(apiBaseUrl, inboundEnabled)),
      ],
      cacheControl: [CacheControl.noCache(), CacheControl.mustRevalidate()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/', '/index.html', '/config.json'],
    });
  }
}
