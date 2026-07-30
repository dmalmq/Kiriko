import { Type } from "@sinclair/typebox";
import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  FastifySchemaValidationError,
} from "fastify";
import { requireSession } from "../../auth/guard";
import { IssueServiceError, toIssueErrorResponse } from "../errors";
import {
  AttachmentIdSchema,
  AttachmentUploadResponseSchema,
  IssueApiErrorSchema,
  PublicVersionIdSchema,
} from "../schemas";
import { ATTACHMENT_MAX_FILE_BYTES } from "./limits";
import type { IssueAttachmentService } from "./service";

export interface IssueAttachmentRoutesOptions {
  service: IssueAttachmentService;
}

const strict = { additionalProperties: false } as const;
const PublicVersionParamsSchema = Type.Object({ publicVersionId: PublicVersionIdSchema }, strict);
const AttachmentParamsSchema = Type.Object({ attachmentId: AttachmentIdSchema }, strict);
const mediaErrorResponses = {
  400: IssueApiErrorSchema,
  404: IssueApiErrorSchema,
  500: IssueApiErrorSchema,
} as const;

function invalidRequest(reason: string): IssueServiceError {
  return new IssueServiceError("invalid_request", "The request is invalid.", {
    details: [{ field: "body", reason }],
  });
}

interface FastifyValidationFailure {
  validation: FastifySchemaValidationError[];
}

function isFastifyValidationError(error: unknown): error is FastifyValidationFailure {
  return (
    typeof error === "object" &&
    error !== null &&
    "validation" in error &&
    Array.isArray(error.validation)
  );
}

function validationField(error: FastifySchemaValidationError): string {
  const additionalProperty = error.params?.additionalProperty;
  if (typeof additionalProperty === "string") {
    return additionalProperty;
  }
  const missingProperty = error.params?.missingProperty;
  if (typeof missingProperty === "string") {
    return missingProperty;
  }
  const path = error.instancePath?.replace(/^\//, "").replaceAll("/", ".");
  return path && path.length > 0 ? path : "request";
}

function multipartErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return String(error.code);
}

function multipartParserFailure(error: unknown): boolean {
  if (error instanceof Error && error.message === "Multipart: Boundary not found") {
    return true;
  }
  return [
    "FST_PARTS_LIMIT",
    "FST_FILES_LIMIT",
    "FST_FIELDS_LIMIT",
    "FST_REQ_FILE_TOO_LARGE",
    "FST_INVALID_MULTIPART_CONTENT_TYPE",
    "FST_INVALID_JSON_FIELD_ERROR",
    "FST_PROTO_VIOLATION",
  ].includes(multipartErrorCode(error) ?? "");
}

/** Extracts the single `requestId` text field from multipart fields. */
function multipartRequestId(fields: unknown): string {
  const record = fields as Record<string, unknown> | undefined;
  const field = record?.["requestId"];
  const first = Array.isArray(field) ? field[0] : field;
  const value = (first as { value?: unknown } | undefined)?.value;
  if (typeof value !== "string") {
    throw invalidRequest("requestId field is required");
  }
  return value;
}

export const issueAttachmentRoutes: FastifyPluginAsync<IssueAttachmentRoutesOptions> = async (
  app,
  options,
) => {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  // Same sanitized envelope as the issue routes; multipart/parser failures
  // never surface storage paths or decoder internals.
  app.setErrorHandler((error, request, reply) => {
    let mappedError: unknown = error;
    if (isFastifyValidationError(error)) {
      mappedError = new IssueServiceError("invalid_request", "The request is invalid.", {
        details: error.validation.map((entry) => ({
          field: validationField(entry),
          reason: entry.message ?? "is invalid",
        })),
      });
    } else if (multipartErrorCode(error) === "FST_REQ_FILE_TOO_LARGE") {
      mappedError = new IssueServiceError("invalid_attachment", "The image could not be accepted.", {
        details: [{ field: "file", reason: "file is too large" }],
      });
    } else if (multipartParserFailure(error)) {
      mappedError = invalidRequest("body is invalid");
    }
    const mapped = toIssueErrorResponse(mappedError, (cause) => request.log.error(cause));
    return reply.code(mapped.status).send(mapped.body);
  });

  app.post(
    "/api/review/versions/:publicVersionId/issue-attachments",
    {
      preHandler: requireSession,
      schema: {
        params: PublicVersionParamsSchema,
        response: {
          200: AttachmentUploadResponseSchema,
          400: IssueApiErrorSchema,
          401: IssueApiErrorSchema,
          403: IssueApiErrorSchema,
          404: IssueApiErrorSchema,
          409: IssueApiErrorSchema,
          429: IssueApiErrorSchema,
          500: IssueApiErrorSchema,
        },
      },
    },
    async (request) => {
      const { publicVersionId } = request.params as { publicVersionId: string };
      // Route-level limits: the global multipart registration allows 200 MiB
      // GDB sources; attachments are capped far lower.
      const data = await request.file({
        limits: { fileSize: ATTACHMENT_MAX_FILE_BYTES, files: 1, fields: 5 },
      });
      if (data === undefined) {
        throw invalidRequest("an image file is required");
      }
      const bytes = await data.toBuffer();
      if (data.file.truncated) {
        throw new IssueServiceError("invalid_attachment", "The image could not be accepted.", {
          details: [{ field: "file", reason: "file is too large" }],
        });
      }
      const requestId = multipartRequestId(data.fields);
      return options.service.upload(
        request.user,
        publicVersionId,
        requestId,
        typeof data.filename === "string" ? data.filename : null,
        bytes,
      );
    },
  );

  app.delete(
    "/api/issue-attachments/:attachmentId",
    {
      preHandler: requireSession,
      schema: {
        params: AttachmentParamsSchema,
        response: {
          204: Type.Null(),
          401: IssueApiErrorSchema,
          404: IssueApiErrorSchema,
          500: IssueApiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const { attachmentId } = request.params as { attachmentId: string };
      options.service.cancelStaged(request.user, attachmentId);
      return reply.code(204).send(null);
    },
  );

  const mediaHandler = (kind: "content" | "thumbnail") =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { attachmentId } = request.params as { attachmentId: string };
      const media = await options.service.readMedia(attachmentId, kind);
      return reply
        .header("Content-Type", media.contentType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", "inline")
        .header("Cache-Control", "no-store")
        .header("ETag", media.etag)
        .send(media.bytes);
    };

  app.get(
    "/api/issue-attachments/:attachmentId/content",
    { schema: { params: AttachmentParamsSchema, response: mediaErrorResponses } },
    mediaHandler("content"),
  );
  app.get(
    "/api/issue-attachments/:attachmentId/thumbnail",
    { schema: { params: AttachmentParamsSchema, response: mediaErrorResponses } },
    mediaHandler("thumbnail"),
  );
};
