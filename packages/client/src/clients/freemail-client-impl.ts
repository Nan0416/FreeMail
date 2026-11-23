import { FreeMailEmailNotFoundError } from '../errors/common.js';
import { CREATE_ATTACHMENT_UPLOAD_RESPONSE_SCHEMA, SEND_EMAIL_RESPONSE_SCHEMA, SERVICE_EMAIL_DETAIL_SCHEMA } from '../schemas/service.js';
import type { FetchLike } from '../types/http.js';
import type {
  CreateAttachmentUploadRequest,
  CreateAttachmentUploadResponse,
  FreeMailClient,
  FreeMailRequestOptions,
  GetEmailRequest,
  SendEmailRequest,
  SendEmailResponse,
  ServiceEmailDetail,
  UploadAttachmentRef,
  UploadAttachmentRequest,
} from '../types/service.js';
import { FreeMailRequester } from '../utils/requester.js';

export interface FreeMailClientProps {
  /** The deployment's API origin, `https://<apiDomain>`. */
  readonly baseUrl: string;
  /** An access key from the web app's MCP server page (`fm_...`). */
  readonly apiKey: string;
  /** How long an API call may take, in milliseconds; 30 seconds by default. */
  readonly timeoutMs?: number;
  /** A fetch implementation; the global `fetch` by default. */
  readonly fetch?: FetchLike;
}

export class FreeMailClientImpl implements FreeMailClient {
  private readonly requester: FreeMailRequester;

  constructor(props: FreeMailClientProps) {
    this.requester = new FreeMailRequester(props);
  }

  async sendEmail(request: SendEmailRequest, options?: FreeMailRequestOptions): Promise<SendEmailResponse> {
    return this.requester.post<SendEmailResponse>('/emails', request, SEND_EMAIL_RESPONSE_SCHEMA, {}, options);
  }

  async createAttachmentUpload(request: CreateAttachmentUploadRequest, options?: FreeMailRequestOptions): Promise<CreateAttachmentUploadResponse> {
    return this.requester.post<CreateAttachmentUploadResponse>('/attachments/uploads', request, CREATE_ATTACHMENT_UPLOAD_RESPONSE_SCHEMA, {}, options);
  }

  async uploadAttachment(request: UploadAttachmentRequest, options?: FreeMailRequestOptions): Promise<UploadAttachmentRef> {
    const upload = await this.createAttachmentUpload({ filename: request.filename, contentType: request.contentType, sizeBytes: request.content.byteLength }, options);
    await this.requester.putUpload(upload.uploadUrl, request.content, options);
    return { uploadId: upload.uploadId };
  }

  async getEmail(request: GetEmailRequest, options?: FreeMailRequestOptions): Promise<ServiceEmailDetail> {
    return this.requester.get<ServiceEmailDetail>(`/api/emails/${encodeURIComponent(request.id)}`, SERVICE_EMAIL_DETAIL_SCHEMA, { not_found: FreeMailEmailNotFoundError }, options);
  }
}
