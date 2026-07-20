import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Duration, Fn, RemovalPolicy } from 'aws-cdk-lib';
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CachePolicy,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  OriginProtocolPolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { AaaaRecord, ARecord, RecordTarget, type IHostedZone } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, CacheControl, Source } from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';

/**
 * An optional custom domain for a fronted service (the web app here, the API in
 * {@link ApiConstruct}). When present, a DNS-validated ACM certificate + alias
 * records are created in `hostedZone`; when absent, the service keeps its generated
 * AWS domain. `domainName` is guaranteed ⊆ the zone by `parseFreeMailConfig`.
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
 * Strip the `/api` prefix the SPA uses to reach the same-origin API proxy, so the
 * request that reaches the HTTP API origin matches its real route
 * (`/api/auth/login` → `/auth/login`). Pure + exported so the rewrite boundary is
 * unit-tested and then embedded verbatim into the CloudFront Function (deployed ===
 * tested). MUST stay self-contained (no imports/closure) so `.toString()` yields
 * runnable CloudFront JS. A lookalike prefix such as `/apiary` never reaches this
 * (the `/api/*` behavior does not match it), but is left untouched regardless.
 */
export function rewriteApiPath(uri: string): string {
  if (uri === '/api' || uri === '/api/') {
    return '/';
  }
  if (uri.indexOf('/api/') === 0) {
    return uri.substring(4);
  }
  return uri;
}

/**
 * SPA client-routing fallback: a request with no file extension (a client route
 * like `/inbox`, not `/assets/app-abc.js` or `/config.json`) is served `index.html`.
 * This replaces distribution-wide 403/404 custom error responses — those are global
 * and would mask real API 403/404 responses coming back through the `/api/*` proxy
 * (an authorizer deny is a 403; a not-found is a 404). Pure + exported (same embed
 * pattern as {@link rewriteApiPath}); only ever associated with the DEFAULT (S3)
 * behavior, so it never runs on `/api/*`.
 */
export function rewriteSpaPath(uri: string): string {
  return uri.indexOf('.') === -1 ? '/index.html' : uri;
}

function cloudFrontFunctionCode(pure: (uri: string) => string): string {
  return `${pure.toString()}
function handler(event) {
  var request = event.request;
  request.uri = ${pure.name}(request.uri);
  return request;
}`;
}

/**
 * The runtime config object CDK writes to `config.json` at deploy. Pure + exported so
 * the deployed content (deployed === tested) is unit-tested rather than an opaque asset.
 * The SPA reaches the API at the same-origin `/api` proxy path (not a cross-origin URL);
 * `inboundEnabled` gates the whole inbox UI (see {@link WebRuntimeConfig}).
 */
export function webRuntimeConfigJson(inboundEnabled: boolean): {
  apiBaseUrl: string;
  inboundEnabled: boolean;
} {
  return { apiBaseUrl: '/api', inboundEnabled };
}

/**
 * Strict Content-Security-Policy for the SPA document/assets. Locks the app down so a
 * sanitizer miss in the untrusted-email render path is still contained: no cross-origin
 * scripts/connections, `object-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`
 * (clickjacking). `frame-src 'self'` permits the reader's same-URL `srcdoc` iframe, which
 * is ALSO independently locked by its own injected per-email `<meta>` CSP. This is the
 * app layer; the sandbox attributes + DOMPurify + the per-email CSP are the other three
 * independent controls. It cannot be set via a `<meta>` (that can't express
 * `frame-ancestors`), so it rides a CloudFront ResponseHeadersPolicy.
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  // Inline `style=` attributes / a bundled stylesheet — never inline scripts.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  // The reader's srcdoc iframe is same-URL as the app document → 'self'.
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface WebConstructProps {
  /**
   * The HTTP API base URL (e.g. `https://abc123.execute-api.us-east-1.amazonaws.com`).
   * Its host backs the same-origin `/api/*` CloudFront proxy origin. The SPA itself
   * calls the API at the relative same-origin path `/api`, so no cross-origin URL is
   * baked into the bundle.
   */
  readonly apiEndpoint: string;
  /** The SPA asset directory (built dist or placeholder). See {@link resolveWebAssetPath}. */
  readonly assetPath: string;
  /**
   * Whether inbound email is enabled (from `FreeMailConfig.inbound.enabled`). Written
   * into `config.json` so the SPA can gate the inbox UI; sent history always shows.
   */
  readonly inboundEnabled: boolean;
  /**
   * Optional custom domain (from `FreeMailConfig.appDomain`). When set, the SPA is
   * served at this domain via a DNS-validated ACM cert + a CloudFront alias; the SPA
   * stays SAME-ORIGIN because `/api/*` is fronted by this same distribution/domain.
   * Omitted → the generated CloudFront domain (no cert/DNS resources). The ACM cert
   * lives in the stack region (pinned us-east-1), which is what CloudFront requires.
   */
  readonly customDomain?: CustomDomainProps;
}

/**
 * CloudFront + S3 hosting for the React SPA, plus a SAME-ORIGIN API proxy. The
 * private bucket is fronted by a CloudFront distribution via Origin Access Control
 * (no public bucket); a viewer-request CloudFront Function serves `index.html` for
 * client routes.
 *
 * The `/api/*` behavior proxies to the HTTP API origin so the web app is same-origin
 * with the API — required for the httpOnly `SameSite=Strict` session cookies (#31)
 * to be sent at all, and it means there is no CORS. That behavior is never cached
 * (auth responses carry `Set-Cookie`), forwards every viewer header/cookie/query and
 * the body (except `Host`), and strips the `/api` prefix before origin routing. The
 * HTTP API's own authorizer stays the enforcement boundary — the proxy adds no new
 * route surface.
 *
 * The SPA reads a runtime `config.json` (served no-cache, invalidated every deploy)
 * that points it at the relative `/api`; content-hashed `/assets/*` stay long-immutable.
 */
export class WebConstruct extends Construct {
  /** The private origin bucket for the SPA — owned here (not DataConstruct) and disposable; see the constructor. */
  readonly webBucket: Bucket;
  readonly distribution: Distribution;
  /** The configured custom app domain, if any (from `FreeMailConfig.appDomain`). */
  readonly customDomainName?: string;

  constructor(scope: Construct, id: string, props: WebConstructProps) {
    super(scope, id);
    const { apiEndpoint, assetPath, inboundEnabled, customDomain } = props;

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

    // Optional custom domain: a DNS-validated ACM cert (validation records written
    // into the hosted zone). The cert must be in the CloudFront cert region — us-east-1
    // — which the stack is pinned to, so no cross-region cert stack is needed.
    let certificate: ICertificate | undefined;
    if (customDomain) {
      certificate = new Certificate(this, 'Certificate', {
        domainName: customDomain.domainName,
        validation: CertificateValidation.fromDns(customDomain.hostedZone),
      });
      this.customDomainName = customDomain.domainName;
    }

    const spaRewrite = new CloudFrontFunction(this, 'SpaRouting', {
      runtime: FunctionRuntime.JS_2_0,
      comment: 'Serve index.html for SPA client routes (extensionless paths).',
      code: FunctionCode.fromInline(cloudFrontFunctionCode(rewriteSpaPath)),
    });
    const apiRewrite = new CloudFrontFunction(this, 'ApiPathRewrite', {
      runtime: FunctionRuntime.JS_2_0,
      comment: 'Strip the /api prefix before routing to the HTTP API origin.',
      code: FunctionCode.fromInline(cloudFrontFunctionCode(rewriteApiPath)),
    });

    // The API endpoint is `https://<host>` (no trailing slash / stage) — take the host.
    const apiHost = Fn.select(2, Fn.split('/', apiEndpoint));

    // Strict security headers for the SPA document + assets (the default S3 behavior
    // only — NEVER the /api proxy, whose JSON responses need no CSP). This is the app
    // CSP layer of the four independent HTML-render controls; it also sets
    // frame-ancestors 'none' + nosniff + no-referrer + HSTS.
    const securityHeaders = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'FreeMail SPA: strict CSP + security headers.',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: APP_CONTENT_SECURITY_POLICY,
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
      // A configured custom domain aliases the distribution; absent → generated domain.
      ...(customDomain && certificate
        ? { domainNames: [customDomain.domainName], certificate }
        : {}),
      // Cost-conscious default for a single-tenant self-host (North America + Europe edges).
      priceClass: PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.webBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        functionAssociations: [
          { function: spaRewrite, eventType: FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        // Same-origin API proxy: cookies are first-party to the CloudFront domain, so
        // SameSite=Strict works and there is no CORS. Never cached (Set-Cookie); every
        // viewer header/cookie/query + body forwarded to the API (except Host); `/api`
        // stripped before origin routing.
        '/api/*': {
          origin: new HttpOrigin(apiHost, {
            protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
          }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          functionAssociations: [
            { function: apiRewrite, eventType: FunctionEventType.VIEWER_REQUEST },
          ],
        },
      },
    });

    // Point the custom domain at the distribution (A for IPv4, AAAA for IPv6). The
    // domain is ⊆ the zone (enforced by `parseFreeMailConfig`), so it's a plain string
    // (not a token) and CDK's FQDN handling appends the zone correctly.
    if (customDomain) {
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
    }

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
    // deploy so a new build propagates immediately. The SPA is same-origin with the
    // API, so its base URL is the relative `/api` proxy path (not a cross-origin URL).
    new BucketDeployment(this, 'SpaRoot', {
      destinationBucket: this.webBucket,
      sources: [
        Source.asset(assetPath, { exclude: ['assets/**'] }),
        Source.jsonData('config.json', webRuntimeConfigJson(inboundEnabled)),
      ],
      cacheControl: [CacheControl.noCache(), CacheControl.mustRevalidate()],
      prune: false,
      distribution: this.distribution,
      distributionPaths: ['/', '/index.html', '/config.json'],
    });
  }
}
